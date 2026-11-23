//! libgit2 writes its index and lock by pathname. Bind those names to a private
//! directory even when another account can rename children of the Git directory.
use std::fs::File;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use trunk_git::macos_metadata::{copy_file_access, privatize_new_directory};

// Until acquisition succeeds, this save owns no files in the directory.
struct EmptyDirectory(PathBuf);

impl Drop for EmptyDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

pub(super) struct Workspace {
    path: EmptyDirectory,
    // Keep the directory's file ID allocated for as long as we use its path.
    directory: File,
}

impl Workspace {
    pub(super) fn new(index_path: &Path) -> io::Result<Self> {
        let source = File::open(index_path)?;
        let uid = unsafe { libc::geteuid() };
        if uid != 0 && uid != source.metadata()?.uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "The Git index belongs to another account. Ask its owner to stage this resolution or correct the index ownership before retrying.",
            ));
        }
        let parent = index_path.parent().ok_or(io::ErrorKind::InvalidInput)?;
        let workspace = if let Ok(stable_parent) = file_id_path(&File::open(parent)?) {
            // Files created on Darwin inherit the directory's group, including a
            // shared group the current account cannot assign using chown.
            let name = tempfile::Builder::new()
                .prefix("trunk-merge-index-")
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir_in(stable_parent)?
                .keep();
            let mut path = EmptyDirectory(name);
            // Opening a newly created directory may already be denied by an
            // inherited ACL. Bind cleanup to its ID before attempting that open.
            let expected = std::fs::symlink_metadata(&path.0)?;
            path.0 = id_path(&expected);
            let dir = open_directory(&path.0)?;
            verify_file_id(&expected, &dir)?;
            Self::from_directory(path, dir)?
        } else {
            // Some filesystems cannot resolve persistent file IDs. Foundation
            // supplies a per-user replacement directory on the index's volume.
            let path = replacement_directory(index_path)?;
            let dir = open_directory(&path.0)?;
            Self::from_directory(path, dir)?
        };
        if workspace.directory.metadata()?.dev() != source.metadata()?.dev() {
            return Err(io::Error::other(
                "The private index workspace is on a different volume. Stage the resolution with Git.",
            ));
        }
        let probe = tempfile::tempfile_in(workspace.as_ref())?;
        copy_file_access(&source, &probe).map_err(|error| {
            io::Error::new(error.kind(), format!("Could not preserve the Git index access rules. Ask its owner to stage the resolution or correct the index permissions before retrying. {error}"))
        })?;
        Ok(workspace)
    }

    fn from_directory(path: EmptyDirectory, directory: File) -> io::Result<Self> {
        if std::fs::read_dir(&path.0)?.next().is_some() {
            return Err(io::Error::other("The new index directory is not empty."));
        }
        privatize_new_directory(&directory)?;
        Ok(Self { path, directory })
    }
}

impl AsRef<Path> for Workspace {
    fn as_ref(&self) -> &Path {
        &self.path.0
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.as_ref().join("index.lock"));
        let _ = std::fs::remove_file(self.as_ref().join("index"));
    }
}

fn open_directory(path: &Path) -> io::Result<File> {
    File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
}

fn file_id_path(directory: &File) -> io::Result<PathBuf> {
    let metadata = directory.metadata()?;
    let path = id_path(&metadata);
    verify_file_id(&metadata, &open_directory(&path)?)?;
    Ok(path)
}

fn id_path(metadata: &std::fs::Metadata) -> PathBuf {
    PathBuf::from(format!("/.vol/{}/{}", metadata.dev(), metadata.ino()))
}

fn verify_file_id(metadata: &std::fs::Metadata, directory: &File) -> io::Result<()> {
    let resolved = directory.metadata()?;
    if resolved.dev() != metadata.dev() || resolved.ino() != metadata.ino() {
        return Err(io::Error::other(
            "Cannot resolve the index directory by file ID.",
        ));
    }
    Ok(())
}

fn replacement_directory(index_path: &Path) -> io::Result<EmptyDirectory> {
    use objc2_foundation::{NSFileManager, NSSearchPathDirectory, NSSearchPathDomainMask, NSURL};
    let item = NSURL::from_file_path(index_path).ok_or(io::ErrorKind::InvalidInput)?;
    let directory = NSFileManager::defaultManager()
        .URLForDirectory_inDomain_appropriateForURL_create_error(
            NSSearchPathDirectory::ItemReplacementDirectory,
            NSSearchPathDomainMask::UserDomainMask,
            Some(&item),
            true,
        )
        .map_err(|error| io::Error::other(error.to_string()))?;
    let path = EmptyDirectory(
        directory
            .to_file_path()
            .ok_or(io::ErrorKind::InvalidInput)?,
    );
    let parent = path.0.parent().ok_or(io::ErrorKind::InvalidInput)?;
    // Respect an administrator's changes to existing temporary-directory
    // permissions. Refuse unsafe storage rather than changing those permissions.
    trunk_git::macos_metadata::verify_private_directory(&open_directory(parent)?)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    #[test]
    fn failing_to_open_a_new_index_directory_removes_it() {
        let root = tempfile::tempdir().unwrap();
        let index = root.path().join("index");
        std::fs::write(&index, "").unwrap();
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone deny list,directory_inherit,only_inherit"])
                .arg(root.path())
                .status()
                .unwrap()
                .success()
        );

        assert!(super::Workspace::new(&index).is_err());

        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn serializing_the_index_follows_the_open_directory_across_a_rename() {
        let root = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(root.path()).unwrap();
        let file = std::path::Path::new("file");
        std::fs::write(root.path().join(file), "before").unwrap();
        let mut initial = repo.index().unwrap();
        initial.add_path(file).unwrap();
        initial.write().unwrap();
        let index_path = initial.path().unwrap().to_owned();
        let moved = repo.path().join("moved");
        let mut replacement = None;

        super::super::publish_index(&repo, &index_path, |index| {
            let workspace = std::fs::read_dir(repo.path())
                .unwrap()
                .flatten()
                .find(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("trunk-merge-index-")
                })
                .unwrap()
                .path();
            std::fs::rename(&workspace, &moved).unwrap();
            std::fs::create_dir(&workspace).unwrap();
            let replacement_index = workspace.join("index");
            std::fs::write(&replacement_index, "replacement").unwrap();
            replacement = Some(replacement_index);
            index.remove_path(file)?;
            Ok(())
        })
        .unwrap();

        assert!(git2::Index::open(&index_path).unwrap().is_empty());
        assert_eq!(std::fs::read(replacement.unwrap()).unwrap(), b"replacement");
        assert!(!moved.exists());
    }
}
