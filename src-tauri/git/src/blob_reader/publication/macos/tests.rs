use super::*;
use crate::blob_reader::test_repo::with_three_revs;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};

#[test]
fn a_writer_with_the_old_file_open_changes_the_recoverable_original() {
    let (root, repo, _) = with_three_revs();
    let path = root.path().join("doc.md");
    let mut writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
    let edit = WorkingTreeEdit::open(&repo, "doc.md").unwrap();

    edit.replace(&repo, b"resolved").unwrap();
    writer.set_len(0).unwrap();
    writer.write_all(b"later external edit").unwrap();

    assert_eq!(fs::read(path).unwrap(), b"resolved");
    let recovery = fs::read_dir(repo.path().join(recovery_name()))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(fs::read(recovery.join("path")).unwrap(), b"doc.md");
    assert_eq!(
        fs::read(recovery.join("original")).unwrap(),
        b"later external edit"
    );
}

#[test]
fn a_replacement_before_rollback_stays_in_the_worktree() {
    check_replacement_during_rollback(false);
}

#[test]
fn a_replacement_during_the_first_rollback_exchange_returns_to_the_worktree() {
    check_replacement_during_rollback(true);
}

fn check_replacement_during_rollback(replace_inside_exchange: bool) {
    let (root, repo, _) = with_three_revs();
    let edit = WorkingTreeEdit::open(&repo, "doc.md").unwrap();
    let original = edit.bytes.clone();
    let path = root.path().join("doc.md");
    let git = Dir::open_ambient_dir(repo.path(), cap_std::ambient_authority()).unwrap();
    let store = recovery_root(&git).unwrap();
    let (id, entry) = create_entry(&store).unwrap();
    let backup = repo.path().join(recovery_name()).join(id).join("original");
    let resolution = new_file(&entry, "original").unwrap().into_std();
    renameat_with(
        &edit.directory,
        "doc.md",
        &entry,
        "original",
        RenameFlags::EXCHANGE,
    )
    .unwrap();
    // The later editor installed a different inode at the working pathname.
    fs::write(root.path().join("incoming"), b"a competing replacement").unwrap();
    let mut contender = Some(root.path().join("incoming"));
    if !replace_inside_exchange {
        fs::rename(contender.take().unwrap(), &path).unwrap();
    }

    let error = edit
        .undo_exchange(
            entry,
            &resolution,
            &backup,
            WorkingTreeEdit::changed(),
            |entry, dir, name| {
                if let Some(file) = contender.take() {
                    fs::rename(file, &path)?;
                }
                exchange_original(entry, dir, name)
            },
        )
        .unwrap_err();

    assert_eq!(error.code, "conflict_changed");
    assert!(error.message.contains(backup.to_str().unwrap()));
    assert_eq!(fs::read(path).unwrap(), b"a competing replacement");
    assert_eq!(fs::read(backup).unwrap(), original);
}

#[test]
fn a_directory_moved_during_exchange_keeps_its_original_and_the_new_path_is_untouched() {
    let (root, repo, _) = with_three_revs();
    let dir = root.path().join("source");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("code"), b"original").unwrap();
    let edit = WorkingTreeEdit::open(&repo, "source/code").unwrap();
    let error = edit
        .publish_with_exchange(&repo, b"my resolution", |entry, directory, name| {
            renameat_with(entry, "original", directory, name, RenameFlags::EXCHANGE)?;
            fs::rename(&dir, root.path().join("archive"))?;
            fs::create_dir(&dir)?;
            fs::write(dir.join("code"), b"different file")
        })
        .unwrap_err();

    assert_eq!(error.code, "conflict_changed");
    assert_eq!(fs::read(dir.join("code")).unwrap(), b"different file");
    assert_eq!(
        fs::read(root.path().join("archive/code")).unwrap(),
        b"original"
    );
    let folder = fs::read_dir(repo.path().join(recovery_name()))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        fs::read(folder.join("withdrawn")).unwrap(),
        b"my resolution"
    );
}

#[test]
fn a_metadata_change_during_publication_restores_the_original_file_and_its_new_tag() {
    use xattr::FileExt;
    let (root, repo, _) = with_three_revs();
    let path = root.path().join("doc.md");
    let original = fs::read(&path).unwrap();
    let writer = fs::File::open(&path).unwrap();
    let edit = WorkingTreeEdit::open(&repo, "doc.md").unwrap();
    let tag = "com.apple.metadata:_kMDItemUserTags";

    let error = edit
        .publish_with_exchange(&repo, b"resolution", |entry, directory, name| {
            writer.set_xattr(tag, b"new tag")?;
            renameat_with(entry, "original", directory, name, RenameFlags::EXCHANGE)
                .map_err(Into::into)
        })
        .unwrap_err();

    assert_eq!(error.code, "conflict_changed");
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(
        fs::File::open(path)
            .unwrap()
            .get_xattr(tag)
            .unwrap()
            .unwrap(),
        b"new tag"
    );
}

