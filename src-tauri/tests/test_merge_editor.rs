mod common;

use common::context::TestContext;
use trunk_git::conflicted_file::MergeRegion;
use trunk_lib::commands::merge_editor::{MergeBaseSelection, MergeBaseView, get_merge_base_inner};

fn lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_owned).collect()
}

fn conflicted_file_txt() -> TestContext {
    TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build()
}

#[test]
fn merge_sides_highlight_the_displayed_code_and_the_changed_shortcut() {
    let path = "shortcuts.ts";
    let ctx = TestContext::builder()
        .with_file(path, "const shortcut = 'Ctrl+A';")
        .with_commit("base")
        .with_branch("feature")
        .checkout("feature")
        .with_file(path, "const shortcut = 'Ctrl+K';")
        .with_commit("feature")
        .checkout("main")
        .with_file(path, "const shortcut = 'Ctrl+F';")
        .with_commit("main")
        .with_conflict("feature")
        .build();
    // A user edited both marker sections, including an extra line only on
    // Current. Span positions must follow that working text.
    let current = "const shortcut = '🌍 Ctrl+O';";
    let incoming = "const shortcut = '🌍 Ctrl+K';";
    let working =
        format!("<<<<<<< HEAD\n// local edit\n{current}\n=======\n{incoming}\n>>>>>>> feature\n");
    std::fs::write(ctx.repo_path().join(path), &working).unwrap();

    let sides = ctx.get_merge_sides(path).unwrap();
    assert_eq!(sides.presentation.conflict_partners[&0], [None, Some(0)]);
    for (line, spans, changed) in [
        (current, &sides.presentation.ours_spans[&2], "O"),
        (incoming, &sides.presentation.theirs_spans[&1], "K"),
    ] {
        let units: Vec<_> = line.encode_utf16().collect();
        let text = |span: &trunk_lib::types::MergedSpan| {
            String::from_utf16(&units[span.start as usize..span.end as usize]).unwrap()
        };
        let emphasis: String = spans.iter().filter(|s| s.emphasized).map(text).collect();
        assert_eq!(emphasis, changed);
        assert!(
            spans
                .iter()
                .any(|s| s.emphasized && s.syntax_class == "syn-string")
        );
        assert!(spans.iter().any(|s| s.syntax_class == "syn-keyword"));
        assert_eq!(spans.iter().map(text).collect::<String>(), line);
    }
    assert!(
        sides.presentation.ours_spans[&1]
            .iter()
            .any(|s| s.syntax_class == "syn-comment")
    );
    assert_eq!(
        std::fs::read_to_string(ctx.repo_path().join(path)).unwrap(),
        working
    );
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn sidebar_resolution_reads_the_same_conflict_without_editor_presentation() {
    let ctx = conflicted_file_txt();
    let path = "file.txt";
    let sides = ctx.get_merge_sides(path).unwrap();
    let resolution = trunk_lib::commands::merge_editor::get_merge_sides_inner(
        ctx.path(),
        path,
        trunk_lib::commands::merge_editor::MergeReadPurpose::Resolution,
        ctx.state_map(),
    )
    .unwrap();
    assert_eq!(resolution.regions, sides.regions);
    assert_eq!(resolution.revision, sides.revision);
    assert!(resolution.presentation.ours_spans.is_empty());
    assert!(resolution.presentation.theirs_spans.is_empty());
    assert!(resolution.presentation.conflict_partners.is_empty());
}

#[test]
fn indexed_ancestor_shows_only_a_verified_diff3_block() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "start\nancestor\nelsewhere\n")
        .with_commit("base")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "start\nfeature\nelsewhere\n")
        .with_commit("theirs")
        .checkout("main")
        .with_file("file.txt", "start\nmain\nelsewhere\n")
        .with_commit("ours")
        .with_conflict("feature")
        .build();
    let sides = ctx.get_merge_sides("file.txt").unwrap();
    let oid = sides.base_oid.unwrap();
    let selection = MergeBaseSelection {
        ordinal: 0,
        ours: lines("main"),
        theirs: lines("feature"),
    };
    let read = || {
        get_merge_base_inner(
            ctx.path(),
            "file.txt",
            &oid,
            Some(&selection),
            ctx.state_map(),
        )
        .unwrap()
    };
    let file = ctx.repo_path().join("file.txt");
    std::fs::write(
        &file,
        "start\n<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\nelsewhere\n",
    )
    .unwrap();
    assert!(matches!(read(), MergeBaseView::File(text) if text == "start\nancestor\nelsewhere\n"));
    let diff3 = "start\n<<<<<<< HEAD\nmain\n||||||| base\nancestor\n=======\nfeature\n>>>>>>> feature\nelsewhere\n";
    std::fs::write(&file, diff3).unwrap();
    assert!(matches!(read(), MergeBaseView::Conflict(text) if text == "ancestor"));
    std::fs::write(&file, diff3.replace("ancestor", "elsewhere")).unwrap();
    assert!(matches!(read(), MergeBaseView::File(text) if text == "start\nancestor\nelsewhere\n"));
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn an_index_lock_keeps_the_working_copy_and_allows_an_edited_retry() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let original = std::fs::read(ctx.repo_path().join("file.txt")).unwrap();
    let lock = ctx.repo().path().join("index.lock");
    std::fs::File::create_new(&lock).unwrap();
    let err = ctx
        .save_merge_draft("file.txt", "approved draft", &revision)
        .unwrap_err();
    assert_eq!(err.code, "stage_failed");
    assert!(ctx.repo().index().unwrap().has_conflicts());
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        original
    );
    std::fs::remove_file(lock).unwrap();
    ctx.save_merge_draft("file.txt", "edited retry", &revision)
        .unwrap();
    let repo = ctx.repo();
    let index = repo.index().unwrap();
    assert!(!index.has_conflicts());
    let entry = index.get_path(std::path::Path::new("file.txt"), 0).unwrap();
    assert_eq!(repo.find_blob(entry.id).unwrap().content(), b"edited retry");
}

