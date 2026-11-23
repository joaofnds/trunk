use super::WorkingTreeEdit;
#[cfg(unix)]
use super::{ValidatedRelativePath, open_regular_file};
use crate::error::TrunkError;
#[cfg(unix)]
use cap_std::fs::Dir;
use cap_std::fs::File;
#[cfg(unix)]
use std::ffi::OsStr;
use std::io::{self, Read, Seek, Write};

fn write_error(error: impl std::fmt::Display) -> TrunkError {
    TrunkError::new("write_error", error.to_string())
}

impl WorkingTreeEdit<'_> {
    #[cfg(unix)]
    pub(super) fn publish(self, bytes: &[u8]) -> Result<(), TrunkError> {
        use cap_std::fs::{DirBuilder, DirBuilderExt};
        let parent = self.directory.try_clone().map_err(write_error)?;
        let file = self.path.file_name;
        let key = git2::Oid::hash_object(git2::ObjectType::Blob, file.as_encoded_bytes())?;
        let name = format!(".trunk-merge-{key}");
        let recovery = std::path::Path::new(self.path.input)
            .with_file_name(&name)
            .join("original");
        parent
            .create_dir_with(&name, DirBuilder::new().mode(0o700))
            .map_err(|e| {
                if e.kind() == io::ErrorKind::AlreadyExists {
                    write_error(format!(
                        "Review the previous save in {} before retrying.",
                        recovery.display()
                    ))
                } else {
                    write_error(e)
                }
            })?;
        let private = parent.open_dir_nofollow(&name).map_err(write_error)?;
        let displaced = "original";
        if let Err(error) = parent.rename(file, &private, displaced) {
            let _ = private.remove_open_dir();
            return Err(write_error(error));
        }

        let update = self.install_displaced(&private, file, bytes);
        if let Err(error) = update {
            return restore_after_failure(private, &parent, file, &recovery, error);
        }

        private.remove_open_dir_all().map_err(write_error)
    }

    #[cfg(unix)]
    fn install_displaced(
        self,
        private: &Dir,
        file: &OsStr,
        bytes: &[u8],
    ) -> Result<(), TrunkError> {
        use cap_fs_ext::MetadataExt;
        use cap_std::fs::OpenOptionsExt;
        let original = open_regular_file(private, &ValidatedRelativePath::parse("original")?)?;
        if !self.matches_displaced(&original)? {
            return Err(Self::changed());
        }
        let metadata = original.metadata().map_err(write_error)?;
        drop(original);
        drop(self.file);
        let mut options = super::no_link_open_options();
        options.write(true);
        let mut exclusive = private
            .open_with("original", &options)
            .map_err(write_error)?;
        #[cfg(target_os = "linux")]
        linux_exclusive(&exclusive).map_err(write_error)?;
        #[cfg(target_os = "macos")]
        let reservation = exclusive.try_clone().map_err(write_error)?.into_std();
        #[cfg(target_os = "macos")]
        reservation.try_lock().map_err(write_error)?;
        let current = exclusive.metadata().map_err(write_error)?;
        if metadata.dev() != current.dev()
            || metadata.ino() != current.ino()
            || current.nlink() != 1
            || current.permissions() != self.permissions
        {
            return Err(Self::changed());
        }
        let mut backup_options = cap_std::fs::OpenOptions::new();
        backup_options.write(true).create_new(true).mode(0o600);
        let mut before = private
            .open_with("before", &backup_options)
            .map_err(write_error)?;
        before
            .write_all(&self.bytes)
            .and_then(|()| before.sync_all())
            .map_err(write_error)?;
        let mut current = Vec::new();
        exclusive.read_to_end(&mut current).map_err(write_error)?;
        if current != self.bytes {
            return Err(Self::changed());
        }
        let rollback = |file: &mut File, error: io::Error| -> TrunkError {
            match overwrite(file, &self.bytes) {
                Ok(()) => write_error(error),
                Err(restore) => TrunkError::new(
                    "merge_recovery",
                    format!(
                        "Save failed ({error}) and the original could not be restored ({restore})."
                    ),
                ),
            }
        };
        if let Err(error) = overwrite(&mut exclusive, bytes) {
            return Err(rollback(&mut exclusive, error));
        }
        if let Err(error) = install_new(private, OsStr::new("original"), &self.directory, file) {
            let mut displaced = Vec::new();
            exclusive
                .rewind()
                .and_then(|()| exclusive.read_to_end(&mut displaced))
                .map_err(|e| TrunkError::new("merge_recovery", e.to_string()))?;
            if displaced == bytes {
                return Err(rollback(&mut exclusive, error));
            }
            return Err(Self::changed());
        }
        Ok(())
    }

    fn matches_displaced(&self, file: &File) -> Result<bool, TrunkError> {
        use cap_fs_ext::MetadataExt;
        let expected = self.file.metadata().map_err(write_error)?;
        let metadata = file.metadata().map_err(write_error)?;
        if metadata.dev() != expected.dev()
            || metadata.ino() != expected.ino()
            || metadata.permissions() != self.permissions
        {
            return Ok(false);
        }

        let mut source = file;
        source.rewind().map_err(write_error)?;
        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes).map_err(write_error)?;
        Ok(bytes == self.bytes)
    }

    #[cfg(windows)]
    pub(super) fn publish(self, bytes: &[u8]) -> Result<(), TrunkError> {
        use cap_fs_ext::MetadataExt;
        use cap_std::fs::OpenOptionsExt;
        let mut options = super::no_link_open_options();
        // FILE_SHARE_READ denies competing writers and renames until this handle closes.
        options.write(true).share_mode(1);
        let mut file = self
            .directory
            .open_with(self.path.file_name, &options)
            .map_err(write_error)?;
        if !self.matches_displaced(&file)? || file.metadata().map_err(write_error)?.nlink() != 1 {
            return Err(Self::changed());
        }
        if let Err(error) = overwrite(&mut file, bytes) {
            overwrite(&mut file, &self.bytes).map_err(write_error)?;
            return Err(write_error(error));
        }
        Ok(())
    }
}

