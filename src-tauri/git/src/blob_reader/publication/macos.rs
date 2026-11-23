//! Advisory locks cannot exclude a writer that already has the original open.
//! Retain the displaced inode in this worktree's Git directory and publish the
//! approved bytes on a separate inode. A late writer then updates the original.
use super::super::{WorkingTreeEdit, no_link_open_options, open_parent};
use super::write_error;
use crate::error::TrunkError;
use crate::macos_metadata::{
    FileAccess, FileAttributes, privatize_new_directory, verify_private_directory, withhold_access,
};
use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, DirBuilder, DirBuilderExt, File, MetadataExt, OpenOptions, OpenOptionsExt};
use rustix::fs::{RenameFlags, renameat_with};
use std::ffi::OsStr;
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::path::Path;

fn recovery_name() -> String {
    format!("trunk-merge-recovery-{}", unsafe { libc::geteuid() })
}

#[cfg(test)]
mod tests;

impl WorkingTreeEdit<'_> {
    pub(in crate::blob_reader) fn publish_recoverable(
        self,
        repo: &git2::Repository,
        bytes: &[u8],
    ) -> Result<(), TrunkError> {
        self.publish_with_exchange(repo, bytes, exchange_original)
    }

    fn publish_with_exchange(
        self,
        repo: &git2::Repository,
        bytes: &[u8],
        exchange: impl FnOnce(&Dir, &Dir, &OsStr) -> io::Result<()>,
    ) -> Result<(), TrunkError> {
        let name = self.path.file_name;
        // A replacement must require the same write access as editing the original.
        let source = self
            .directory
            .open_with(name, no_link_open_options().write(true))
            .map_err(write_error)?;
        if !self.matches_displaced(&source)? || source.metadata().map_err(write_error)?.nlink() != 1
        {
            return Err(Self::changed());
        }
        let source = source.into_std();
        source.try_lock().map_err(write_error)?;

        let git_dir = Dir::open_ambient_dir(repo.path(), cap_std::ambient_authority())
            .map_err(write_error)?;
        if git_dir.dir_metadata().map_err(write_error)?.dev()
            != self.directory.dir_metadata().map_err(write_error)?.dev()
        {
            return Err(TrunkError::new(
                "merge_recovery_volume",
                "The working file and Git directory are on different volumes. Copy your draft, save it in your editor, then stage this file in Trunk.",
            ));
        }
        let store = recovery_root(&git_dir).map_err(|e| {
            write_error(format!(
                "Could not open the private merge recovery directory {}: {e}",
                repo.path().join(recovery_name()).display()
            ))
        })?;
        let (id, entry) = create_entry(&store).map_err(write_error)?;
        let recovery = repo.path().join(recovery_name()).join(id).join("original");

        let prepare = || -> Result<_, TrunkError> {
            let mut manifest = new_file(&entry, "path").map_err(write_error)?;
            manifest
                .write_all(self.path.input.as_bytes())
                .and_then(|()| manifest.sync_all())
                .map_err(write_error)?;
            let resolution = prepare_resolution(&entry, &source, bytes).map_err(write_error)?;
            // Reopen the user's path after preparation. Ancestor directories can
            // move while the output and its metadata are being written.
            let current = Self::open(repo, self.path.input)?;
            if !self.same_file(&current)? || current.bytes != self.bytes {
                return Err(Self::changed());
            }
            // The recovery name starts with the resolution. The kernel exchanges
            // both names together, so even a process exit cannot leave a hole.
            exchange(&entry, &self.directory, name).map_err(|error| {
                write_error(format!(
                    "Could not exchange {} with {}: {error}",
                    self.path.input,
                    recovery.display()
                ))
            })?;
            Ok(resolution)
        };
        let resolution = match prepare() {
            Ok(resolution) => resolution,
            Err(error) => {
                // No exchange took place. Both the working file and index are intact.
                let _ = entry.remove_file("original");
                let _ = entry.remove_file("path");
                let _ = entry.remove_open_dir();
                return Err(error);
            }
        };

        self.finish_exchange(repo, entry, &recovery, &source, &resolution)
    }

    fn finish_exchange(
        &self,
        repo: &git2::Repository,
        entry: Dir,
        recovery: &Path,
        source: &std::fs::File,
        prepared: &PreparedResolution,
    ) -> Result<(), TrunkError> {
        use std::os::unix::fs::MetadataExt as StdMetadataExt;
        let PreparedResolution {
            file: resolution,
            access,
            attributes,
        } = prepared;
        let expected = resolution.metadata().map_err(write_error)?;
        let check_names = || {
            let parent = open_parent(repo, &self.path)?;
            let installed = parent
                .symlink_metadata(self.path.file_name)
                .map_err(write_error)?;
            let displaced = entry.symlink_metadata("original").map_err(write_error)?;
            if same_entry(
                &parent.dir_metadata().map_err(write_error)?,
                &self.directory.dir_metadata().map_err(write_error)?,
            ) && (installed.dev(), installed.ino()) == (expected.dev(), expected.ino())
                && same_entry(&displaced, &self.file.metadata().map_err(write_error)?)
                && displaced.nlink() == 1
            {
                Ok(())
            } else {
                Err(Self::changed())
            }
        };
        let publish = || {
            check_names()?;
            if FileAttributes::capture(source).map_err(write_error)? != *attributes
                || !access.matches(source).map_err(write_error)?
            {
                return Err(Self::changed());
            }
            // This is the access-policy handoff. The verified ACL and mode
            // take effect together, on the resolution inode we still hold.
            access.apply(resolution).map_err(write_error)?;
            if !access.matches(resolution).map_err(write_error)?
                || !access.matches(source).map_err(write_error)?
            {
                return Err(Self::changed());
            }
            check_names()
        };
        publish().or_else(|error| {
            self.undo_exchange(entry, resolution, recovery, error, exchange_original)
        })
    }

    // Exchange back without ever vacating the working pathname. If an intervening
    // rename wins the race with rollback, put its file back when the path is still
    // ours to restore. Both entries stay reachable even if the process exits.
    fn undo_exchange(
        &self,
        entry: Dir,
        resolution: &std::fs::File,
        recovery: &Path,
        reason: TrunkError,
        mut exchange: impl FnMut(&Dir, &Dir, &OsStr) -> io::Result<()>,
    ) -> Result<(), TrunkError> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let name = self.path.file_name;
        let retained = |error: io::Error| {
            TrunkError::new(
                "conflict_changed",
                format!(
                    "{} The working file changed during recovery ({error}). Compare the working file with {}.",
                    reason.message,
                    recovery.display()
                ),
            )
        };
        let meta = resolution.metadata().map_err(retained)?;
        let mut expected = (meta.dev(), meta.ino());
        let identity = |m: cap_std::fs::Metadata| {
            (
                cap_std::fs::MetadataExt::dev(&m),
                cap_std::fs::MetadataExt::ino(&m),
            )
        };
        // A second exchange is needed only if a different file arrived inside
        // the first exchange. Stop if the names continue to change.
        for attempt in 0..2 {
            if identity(self.directory.symlink_metadata(name).map_err(retained)?) != expected {
                return Err(retained(io::Error::other("a later replacement was kept")));
            }
            let restoring = identity(entry.symlink_metadata("original").map_err(retained)?);
            exchange(&entry, &self.directory, name).map_err(retained)?;
            if identity(entry.symlink_metadata("original").map_err(retained)?) == expected {
                if attempt == 0 {
                    // An editor may already have opened the withdrawn resolution.
                    entry
                        .rename("original", &entry, "withdrawn")
                        .map_err(retained)?;
                    // Validation may have failed before the working permissions
                    // were installed. The withdrawn file is private again.
                    resolution
                        .set_permissions(std::fs::Permissions::from_mode(0o600))
                        .map_err(write_error)?;
                    return Err(TrunkError::new(
                        reason.code,
                        format!(
                            "{} The previous working file was restored. The withdrawn output is at {}.",
                            reason.message,
                            recovery.with_file_name("withdrawn").display()
                        ),
                    ));
                }
                return Err(retained(io::Error::other(
                    "a later replacement was restored",
                )));
            }
            expected = restoring;
        }
        Err(retained(io::Error::other(
            "another program is still replacing this path",
        )))
    }
}