#[test]
fn a_binary_index_side_refuses_read_and_save_even_with_a_text_working_file() {
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    let path = std::path::Path::new("file.txt");
    let working = std::fs::read(ctx.repo_path().join(path)).unwrap();
    let mut index = repo.index().unwrap();
    let binary = repo.blob(b"incoming\0version").unwrap();
    index
        .add(&git2::IndexEntry {
            id: binary,
            ..index.get_path(path, 3).unwrap()
        })
        .unwrap();
    index.write().unwrap();

    assert_eq!(
        ctx.get_merge_sides("file.txt").unwrap_err().code,
        "binary_conflict"
    );
    assert_eq!(
        ctx.save_merge_draft("file.txt", "chosen", "")
            .unwrap_err()
            .code,
        "binary_conflict"
    );
    assert_eq!(std::fs::read(ctx.repo_path().join(path)).unwrap(), working);
    assert_eq!(repo.index().unwrap().get_path(path, 3).unwrap().id, binary);
    assert_eq!(
        repo.index()
            .unwrap()
            .iter()
            .filter(|entry| entry.path == b"file.txt")
            .count(),
        3
    );
}

#[test]
fn the_approved_working_text_uses_the_paths_git_clean_conversion_when_staged() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt text eol=crlf\n",
    )
    .unwrap();

    ctx.save_merge_result("file.txt", "chosen\r\n").unwrap();

    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        b"chosen\r\n"
    );
    let repo = ctx.repo();
    let index = repo.index().unwrap();
    let entry = index.get_path(std::path::Path::new("file.txt"), 0).unwrap();
    assert_eq!(repo.find_blob(entry.id).unwrap().content(), b"chosen\n");
}

#[test]
fn a_staged_resolution_keeps_the_current_executable_mode_when_filemode_is_disabled() {
    let ctx = conflicted_file_txt();
    record_both_sides_as(&ctx, "file.txt", 0o100_755);
    ctx.repo()
        .config()
        .unwrap()
        .set_bool("core.filemode", false)
        .unwrap();

    ctx.save_merge_result("file.txt", "edited").unwrap();

    assert_eq!(ctx.staged_mode("file.txt"), 0o100_755);
}

#[cfg(unix)]
#[test]
fn a_configured_clean_filter_receives_the_approved_draft() {
    let ctx = conflicted_file_txt();
    ctx.repo()
        .config()
        .unwrap()
        .set_str("filter.uppercase.clean", "tr a-z A-Z")
        .unwrap();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt filter=uppercase\n",
    )
    .unwrap();

    ctx.save_merge_result("file.txt", "approved\n").unwrap();

    assert_eq!(ctx.staged_bytes("file.txt"), b"APPROVED\n");
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        b"approved\n"
    );
}

#[cfg(unix)]
#[test]
fn stage_all_stages_a_utf8_sibling_of_a_non_utf8_conflict_path() {
    use std::os::unix::ffi::OsStrExt;
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    let name = b"version-\xff.txt";
    let file = std::path::Path::new(std::ffi::OsStr::from_bytes(name));
    let text = std::path::Path::new("file.txt");
    for stage in 1..=3 {
        index
            .add(&git2::IndexEntry {
                path: name.to_vec(),
                ..index.get_path(text, stage).unwrap()
            })
            .unwrap();
    }
    index.write().unwrap();
    let sibling = "version-�.txt";
    std::fs::write(ctx.repo_path().join(sibling), "new file").unwrap();

    ctx.stage_all().unwrap();

    index.read(true).unwrap();
    assert_eq!(ctx.staged_bytes(sibling), b"new file");
    assert!(index.get_path(file, 0).is_none());
    for stage in 1..=3 {
        assert_eq!(
            index.get_path(file, stage).unwrap().id,
            index.get_path(text, stage).unwrap().id
        );
    }
}

#[cfg(unix)]
#[test]
fn a_clean_filter_can_stage_an_independent_file_before_index_publication() {
    let ctx = conflicted_file_txt();
    std::fs::write(ctx.repo_path().join("notes"), "independent").unwrap();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt filter=stage-notes\n",
    )
    .unwrap();
    let mut config = ctx.repo().config().unwrap();
    config
        .set_bool("filter.stage-notes.required", true)
        .unwrap();
    config
        .set_str("filter.stage-notes.clean", "git add -- notes && cat")
        .unwrap();

    ctx.save_merge_result("file.txt", "chosen").unwrap();

    assert_eq!(ctx.staged_bytes("notes"), b"independent");
    assert_eq!(ctx.staged_bytes("file.txt"), b"chosen");
}

