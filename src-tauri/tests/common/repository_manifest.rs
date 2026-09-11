use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub struct RepositoryEntry {
    file_type: std::fs::FileType,
    len: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
}

/// Every repository path plus metadata a read-only operation must preserve.
/// Access times are excluded because walking the manifest can itself update
/// them on filesystems mounted without `noatime`.
pub fn repository_manifest(root: &Path) -> BTreeMap<PathBuf, RepositoryEntry> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt as _;

    fn visit(root: &Path, path: &Path, entries: &mut BTreeMap<PathBuf, RepositoryEntry>) {
        let metadata = std::fs::symlink_metadata(path).unwrap();
        entries.insert(
            path.strip_prefix(root).unwrap().to_path_buf(),
            RepositoryEntry {
                file_type: metadata.file_type(),
                len: metadata.len(),
                modified: metadata.modified().unwrap(),
                #[cfg(unix)]
                inode: metadata.ino(),
                #[cfg(unix)]
                changed: (metadata.ctime(), metadata.ctime_nsec()),
            },
        );

        if metadata.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() {
                visit(root, &entry.unwrap().path(), entries);
            }
        }
    }

    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}