#[test]
fn each_replacement_keeps_its_own_original_and_an_identical_retry_keeps_no_extra_copy() {
    let (root, repo, _) = with_three_revs();
    let path = root.path().join("doc.md");
    let first = fs::read(&path).unwrap();
    let second = b"first resolution".to_vec();
    for content in [second.as_slice(), b"new resolution", b"new resolution"] {
        WorkingTreeEdit::open(&repo, "doc.md")
            .unwrap()
            .replace(&repo, content)
            .unwrap();
    }

    let store = repo.path().join(recovery_name());
    let protected_mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(protected_mode(&store), 0o700);
    let mut originals: Vec<_> = fs::read_dir(store)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap().path();
            assert_eq!(protected_mode(&entry), 0o700);
            fs::read(entry.join("original")).unwrap()
        })
        .collect();
    originals.sort();
    let mut expected = [first, second];
    expected.sort();
    assert_eq!(originals, expected);
    assert_eq!(fs::read(path).unwrap(), b"new resolution");
}

#[test]
fn a_linked_or_public_recovery_directory_leaves_the_working_file_untouched() {
    let (root, repo, _) = with_three_revs();
    let original = fs::read(root.path().join("doc.md")).unwrap();
    let destination = tempfile::tempdir().unwrap();
    let store = repo.path().join(recovery_name());
    let attempt = || {
        WorkingTreeEdit::open(&repo, "doc.md")
            .unwrap()
            .replace(&repo, b"new")
    };
    symlink(destination.path(), &store).unwrap();
    assert!(attempt().is_err());
    assert!(fs::read_dir(destination.path()).unwrap().next().is_none());
    fs::remove_file(&store).unwrap();

    fs::create_dir(&store).unwrap();
    fs::set_permissions(&store, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(attempt().is_err());
    assert!(fs::read_dir(&store).unwrap().next().is_none());
    assert_eq!(fs::read(root.path().join("doc.md")).unwrap(), original);
}

#[test]
fn a_published_resolution_keeps_inherited_deny_entries() {
    use std::process::Command;
    let (root, repo, _) = with_three_revs();
    let directory = root.path().join("restricted");
    fs::create_dir(&directory).unwrap();
    assert!(
        Command::new("/bin/chmod")
            .args(["+a", "everyone deny execute,file_inherit,only_inherit"])
            .arg(&directory)
            .status()
            .unwrap()
            .success()
    );
    let path = directory.join("code");
    fs::write(&path, b"original").unwrap();
    let acl = || {
        let output = Command::new("/bin/ls")
            .arg("-lde")
            .arg(&path)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .skip(1)
            .collect::<String>()
    };
    let before = acl();
    assert!(before.contains("inherited deny execute"), "{before}");
    WorkingTreeEdit::open(&repo, "restricted/code")
        .unwrap()
        .replace(&repo, b"resolution")
        .unwrap();
    assert_eq!(acl(), before);
}

#[test]
fn changing_finder_tags_or_the_tail_of_a_resource_fork_invalidates_prepared_metadata() {
    use xattr::FileExt;
    let source = tempfile::tempfile().unwrap();
    let target = tempfile::tempfile().unwrap();
    let mut fork = vec![b'x'; 64 * 1024];
    let tag = "com.apple.metadata:_kMDItemUserTags";
    for file in [&source, &target] {
        file.set_xattr(tag, b"original tag").unwrap();
        file.set_xattr("com.apple.ResourceFork", &fork).unwrap();
    }

    assert!(FileAttributes::capture(&source).unwrap() == FileAttributes::capture(&target).unwrap());
    source.set_xattr(tag, b"later tag").unwrap();
    assert!(FileAttributes::capture(&source).unwrap() != FileAttributes::capture(&target).unwrap());
    target.set_xattr(tag, b"later tag").unwrap();
    assert!(FileAttributes::capture(&source).unwrap() == FileAttributes::capture(&target).unwrap());
    *fork.last_mut().unwrap() = b'y';
    source.set_xattr("com.apple.ResourceFork", &fork).unwrap();
    assert!(FileAttributes::capture(&source).unwrap() != FileAttributes::capture(&target).unwrap());
}

#[test]
fn the_resolution_stays_private_while_a_new_restriction_is_being_validated() {
    use std::process::Command;
    let (root, repo, _) = with_three_revs();
    let path = root.path().join("doc.md");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        Command::new("/bin/chmod")
            .args(["+a", "user:nobody allow read"])
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let acl_entries = || -> io::Result<String> {
        let output = Command::new("/bin/ls").arg("-lde").arg(&path).output()?;
        assert!(output.status.success());
        Ok(String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .skip(1)
            .collect())
    };
    let original = fs::read(&path).unwrap();
    let edit = WorkingTreeEdit::open(&repo, "doc.md").unwrap();
    let mut visible_access = None;
    let error = edit
        .publish_with_exchange(&repo, b"resolution", |entry, directory, name| {
            assert!(
                Command::new("/bin/chmod")
                    .args(["=a#", "0", "user:nobody deny read"])
                    .arg(&path)
                    .status()?
                    .success()
            );
            renameat_with(entry, "original", directory, name, RenameFlags::EXCHANGE)?;
            visible_access = Some((
                fs::metadata(&path)?.permissions().mode() & 0o777,
                acl_entries()?,
            ));
            Ok(())
        })
        .unwrap_err();
    assert_eq!(visible_access, Some((0o000, String::new())));
    assert_eq!(error.code, "conflict_changed");
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(acl_entries().unwrap().contains("deny read"));
}