#[cfg(unix)]
#[test]
fn a_working_edit_during_cleaning_is_preserved_without_a_stale_retry_revision() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt filter=late-edit\n",
    )
    .unwrap();
    ctx.repo()
        .config()
        .unwrap()
        .set_str(
            "filter.late-edit.clean",
            "printf 'new edit' > file.txt && cat",
        )
        .unwrap();

    let error = ctx.save_merge_result("file.txt", "chosen").unwrap_err();

    assert_eq!(error.code, "conflict_changed");
    assert!(error.working_revision.is_none());
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        b"new edit"
    );
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[cfg(unix)]
#[test]
fn a_changed_clean_conversion_keeps_the_conflict_and_allows_a_fresh_save() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt -text filter=change-rules\n",
    )
    .unwrap();
    ctx.repo()
        .config()
        .unwrap()
        .set_str(
            "filter.change-rules.clean",
            "echo 'file.txt text' > .gitattributes && cat",
        )
        .unwrap();
    let draft = "resolved\r\n";

    let error = ctx.save_merge_result("file.txt", draft).unwrap_err();

    assert_eq!(error.code, "stage_failed");
    assert!(ctx.repo().index().unwrap().has_conflicts());
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        draft.as_bytes()
    );
    ctx.save_merge_draft("file.txt", draft, &error.working_revision.unwrap())
        .unwrap();
    assert_eq!(ctx.staged_bytes("file.txt"), b"resolved\n");
}

#[cfg(unix)]
#[test]
fn mark_keeps_the_conflict_when_its_clean_filter_changes_configuration() {
    let ctx = conflicted_file_txt();
    std::fs::write(ctx.repo_path().join("file.txt"), "chosen\n").unwrap();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt filter=change-rules\n",
    )
    .unwrap();
    ctx.repo()
        .config()
        .unwrap()
        .set_str(
            "filter.change-rules.clean",
            "git config filter.change-rules.clean 'tr a-z A-Z' && cat",
        )
        .unwrap();
    let confirmation = prepare_mark(&ctx, &["file.txt"]);

    let error = mark(&ctx, &confirmation).unwrap_err();

    assert_eq!(error.code, "stage_failed");
    assert!(ctx.repo().index().unwrap().has_conflicts());
    mark(&ctx, &prepare_mark(&ctx, &["file.txt"])).unwrap();
    assert_eq!(ctx.staged_bytes("file.txt"), b"CHOSEN\n");
}

#[cfg(unix)]
#[test]
fn drivers_named_like_git_attribute_states_remain_distinct() {
    for (driver, new_rule) in [
        ("unspecified", "!filter"),
        ("set", "filter"),
        ("unset", "-filter"),
    ] {
        let ctx = conflicted_file_txt();
        std::fs::write(
            ctx.repo_path().join(".gitattributes"),
            format!("file.txt filter={driver}\n"),
        )
        .unwrap();
        let mut config = ctx.repo().config().unwrap();
        config
            .set_str(
                "includeIf.hasconfig:remote.*.url:https://example.invalid/**.path",
                "optional-rules",
            )
            .unwrap();
        config
            .set_str(
                &format!("filter.{driver}.clean"),
                &format!("echo 'file.txt {new_rule}' > .gitattributes && tr a-z A-Z"),
            )
            .unwrap();

        let error = ctx.save_merge_result("file.txt", "lowercase").unwrap_err();

        assert!(ctx.repo().index().unwrap().has_conflicts());
        ctx.save_merge_draft("file.txt", "lowercase", &error.working_revision.unwrap())
            .unwrap();
        assert_eq!(ctx.staged_bytes("file.txt"), b"lowercase");
    }
}

#[cfg(unix)]
#[test]
fn a_literal_and_a_boolean_attribute_survive_git_displaying_the_same_name() {
    for (before, after, content) in [
        ("ident", "ident=set", "$Id: earlier $\n"),
        ("text", "text=set", "chosen\r\n"),
    ] {
        let ctx = conflicted_file_txt();
        let mut config = ctx.repo().config().unwrap();
        config
            .set_str(
                "includeIf.hasconfig:remote.*.url:https://example.invalid/**.path",
                "optional-rules",
            )
            .unwrap();
        config.set_bool("core.autocrlf", false).unwrap();
        config
            .set_str(
                "filter.change.clean",
                &format!(
                    "echo 'file.txt {after} filter=change' > .gitattributes && echo ran >> .git/calls && cat"
                ),
            )
            .unwrap();
        std::fs::write(
            ctx.repo_path().join(".gitattributes"),
            format!("file.txt {before} filter=change\n"),
        )
        .unwrap();

        let error = ctx.save_merge_result("file.txt", content).unwrap_err();

        assert_eq!(error.code, "stage_failed");
        assert!(ctx.repo().index().unwrap().has_conflicts());
        assert_eq!(
            std::fs::read(ctx.repo_path().join(".git/calls")).unwrap(),
            b"ran\n"
        );
        ctx.save_merge_draft("file.txt", content, &error.working_revision.unwrap())
            .unwrap();
        assert_eq!(ctx.staged_bytes("file.txt"), content.as_bytes());
    }
}

#[cfg(unix)]
#[test]
fn the_resolved_attributes_file_selects_its_own_clean_filter() {
    let file = ".gitattributes";
    let ctx = TestContext::builder()
        .with_file(file, "# base\n")
        .with_commit("base")
        .with_branch("feature")
        .checkout("feature")
        .with_file(file, "# theirs\n")
        .with_commit("feature")
        .checkout("main")
        .with_file(file, "# ours\n")
        .with_commit("main")
        .with_conflict("feature")
        .build();
    ctx.repo()
        .config()
        .unwrap()
        .set_str("filter.upper.clean", "tr a-z A-Z")
        .unwrap();

    ctx.save_merge_result(file, ".gitattributes filter=upper\n")
        .unwrap();

    assert_eq!(ctx.staged_bytes(file), b".GITATTRIBUTES FILTER=UPPER\n");
}