fn exchange_original(entry: &Dir, directory: &Dir, name: &OsStr) -> io::Result<()> {
    renameat_with(entry, "original", directory, name, RenameFlags::EXCHANGE).map_err(Into::into)
}

fn same_entry(a: &cap_std::fs::Metadata, b: &cap_std::fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

fn new_file(dir: &Dir, name: &str) -> io::Result<File> {
    dir.open_with(
        name,
        OpenOptions::new().write(true).create_new(true).mode(0o600),
    )
}

struct PreparedResolution {
    file: std::fs::File,
    access: FileAccess,
    attributes: FileAttributes,
}

fn prepare_resolution(
    entry: &Dir,
    source: &std::fs::File,
    bytes: &[u8],
) -> io::Result<PreparedResolution> {
    let access = FileAccess::capture(source)?;
    let mut output = new_file(entry, "original")?.into_std();
    // Darwin's copyfile omits inherited ACL entries. Copy stat data and xattrs
    // here. Its saved access rules are installed only after the exchange.
    if unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            output.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_STAT | libc::COPYFILE_XATTR,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    output.write_all(bytes)?;
    let attributes = FileAttributes::capture(&output)?;
    if FileAttributes::capture(source)? != attributes || !access.matches(source)? {
        return Err(io::Error::other(
            "Could not preserve the working file's metadata.",
        ));
    }
    withhold_access(&output)?;
    output.sync_all()?;
    Ok(PreparedResolution {
        file: output,
        access,
        attributes,
    })
}

fn recovery_root(parent: &Dir) -> io::Result<Dir> {
    let created = match parent.create_dir_with(recovery_name(), DirBuilder::new().mode(0o700)) {
        Ok(()) => true,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(e),
    };
    open_private_dir(parent, &recovery_name(), created)
}

fn create_entry(store: &Dir) -> io::Result<(String, Dir)> {
    loop {
        // IDs are reserved by mkdir. A collision never reuses a previous entry.
        let (high, low) = unsafe { (libc::arc4random(), libc::arc4random()) };
        let id = format!("{high:08x}{low:08x}");
        match store.create_dir_with(&id, DirBuilder::new().mode(0o700)) {
            Ok(()) => {
                let dir = open_private_dir(store, &id, true)?;
                return Ok((id, dir));
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e),
        }
    }
}

fn open_private_dir(parent: &Dir, name: &str, created: bool) -> io::Result<Dir> {
    let file = parent.open_dir_nofollow(name)?.into_std_file();
    if created {
        privatize_new_directory(&file)?;
    } else {
        verify_private_directory(&file)?;
    }
    Ok(Dir::from_std_file(file))
}
