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

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("trunk-perf-test-{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("samples.jsonl")
    }

    #[test]
    fn appending_creates_the_directory_and_writes_one_line_each() {
        let path = scratch("creates");

        append_samples(&path, &[r#"{"a":1}"#.into(), r#"{"a":2}"#.into()]).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "{\"a\":1}\n{\"a\":2}\n");
    }

    #[test]
    fn appending_keeps_what_is_already_there() {
        let path = scratch("appends");
        append_samples(&path, &[r#"{"a":1}"#.into()]).unwrap();

        append_samples(&path, &[r#"{"a":2}"#.into()]).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "{\"a\":1}\n{\"a\":2}\n");
    }

    #[test]
    fn truncating_empties_the_file_without_removing_it() {
        let path = scratch("truncates");
        append_samples(&path, &[r#"{"a":1}"#.into()]).unwrap();

        truncate_samples(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn truncating_a_file_that_was_never_written_is_not_an_error() {
        let path = scratch("truncate-missing");

        truncate_samples(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
    }
}