#[cfg(unix)]
#[test]
fn staging_keeps_a_private_index_private() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[cfg(target_os = "macos")]
    fn acl(path: &std::path::Path) -> Vec<String> {
        let output = std::process::Command::new("/bin/ls")
            .arg("-led")
            .arg(path)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .skip(1)
            .map(str::to_owned)
            .collect()
    }

    let ctx = conflicted_file_txt();
    let git_dir = ctx.repo().path().to_owned();
    let index = git_dir.join("index");
    std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o600)).unwrap();
    #[cfg(target_os = "macos")]
    let expected_acl = {
        for (target, flag, rule) in [
            (&index, "+a", "everyone allow readattr"),
            (&index, "+ai", "everyone allow readextattr"),
            (
                &git_dir,
                "+a",
                "everyone allow read,file_inherit,directory_inherit",
            ),
        ] {
            assert!(
                std::process::Command::new("/bin/chmod")
                    .args([flag, rule])
                    .arg(target)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        acl(&index)
    };
    let before = std::fs::metadata(&index).unwrap();

    ctx.save_merge_result("file.txt", "private").unwrap();

    let after = std::fs::metadata(&index).unwrap();
    assert_eq!(after.permissions().mode() & 0o777, 0o600);
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    #[cfg(target_os = "macos")]
    {
        assert_eq!(acl(&index), expected_acl);
        let recovery = git_dir.join(format!("trunk-merge-recovery-{}", unsafe {
            libc::geteuid()
        }));
        assert_eq!(acl(&recovery), Vec::<String>::new());
        let entries: Vec<_> = std::fs::read_dir(recovery)
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(acl(&entries[0].path()), Vec::<String>::new());
    }
}

#[test]
fn a_marker_attribute_change_invalidates_picks_built_for_the_old_regions() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt conflict-marker-size=12\n",
    )
    .unwrap();

    assert_ne!(ctx.get_merge_sides("file.txt").unwrap().revision, revision);
    assert_eq!(
        ctx.save_merge_draft("file.txt", "draft", &revision)
            .unwrap_err()
            .code,
        "conflict_changed"
    );
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn a_linked_worktree_publishes_only_its_own_resolution() {
    use trunk_lib::commands::merge_editor::save_merge_result_inner;
    use trunk_lib::state::OpenRepos;

    let ctx = conflicted_file_txt();
    let dir = ctx.add_linked_worktree("linked", "feature");
    let repo = git2::Repository::open(&dir).unwrap();
    let head = repo.find_reference("refs/heads/main").unwrap();
    repo.merge(
        &[&repo.reference_to_annotated_commit(&head).unwrap()],
        None,
        None,
    )
    .unwrap();
    let path = dir.to_str().unwrap();
    let opened = OpenRepos::from_iter([(path.to_owned(), dir.clone())]);
    #[cfg(target_os = "macos")]
    let mut other_editor = std::fs::File::options()
        .append(true)
        .open(dir.join("file.txt"))
        .unwrap();
    let sides = trunk_lib::commands::merge_editor::get_merge_sides_inner(
        path,
        "file.txt",
        trunk_lib::commands::merge_editor::MergeReadPurpose::Editor,
        &opened,
    )
    .unwrap();

    save_merge_result_inner(
        path,
        "file.txt",
        "linked resolution",
        &sides.revision,
        &opened,
    )
    .unwrap();

    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        other_editor.write_all(b"late editor change").unwrap();
        drop(other_editor);
        assert_eq!(
            std::fs::read(dir.join("file.txt")).unwrap(),
            b"linked resolution"
        );

        let recovery = format!("trunk-merge-recovery-{}", unsafe { libc::geteuid() });
        assert!(!ctx.repo().path().join(&recovery).exists());
        let folders: Vec<_> = std::fs::read_dir(repo.path().join(recovery))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        let [save] = folders.as_slice() else {
            panic!("expected one recovery entry for the linked worktree, found {folders:?}");
        };
        assert_eq!(std::fs::read(save.join("path")).unwrap(), b"file.txt");
        assert!(
            std::fs::read(save.join("original"))
                .unwrap()
                .ends_with(b"late editor change")
        );
    }

    let mut index = repo.index().unwrap();
    index.read(true).unwrap();
    let entry = index.get_path(std::path::Path::new("file.txt"), 0).unwrap();
    assert_eq!(
        repo.find_blob(entry.id).unwrap().content(),
        b"linked resolution"
    );
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn manual_draft_preserves_the_index_and_new_working_bytes_if_the_file_changed() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let file = ctx.repo_path().join("file.txt");
    std::fs::write(&file, "external edit").unwrap();
    let err = ctx
        .save_merge_draft("file.txt", "my draft", &revision)
        .unwrap_err();
    assert_eq!(err.code, "conflict_changed");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "external edit");
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn manual_draft_is_refused_if_a_stage_changed_with_the_same_working_bytes() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    let path = std::path::Path::new("file.txt");
    let original = std::fs::read(ctx.repo_path().join(path)).unwrap();
    let oid = repo.blob(b"a different incoming side").unwrap();
    let previous = index.get_path(path, 3).unwrap();
    index
        .add(&git2::IndexEntry {
            id: oid,
            ..previous
        })
        .unwrap();
    index.write().unwrap();
    assert_eq!(
        ctx.save_merge_draft("file.txt", "draft", &revision)
            .unwrap_err()
            .code,
        "conflict_changed"
    );
    assert_eq!(std::fs::read(ctx.repo_path().join(path)).unwrap(), original);
    assert_eq!(repo.index().unwrap().get_path(path, 3).unwrap().id, oid);
}