#[cfg(unix)]
use cap_fs_ext::DirExt;

#[cfg(unix)]
fn restore_after_failure(
    private: Dir,
    parent: &Dir,
    file: &OsStr,
    recovery: &std::path::Path,
    error: TrunkError,
) -> Result<(), TrunkError> {
    let restore = install_new(&private, OsStr::new("original"), parent, file);
    if error.code == "merge_recovery" {
        let before = recovery.with_file_name("before");
        return Err(TrunkError::new(
            "merge_recovery",
            format!(
                "{} The original bytes are preserved at {}.",
                error.message,
                before.display()
            ),
        ));
    }
    if restore.is_err() {
        return Err(TrunkError::new(
            "conflict_changed",
            format!(
                "{}. The displaced file is preserved at {}.",
                error.message,
                recovery.display()
            ),
        ));
    }

    private.remove_open_dir_all().map_err(write_error)?;
    Err(error)
}

#[cfg(unix)]
fn install_new(from: &Dir, source: &OsStr, into: &Dir, target: &OsStr) -> io::Result<()> {
    use rustix::fs::{RenameFlags, renameat_with};
    match renameat_with(from, source, into, target, RenameFlags::NOREPLACE) {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::NOTSUP | rustix::io::Errno::NOSYS | rustix::io::Errno::INVAL) => {
            from.hard_link(source, into, target)?;
            from.remove_file(source)
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(target_os = "linux")]
fn linux_exclusive(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // The only directory entry now resides in the private recovery directory.
    // A conflicting open descriptor prevents taking the write lease.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLEASE, libc::F_WRLCK) } == -1 {
        return Err(io::Error::other(format!(
            "Could not reserve the original file for writing. Close other editors or save and stage it manually. {}",
            io::Error::last_os_error()
        )));
    }
    // We join no notification loop. A lease break must not signal the GUI.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETOWN, 0) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn overwrite(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.rewind()?;
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)?;
    file.sync_all()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use xattr::FileExt;

    #[test]
    fn an_edit_preserves_extended_attributes_and_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (root, repo, _) = super::super::test_repo::with_three_revs();
        let path = root.path().join("doc.md");
        let before = std::fs::File::open(&path).unwrap();
        before.set_xattr("user.trunk-merge", b"kept").unwrap();
        before
            .set_permissions(std::fs::Permissions::from_mode(0o640))
            .unwrap();
        drop(before);
        let expected_ino = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&path).unwrap());
        let edit = WorkingTreeEdit::open(&repo, "doc.md").unwrap();

        edit.replace(&repo, b"updated").unwrap();

        let after = std::fs::File::open(path).unwrap();
        assert_eq!(
            std::os::unix::fs::MetadataExt::ino(&after.metadata().unwrap()),
            expected_ino
        );
        assert_eq!(
            after.get_xattr("user.trunk-merge").unwrap().unwrap(),
            b"kept"
        );
        assert_eq!(
            after.metadata().unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[test]
    fn a_failed_byte_rollback_keeps_the_verified_backup_when_the_name_can_be_restored() {
        let (root, repo, _) = super::super::test_repo::with_three_revs();
        let edit = WorkingTreeEdit::open(&repo, "doc.md").unwrap();
        edit.directory.create_dir("parked").unwrap();
        let parked = edit.directory.open_dir_nofollow("parked").unwrap();
        edit.directory
            .rename("doc.md", &parked, "original")
            .unwrap();
        parked.write("before", b"complete original").unwrap();
        parked.write("original", b"partial").unwrap();

        let error = restore_after_failure(
            parked,
            &edit.directory,
            OsStr::new("doc.md"),
            std::path::Path::new("parked/original"),
            TrunkError::new("merge_recovery", "Rollback failed"),
        )
        .unwrap_err();

        assert!(error.message.contains("parked/before"));
        assert_eq!(
            std::fs::read(root.path().join("parked/before")).unwrap(),
            b"complete original"
        );
        assert_eq!(
            std::fs::read(root.path().join("doc.md")).unwrap(),
            b"partial"
        );
    }

    #[test]
    fn a_new_destination_wins_and_the_displaced_contents_remain_recoverable() {
        let (root, repo, _) = super::super::test_repo::with_three_revs();
        let edit = WorkingTreeEdit::open(&repo, "doc.md").unwrap();
        let original = edit.bytes.clone();
        edit.directory.create_dir("parked").unwrap();
        let parked = edit.directory.open_dir_nofollow("parked").unwrap();
        edit.directory
            .rename("doc.md", &parked, "original")
            .unwrap();
        std::fs::write(root.path().join("doc.md"), b"concurrent edit").unwrap();

        let result = edit.install_displaced(&parked, OsStr::new("doc.md"), b"draft");

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(root.path().join("doc.md")).unwrap(),
            b"concurrent edit"
        );
        assert_eq!(parked.read("original").unwrap(), original);
    }
}
