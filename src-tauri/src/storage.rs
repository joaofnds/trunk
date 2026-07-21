//! Shared durable-file primitives: atomic JSON writes and corrupt-file
//! quarantine. Both the review-session store and the prefs store persist
//! JSON files; this module keeps the durability behavior in one place.

use crate::error::TrunkError;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

/// Atomic write: tmp-in-same-dir + `sync_all` + `rename` (D-10, Pitfall 5).
/// `rename` is only atomic within a filesystem, so the tmp file lives next to
/// the target. `create_dir_all` covers the first-write case (Pitfall 2).
pub(crate) fn atomic_write_json(final_path: &Path, json: &str) -> Result<(), TrunkError> {
    let dir = final_path
        .parent()
        .ok_or_else(|| TrunkError::new("bad_path", "target path has no parent dir"))?;
    fs::create_dir_all(dir).map_err(|e| TrunkError::new("io", e.to_string()))?;

    let tmp_path = final_path.with_extension("json.tmp");
    {
        let mut f = File::create(&tmp_path).map_err(|e| TrunkError::new("io", e.to_string()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| TrunkError::new("io", e.to_string()))?;
        f.sync_all()
            .map_err(|e| TrunkError::new("io", e.to_string()))?;
    }
    fs::rename(&tmp_path, final_path).map_err(|e| TrunkError::new("io", e.to_string()))?;
    Ok(())
}

/// Rename a file we cannot read to a `.corrupt` sidecar — never delete it
/// (D-15), including earlier sidecars: an occupied name falls through to
/// `.json.corrupt-2`, `-3`, … instead of overwriting.
pub(crate) fn quarantine_corrupt(final_path: &Path) -> Result<(), TrunkError> {
    let mut corrupt = final_path.with_extension("json.corrupt");
    let mut n = 2;
    while corrupt.exists() {
        corrupt = final_path.with_extension(format!("json.corrupt-{n}"));
        n += 1;
    }
    fs::rename(final_path, corrupt).map_err(|e| TrunkError::new("io", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_second_quarantine_preserves_the_first_sidecar() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trunk-prefs.json");

        fs::write(&path, "first").unwrap();
        quarantine_corrupt(&path).unwrap();
        fs::write(&path, "second").unwrap();
        quarantine_corrupt(&path).unwrap();

        let mut contents: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| fs::read_to_string(e.unwrap().path()).unwrap())
            .collect();
        contents.sort();
        assert_eq!(contents, vec!["first".to_string(), "second".to_string()]);
    }
}