#[test]
fn edited_marker_lines_lose_only_their_own_revision_label() {
    let ctx = conflicted_file_txt();
    let path = ctx.repo_path().join("file.txt");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(path, text.replace("feature content", "locally typed")).unwrap();
    let sides = ctx.get_merge_sides("file.txt").unwrap();
    assert_eq!(sides.current_label.as_deref(), Some("main"));
    assert!(sides.incoming_label.is_none());
}

#[test]
fn incoming_merge_label_preserves_an_apostrophe_in_the_branch_name() {
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    let incoming = repo
        .find_reference("refs/heads/feature")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    repo.branch("dev's-feature", &incoming, false).unwrap();
    std::fs::write(
        repo.path().join("MERGE_MSG"),
        "Merge branch 'dev's-feature' into release'\n",
    )
    .unwrap();
    assert_eq!(
        ctx.get_merge_sides("file.txt")
            .unwrap()
            .incoming_label
            .as_deref(),
        Some("dev's-feature")
    );
}

#[test]
fn merge_side_labels_name_the_revisions_that_supply_the_file() {
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    std::fs::write(repo.path().join("MERGE_MSG"), "Merge branch 'feature'\n").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(sides.current_label.as_deref(), Some("main"));
    assert_eq!(sides.incoming_label.as_deref(), Some("feature"));
}

#[test]
fn merge_side_label_uses_the_merge_commit_when_a_named_ref_has_moved() {
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    std::fs::write(repo.path().join("MERGE_MSG"), "Merge branch 'feature'\n").unwrap();
    let incoming = repo
        .find_reference("refs/heads/feature")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    let abbreviated = incoming.as_object().short_id().unwrap();
    repo.reference(
        "refs/heads/feature",
        repo.head().unwrap().target().unwrap(),
        true,
        "moved",
    )
    .unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.incoming_label.as_deref(),
        Some(abbreviated.as_str().unwrap())
    );
}

#[test]
fn a_rebase_names_the_detached_target_and_the_replayed_commit() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "base")
        .with_commit("Base")
        .with_branch("topic")
        .checkout("topic")
        .with_file("file.txt", "replayed")
        .with_commit("Topic")
        .checkout("main")
        .with_file("file.txt", "target")
        .with_commit("Target")
        .checkout("topic")
        .build();
    let repo = ctx.repo();
    let short = |name| {
        repo.revparse_single(name)
            .unwrap()
            .short_id()
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    };
    let current = short("refs/heads/main");
    let incoming = format!("Replaying {}", short("refs/heads/topic"));
    ctx.rebase_branch("main").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(sides.current_label, Some(current));
    assert_eq!(sides.incoming_label, Some(incoming));
}

#[test]
fn get_merge_sides_reads_the_conflict_git_wrote() {
    let ctx = conflicted_file_txt();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions,
        [MergeRegion::Conflict {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
        }]
    );
}

#[test]
fn get_merge_sides_reads_a_file_the_user_already_resolved_as_merged() {
    let ctx = conflicted_file_txt();
    std::fs::write(ctx.repo_path().join("file.txt"), "both\n").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions,
        [MergeRegion::Merged {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
            merged_lines: lines("both\n"),
        }]
    );
}

/// A file the user resolved to the current side has no markers and equals that side,
/// as a file git did not merge does, but git did merge it, so it reads as merged.
#[test]
fn get_merge_sides_reads_a_file_the_user_resolved_to_the_current_side_as_merged() {
    let ctx = conflicted_file_txt();
    std::fs::write(ctx.repo_path().join("file.txt"), "main content").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    let sidebar = trunk_lib::commands::merge_editor::get_merge_sides_inner(
        ctx.path(),
        "file.txt",
        trunk_lib::commands::merge_editor::MergeReadPurpose::Resolution,
        ctx.state_map(),
    );
    assert_eq!(sidebar.unwrap_err().code, "no_conflict_regions");
    assert!(ctx.repo().index().unwrap().has_conflicts());

    assert_eq!(
        sides.regions,
        [MergeRegion::Merged {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
            merged_lines: lines("main content"),
        }]
    );
}

#[test]
fn get_merge_sides_reads_markers_of_the_size_the_attributes_set() {
    let ctx = TestContext::builder()
        .with_file(".gitattributes", "file.txt conflict-marker-size=9\n")
        .with_file("file.txt", "hello\n")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content\n")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content\n=======\n")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<<<< HEAD\nmain content\n=======\n=========\nfeature content\n>>>>>>>>> feature\n",
    )
    .unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions[0],
        MergeRegion::Conflict {
            ours_lines: lines("main content\n======="),
            theirs_lines: lines("feature content"),
        }
    );
}

#[test]
fn get_merge_sides_reads_a_conflict_where_both_sides_added_the_file() {
    let ctx = TestContext::builder()
        .with_file("placeholder.txt", "init")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("new_file.txt", "feature version")
        .with_commit("Add new_file on feature")
        .checkout("main")
        .with_file("new_file.txt", "main version")
        .with_commit("Add new_file on main")
        .with_conflict("feature")
        .build();

    let sides = ctx.get_merge_sides("new_file.txt").unwrap();
    assert!(sides.base_oid.is_none());

    assert_eq!(
        sides.regions[0],
        MergeRegion::Conflict {
            ours_lines: lines("main version"),
            theirs_lines: lines("feature version"),
        }
    );
}

/// Read as empty, a file missing from the working tree would show no conflicts, and
/// saving it would stage an empty file over both sides.
#[test]
fn get_merge_sides_refuses_a_file_missing_from_the_working_tree() {
    let ctx = conflicted_file_txt();
    std::fs::remove_file(ctx.repo_path().join("file.txt")).unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "missing_file");
}

