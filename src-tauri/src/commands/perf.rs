//! Development-time performance instrumentation sink.
//!
//! The frontend buffers timing samples and hands them over in batches; this
//! appends them as JSON lines to a fixed path an agent can read while the app
//! is still running. Fixed rather than caller-supplied on purpose: the command
//! takes no path, so nothing on the frontend can direct a write elsewhere.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn samples_path() -> PathBuf {
    PathBuf::from("/tmp/trunk-perf/samples.jsonl")
}

fn append_samples(path: &Path, lines: &[String]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    for line in lines {
        writeln!(file, "{}", line)?;
    }

    Ok(())
}

fn truncate_samples(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }

    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;

    Ok(())
}

/// Inert outside a debug build: the frontend gate keeps it unreachable in a
/// release, and this makes that structural rather than a matter of trust.
#[tauri::command]
pub fn perf_append(lines: Vec<String>) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }

    append_samples(&samples_path(), &lines).map_err(|e| e.to_string())
}

/// Starts a fresh measurement session and answers where to read it.
#[tauri::command]
pub fn perf_reset() -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Ok(String::new());
    }

    let path = samples_path();
    truncate_samples(&path).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A private directory per call, so concurrent `cargo test` runs in one
    /// working tree cannot append to or delete each other's sample file.
    ///
    /// The sample file sits one level below the temp root, in a subdirectory
    /// that does not exist yet: that missing parent is what makes the
    /// directory-creating behaviour observable. The returned guard owns the
    /// temp root, so hold it for the whole test.
    fn scratch() -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trunk-perf").join("samples.jsonl");
        (dir, path)
    }

    #[test]
    fn appending_creates_the_directory_and_writes_one_line_each() {
        let (_dir, path) = scratch();

        assert!(!path.parent().unwrap().exists());

        append_samples(&path, &[r#"{"a":1}"#.into(), r#"{"a":2}"#.into()]).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "{\"a\":1}\n{\"a\":2}\n");
    }

    #[test]
    fn appending_keeps_what_is_already_there() {
        let (_dir, path) = scratch();
        append_samples(&path, &[r#"{"a":1}"#.into()]).unwrap();

        append_samples(&path, &[r#"{"a":2}"#.into()]).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "{\"a\":1}\n{\"a\":2}\n");
    }

    #[test]
    fn truncating_empties_the_file_without_removing_it() {
        let (_dir, path) = scratch();
        append_samples(&path, &[r#"{"a":1}"#.into()]).unwrap();

        truncate_samples(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn truncating_a_file_that_was_never_written_is_not_an_error() {
        let (_dir, path) = scratch();

        truncate_samples(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }
}