/// Rewrites the conflict's two sides in the index as `mode`, standing in for a
/// merge of two branches that each hold a symbolic link or a submodule there.
fn record_both_sides_as(ctx: &TestContext, file_path: &str, mode: u32) {
    const STAGE_SHIFT: u16 = 12;
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    for stage in 1..=3_u16 {
        let entry = index
            .get_path(std::path::Path::new(file_path), i32::from(stage))
            .unwrap();
        let flags = (entry.flags & !(0b11 << STAGE_SHIFT)) | (stage << STAGE_SHIFT);
        index
            .add(&git2::IndexEntry {
                mode,
                flags,
                ..entry
            })
            .unwrap();
    }
    index.write().unwrap();
}

/// A link conflict leaves the link itself in the working tree, so reading the path
/// would show, and saving it would overwrite, whatever the link points at.
#[test]
fn get_merge_sides_refuses_a_conflict_between_two_links() {
    let ctx = conflicted_file_txt();
    record_both_sides_as(&ctx, "file.txt", 0o120_000);

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(
        ctx.get_status().unwrap().conflicted[0].can_take_sides,
        Some(false)
    );
    assert_eq!(err.code, "link_conflict");
}

#[test]
fn save_merge_result_refuses_a_conflict_between_two_links() {
    let ctx = conflicted_file_txt();
    record_both_sides_as(&ctx, "file.txt", 0o120_000);
    let before = std::fs::read(ctx.repo_path().join("file.txt")).unwrap();

    let err = ctx.save_merge_result("file.txt", "resolved").unwrap_err();

    assert_eq!(err.code, "link_conflict");
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        before,
        "a refused save must not write the path"
    );
}

/// A link standing where the conflicted file should be would show a file from
/// outside the repository as the merge.
#[cfg(unix)]
#[test]
fn get_merge_sides_does_not_follow_a_link_in_the_working_tree() {
    let ctx = conflicted_file_txt();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(
        &secret,
        "<<<<<<< HEAD\nsecret\n=======\nx\n>>>>>>> feature\n",
    )
    .unwrap();
    let file = ctx.repo_path().join("file.txt");
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&secret, &file).unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "missing_file");
}

/// Read lossily, the replacement characters would be saved over the file.
#[test]
fn get_merge_sides_refuses_a_working_file_that_is_not_utf8() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        b"<<<<<<< HEAD\n\xff\xfe\n=======\nfeature content\n>>>>>>> feature\n",
    )
    .unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "binary_conflict");
}

/// Read as text, a conflict that never closes would be saved and staged with its
/// markers in it.
#[test]
fn get_merge_sides_refuses_a_conflict_whose_markers_do_not_close() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<< HEAD\nmain content\n=======\nfeature content\n",
    )
    .unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "unclosed_conflict");
}

/// Git writes markers of its default size when the attribute holds no usable size.
#[test]
fn get_merge_sides_reads_default_markers_when_the_attribute_sets_size_zero() {
    let ctx = TestContext::builder()
        .with_file(".gitattributes", "file.txt conflict-marker-size=0\n")
        .with_file("file.txt", "hello\n")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content\n")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content\n")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<< HEAD\nmain content\n=======\nfeature content\n>>>>>>> feature\n",
    )
    .unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions[0],
        MergeRegion::Conflict {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
        }
    );
}

/// Git does not merge a file marked `-merge`: it leaves the current side in the
/// working tree with no markers. Read as a clean merge, taking the incoming side
/// would silently save the current one.
#[test]
fn get_merge_sides_reads_a_file_git_did_not_merge_as_one_conflict() {
    let ctx = TestContext::builder()
        .with_file(".gitattributes", "file.txt -merge\n")
        .with_file("file.txt", "a\nhello\nz\n")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "a\nfeature content\nz\n")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "a\nmain content\nz\n")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    std::fs::write(ctx.repo_path().join("file.txt"), "a\nmain content\nz\n").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions,
        [
            MergeRegion::Merged {
                ours_lines: lines("a"),
                theirs_lines: lines("a"),
                merged_lines: lines("a"),
            },
            MergeRegion::Conflict {
                ours_lines: lines("main content"),
                theirs_lines: lines("feature content"),
            },
            MergeRegion::Merged {
                ours_lines: lines("z\n"),
                theirs_lines: lines("z\n"),
                merged_lines: lines("z\n"),
            },
        ]
    );
}

#[test]
fn save_merge_result_writes_and_stages() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let result = ctx.save_merge_result("file.txt", "resolved content");
    assert!(result.is_ok(), "expected Ok, got: {result:?}");

    // Assert the file on disk contains "resolved content"
    let content = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        content, "resolved content",
        "file on disk should contain resolved content"
    );

    // Assert the file is staged in the index (no longer in conflict entries)
    let repo = ctx.repo();
    let index = repo.index().unwrap();
    assert!(
        !index.has_conflicts(),
        "index should have no conflicts after staging"
    );
}

#[cfg(unix)]
#[test]
fn save_merge_result_preserves_a_link_that_replaced_the_working_copy() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "secret").unwrap();
    let file = ctx.repo_path().join("file.txt");
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&secret, &file).unwrap();

    let err = ctx
        .save_merge_draft("file.txt", "resolved content", &revision)
        .unwrap_err();
    assert_eq!(err.code, "conflict_changed");
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "secret");
    assert!(file.is_symlink());
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[cfg(unix)]
#[test]
fn save_merge_result_refuses_a_file_inside_a_linked_directory() {
    let ctx = TestContext::builder()
        .with_file("dir/file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("dir/file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("dir/file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    let revision = ctx.get_merge_sides("dir/file.txt").unwrap().revision;
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("file.txt"), "secret").unwrap();
    let dir = ctx.repo_path().join("dir");
    std::fs::remove_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(outside.path(), &dir).unwrap();

    let err = ctx
        .save_merge_draft("dir/file.txt", "resolved content", &revision)
        .unwrap_err();

    assert_eq!(err.code, "conflict_changed");
    assert_eq!(
        std::fs::read_to_string(outside.path().join("file.txt")).unwrap(),
        "secret"
    );
}

/// A PNG carries no text sides. Reading it through `String::from_utf8_lossy`
/// replaces every invalid byte with U+FFFD, and saving that back writes the
/// replacement characters over the file with both original sides already gone.
#[test]
fn get_merge_sides_refuses_a_binary_conflict() {
    let ours: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeOURS";
    let theirs: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeTHEM";
    let ctx = TestContext::builder()
        .with_binary_file("image.png", b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeBASE")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_binary_file("image.png", theirs)
        .with_commit("Feature commit")
        .checkout("main")
        .with_binary_file("image.png", ours)
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let err = ctx.get_merge_sides("image.png").unwrap_err();

    assert_eq!(err.code, "binary_conflict");
}

/// A side that deleted the file has no blob. Read as empty text, taking that side
/// saved an empty file and staged it, so the merge kept a file the side removed.
#[test]
fn get_merge_sides_refuses_a_conflict_where_one_side_deleted_the_file() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_removed_file("file.txt")
        .with_commit("Delete the file")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(
        ctx.get_status().unwrap().conflicted[0].can_take_sides,
        Some(false)
    );
    assert_eq!(err.code, "delete_conflict");
}

#[test]
fn get_merge_sides_refuses_a_conflict_where_the_current_side_deleted_the_file() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_removed_file("file.txt")
        .with_commit("Delete the file")
        .with_conflict("feature")
        .build();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "delete_conflict");
}

/// The save path is reachable without the read path, from an editor opened on
/// an earlier conflict of the same file. Saving text there would stage a file
/// the deleting side removed, and the conflict that recorded the choice is gone.
#[test]
fn save_merge_result_refuses_a_conflict_where_one_side_deleted_the_file() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_removed_file("file.txt")
        .with_commit("Delete the file")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let err = ctx.save_merge_result("file.txt", "").unwrap_err();

    assert_eq!(err.code, "delete_conflict");
    let kept = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        kept, "main content",
        "a refused save must not write the file"
    );
    assert_eq!(
        ctx.get_merge_sides("file.txt").unwrap_err().code,
        "delete_conflict",
        "a refused save must leave the conflict in the index"
    );
}

/// The editor stays on screen after the operation it belongs to ends, and its
/// Save button stays live. Writing then would put the merged text over the file
/// the abort just restored and stage it, destroying content that was never
/// committed and cannot be recovered from the repository.
#[test]
fn save_merge_result_refuses_once_the_conflict_is_gone() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    ctx.merge_abort().unwrap();

    let err = ctx
        .save_merge_result("file.txt", "resolved content")
        .unwrap_err();

    assert_eq!(err.code, "not_conflicted");
    let restored = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        restored, "main content",
        "the abort's restored content must survive a stale save"
    );
}

fn conflicted_file() -> TestContext {
    TestContext::builder()
        .with_file("file.txt", "hello")
        .with_file("other.txt", "untouched")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build()
}

fn prepare_mark(
    ctx: &TestContext,
    paths: &[&str],
) -> trunk_lib::commands::merge_editor::mark::MarkConfirmation {
    trunk_lib::commands::merge_editor::mark::prepare_mark_resolved_inner(
        ctx.path(),
        &paths.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>(),
        ctx.state_map(),
    )
    .unwrap()
}

fn mark(
    ctx: &TestContext,
    confirmation: &trunk_lib::commands::merge_editor::mark::MarkConfirmation,
) -> Result<(), trunk_git::error::TrunkError> {
    trunk_lib::commands::merge_editor::mark::mark_conflicts_resolved_inner(
        ctx.path(),
        &confirmation.files,
        ctx.state_map(),
    )
}

#[test]
fn approving_a_marker_warning_cannot_stage_an_unrelated_edit_after_external_resolution() {
    let ctx = conflicted_file();
    let confirmation = prepare_mark(&ctx, &["file.txt"]);
    assert_eq!(confirmation.marked, ["file.txt"]);
    ctx.merge_abort().unwrap();
    std::fs::write(ctx.repo_path().join("file.txt"), b"unrelated edit").unwrap();

    assert_eq!(
        mark(&ctx, &confirmation).unwrap_err().code,
        "not_conflicted"
    );
    assert_eq!(ctx.staged_bytes("file.txt"), b"main content");
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        b"unrelated edit"
    );
}

#[test]
fn changing_one_file_rejects_the_whole_confirmed_conflict_batch() {
    let ctx = TestContext::builder()
        .with_file("a", "original")
        .with_file("b", "original")
        .with_commit("base")
        .with_branch("topic")
        .checkout("topic")
        .with_file("a", "theirs")
        .with_file("b", "theirs")
        .with_commit("topic")
        .checkout("main")
        .with_file("a", "ours")
        .with_file("b", "ours")
        .with_commit("main")
        .with_conflict("topic")
        .build();
    let confirmation = prepare_mark(&ctx, &["a", "b"]);
    assert_eq!(confirmation.marked, ["a", "b"]);
    std::fs::write(ctx.repo_path().join("b"), "external replacement").unwrap();

    assert_eq!(
        mark(&ctx, &confirmation).unwrap_err().code,
        "conflict_changed"
    );
    let repo = ctx.repo();
    assert_eq!(repo.index().unwrap().conflicts().unwrap().count(), 2);

    let reviewed = prepare_mark(&ctx, &["a", "b"]);
    mark(&ctx, &reviewed).unwrap();
    assert_eq!(ctx.staged_bytes("b"), b"external replacement");
    assert!(!ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn marking_the_confirmed_deletion_removes_all_conflict_stages() {
    let ctx = conflicted_file_txt();
    std::fs::remove_file(ctx.repo_path().join("file.txt")).unwrap();

    let confirmation = prepare_mark(&ctx, &["file.txt"]);
    assert_eq!(confirmation.marked, Vec::<String>::new());
    mark(&ctx, &confirmation).unwrap();

    let index = ctx.repo().index().unwrap();
    assert!(!index.has_conflicts());
    assert!(
        index
            .get_path(std::path::Path::new("file.txt"), 0)
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn marking_a_link_stages_the_target_bytes_without_filtering() {
    let ctx = conflicted_file_txt();
    record_both_sides_as(&ctx, "file.txt", 0o120_000);
    let path = ctx.repo_path().join("file.txt");
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink("missing target", path).unwrap();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt filter=upper\n",
    )
    .unwrap();
    ctx.repo()
        .config()
        .unwrap()
        .set_str("filter.upper.clean", "tr a-z A-Z")
        .unwrap();

    let confirmation = prepare_mark(&ctx, &["file.txt"]);
    assert_eq!(confirmation.marked, Vec::<String>::new());
    mark(&ctx, &confirmation).unwrap();

    assert_eq!(ctx.staged_bytes("file.txt"), b"missing target");
    assert_eq!(ctx.staged_mode("file.txt"), 0o120_000);
}

#[cfg(unix)]
#[test]
fn marking_the_working_file_runs_its_clean_filter_with_the_confirmed_bytes() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt filter=upper\n",
    )
    .unwrap();
    ctx.repo()
        .config()
        .unwrap()
        .set_str("filter.upper.clean", "tr a-z A-Z")
        .unwrap();
    std::fs::write(ctx.repo_path().join("file.txt"), "chosen text").unwrap();

    let confirmation = prepare_mark(&ctx, &["file.txt"]);
    mark(&ctx, &confirmation).unwrap();

    assert_eq!(ctx.staged_bytes("file.txt"), b"CHOSEN TEXT");
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        b"chosen text"
    );
}

#[test]
fn replacing_a_confirmed_file_with_an_identical_copy_requires_new_confirmation() {
    let ctx = conflicted_file_txt();
    let confirmation = prepare_mark(&ctx, &["file.txt"]);
    let path = ctx.repo_path().join("file.txt");
    let replacement = ctx.repo_path().join("replacement");
    std::fs::copy(&path, &replacement).unwrap();
    std::fs::rename(replacement, path).unwrap();

    assert_eq!(
        mark(&ctx, &confirmation).unwrap_err().code,
        "conflict_changed"
    );
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn the_confirmation_lists_a_file_that_still_holds_the_merge_markers() {
    let ctx = conflicted_file();

    let found = prepare_mark(&ctx, &["file.txt"]).marked;

    assert_eq!(found, vec!["file.txt".to_string()]);
}

#[test]
fn the_confirmation_omits_a_file_whose_markers_were_edited_out() {
    let ctx = conflicted_file();
    std::fs::write(ctx.repo_path().join("file.txt"), "main content\n").unwrap();

    let found = prepare_mark(&ctx, &["file.txt"]).marked;

    assert_eq!(found, Vec::<String>::new());
}

#[test]
fn the_confirmation_omits_a_file_that_was_deleted() {
    let ctx = conflicted_file();
    std::fs::remove_file(ctx.repo_path().join("file.txt")).unwrap();

    let found = prepare_mark(&ctx, &["file.txt"]).marked;

    assert_eq!(found, Vec::<String>::new());
}

#[test]
fn the_confirmation_lists_a_file_holding_markers_of_the_size_the_attributes_set() {
    let ctx = conflicted_file();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt conflict-marker-size=9\n",
    )
    .unwrap();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<<<< HEAD\nmain content\n=========\nfeature content\n>>>>>>>>> feature\n",
    )
    .unwrap();

    let found = prepare_mark(&ctx, &["file.txt"]).marked;

    assert_eq!(found, vec!["file.txt".to_string()]);
}

/// A Markdown heading underlined with `=======` is not a conflict, so only a
/// file holding the opening and closing markers too is listed.
#[test]
fn the_confirmation_omits_a_file_with_only_a_separator_line() {
    let ctx = conflicted_file();
    std::fs::write(ctx.repo_path().join("file.txt"), "Title\n=======\n").unwrap();

    let found = prepare_mark(&ctx, &["file.txt"]).marked;

    assert_eq!(found, Vec::<String>::new());
}

#[test]
fn save_merge_result_keeps_the_resolution_while_another_writer_stages_meanwhile() {
    let mut ctx = conflicted_file();

    ctx.act_while_another_writer_stages("a.txt", |ctx| {
        ctx.save_merge_result("file.txt", "resolved content")
    })
    .expect("save_merge_result failed");

    let index = ctx.repo().index().unwrap();
    assert!(!index.has_conflicts(), "the conflict came back");
    assert!(
        index.get_path(std::path::Path::new("a.txt"), 0).is_some(),
        "the other writer's file was lost"
    );
}
