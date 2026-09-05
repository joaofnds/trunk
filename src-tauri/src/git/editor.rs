//! Single-shot temp-editor helper for `GIT_EDITOR` plumbing.
//!
//! Builds a shell script + message file pair under `std::env::temp_dir()` so
//! Phase 76 callers (`merge --continue`, `merge <branch>`, `revert <oid>`) can
//! hand git a pre-filled commit message via `GIT_EDITOR=<script>`. The
//! returned [`EditorHandle`] owns both files and removes them on `Drop` —
//! including the early-return path where the handle leaves scope on `?`.
//!
//! [`keyed_rebase_editor`] covers the other shape: an interactive rebase, where
//! git decides how many times the editor runs and for which commit, so the
//! message cannot be chosen up front.
//!
//! # Usage (Phase 76)
//!
//! ```ignore
//! let handle = trunk_lib::git::editor::prepare("Merge branch 'foo'")?;
//! std::process::Command::new("git")
//!     .env("GIT_EDITOR", handle.script_path())
//!     .args(["merge", "--continue"])
//!     .status()?;
//! // handle drops here; both temp files are removed.
//! ```

use std::path::{Path, PathBuf};

use crate::error::TrunkError;

/// Owns the two temp files (`script` + `msg`) backing one `GIT_EDITOR` invocation.
///
/// `Drop` removes both files unconditionally so the early-return path
/// (`prepare()?` followed by an immediate `?` on the next call) leaves no
/// orphan temp files (MSG-05, D-07).
pub struct EditorHandle {
    script_path: PathBuf,
    msg_path: PathBuf,
}

impl EditorHandle {
    /// Path callers pass to `Command::env("GIT_EDITOR", _)`.
    #[must_use]
    pub fn script_path(&self) -> &Path {
        &self.script_path
    }

    /// Internal accessor for the message file. Tests assert on its contents.
    /// Not part of the Phase 76 public API.
    #[cfg(test)]
    pub(crate) fn msg_path(&self) -> &Path {
        &self.msg_path
    }
}

impl Drop for EditorHandle {
    fn drop(&mut self) {
        // Best-effort cleanup — Drop cannot return Result, and any leftover
        // file in temp_dir() is reaped by the OS eventually.
        let _ = std::fs::remove_file(&self.script_path);
        let _ = std::fs::remove_file(&self.msg_path);
    }
}

/// Build the script + message file pair, returning a handle that owns cleanup.
///
/// The message file contains `message` verbatim — no whitespace stripping, no
/// comment-line removal. Phase 76 callers build the default backend-side and
/// hand it to git via the shell script's `cp <msg> "$1"` invocation (MSG-04).
///
/// On any internal failure, partial state is cleaned up before returning
/// `Err` — the `Drop` impl only runs once `EditorHandle` is constructed, so
/// the pre-construction window is handled by hand inside this function.
///
/// # Errors
///
/// Returns `io_error` when the message file or the editor script will not
/// write. Partial state is cleaned up first.
pub fn prepare(message: &str) -> Result<EditorHandle, TrunkError> {
    // T-75-T01 hard mitigation: write through the `tempfile::Builder::tempfile()`
    // file handle BEFORE `.keep()` hands the path back. This preserves the
    // O_EXCL guarantee of the original open and closes the symlink-swap window
    // that a path-based `std::fs::write` would introduce. Default Unix
    // permissions on both files are 0o600 from tempfile creation, sufficient
    // for T-75-T02 since only this process and its git child (same uid) need
    // to read them.
    let msg_path = write_temp_file("trunk-editor-msg-", "", message.as_bytes())?;

    // T-75-T04: msg path is POSIX single-quoted, so embedded `"` or `'` in
    // `$TMPDIR` cannot terminate the quoted segment. Mirrors the helper
    // shared with interactive_rebase.rs.
    let script_body = format!(
        "#!/bin/sh\ncp {} \"$1\"\n",
        shell_single_quote(&msg_path.display().to_string()),
    );

    let script_path =
        match write_executable_temp_file("trunk-editor-", ".sh", script_body.as_bytes()) {
            Ok(p) => p,
            Err(e) => {
                let _ = std::fs::remove_file(&msg_path);
                return Err(e);
            }
        };

    Ok(EditorHandle {
        script_path,
        msg_path,
    })
}

/// Directory of pre-edited interactive-rebase messages, one file per commit,
/// named by full OID, resolved against the repository's git dir.
///
/// The keyed editor script below finds it with `git rev-parse --git-path`, so
/// this constant is the only place the name is written.
pub const MESSAGE_DIR: &str = "trunk-rebase-msgs";

/// The editor `git rebase -i` runs for every reword and every run of squashes.
///
/// It asks git which todo item it was invoked for — the last line of
/// `rebase-merge/done` is that item, echoed from the todo we wrote — and applies
/// the message filed under that commit, if there is one. Nothing here counts
/// invocations or assumes an order, because git guarantees neither: a run of
/// squashes opens the editor once, at its last item, and a skipped item opens it
/// not at all.
///
/// The only value substituted in is [`MESSAGE_DIR`], a constant — no path and
/// nothing a user typed reaches the script, so there is no shell-quoting hazard
/// here. Every path exits 0: a commit with no filed message keeps whatever
/// default git prepared.
const KEYED_REBASE_EDITOR: &str = r#"#!/bin/sh
DIR=$(git rev-parse --git-path @MESSAGE_DIR@)
DONE=$(git rev-parse --git-path rebase-merge/done)
OID=$(tail -n 1 "$DONE" 2>/dev/null | awk '{print $2}')
if [ -n "$OID" ] && [ -f "$DIR/$OID" ]; then
  cat "$DIR/$OID" > "$1"
fi
exit 0
"#;

/// Owns the temp script backing one `GIT_EDITOR=<script>` rebase run.
///
/// The script is per-invocation and lives at 0755 under `temp_dir()`; the
/// messages it reads live under the repository's git dir, because a conflicted
/// rebase outlives the call that started it.
pub struct KeyedEditor {
    script_path: PathBuf,
}

impl KeyedEditor {
    /// Path callers pass to `Command::env("GIT_EDITOR", _)`.
    #[must_use]
    pub fn script_path(&self) -> &Path {
        &self.script_path
    }
}

impl Drop for KeyedEditor {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.script_path);
    }
}

/// Write the keyed editor script and hand back a handle that removes it on drop.
///
/// # Errors
///
/// Returns `io_error` when the script will not write.
pub fn keyed_rebase_editor() -> Result<KeyedEditor, TrunkError> {
    let script = KEYED_REBASE_EDITOR.replace("@MESSAGE_DIR@", MESSAGE_DIR);
    let script_path = write_executable_temp_file("trunk-rebase-editor-", ".sh", script.as_bytes())?;
    Ok(KeyedEditor { script_path })
}

/// POSIX-safe single-quoting: wrap in `'…'` and replace embedded `'` with `'\''`.
///
/// Used by both `prepare()` here and `interactive_rebase` for shell-script
/// interpolation of paths rooted at `$TMPDIR`, which a user could in principle
/// set to a path containing `"` or `'`.
pub(crate) fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Reserve a unique temp file and write `contents` through the open file
/// handle returned by `tempfile`, then `.keep()` the path. Writing before
/// `.keep()` is what gives us the `O_EXCL` guarantee.
fn write_temp_file(prefix: &str, suffix: &str, contents: &[u8]) -> Result<PathBuf, TrunkError> {
    use std::io::Write;
    let mut tf = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(suffix)
        .tempfile()
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    tf.write_all(contents)
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    let (_file, path) = tf
        .keep()
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    Ok(path)
}

/// Same as `write_temp_file`, but chmods the resulting file to 0o755 via the
/// open file handle on Unix (no path-based re-permission window).
fn write_executable_temp_file(
    prefix: &str,
    suffix: &str,
    contents: &[u8],
) -> Result<PathBuf, TrunkError> {
    use std::io::Write;
    let mut tf = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(suffix)
        .tempfile()
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    tf.write_all(contents)
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tf.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o755))
            .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    }

    let (_file, path) = tf
        .keep()
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn script_file_is_created_with_executable_permissions() {
        let handle = prepare("hello").expect("prepare() must succeed on happy path");

        assert!(
            handle.script_path().exists(),
            "script file must exist after prepare()",
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(handle.script_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o755, "script file must be chmod 0o755 (D-09)");
        }
    }

    #[test]
    fn script_file_contains_shebang_and_cp_invocation() {
        let handle = prepare("ignored").expect("prepare() must succeed");
        let script = fs::read_to_string(handle.script_path()).unwrap();

        assert!(
            script.starts_with("#!/bin/sh\n"),
            "script must start with shebang, got: {script:?}",
        );

        let msg_path_str = handle.msg_path().display().to_string();
        let expected_cp = format!("cp {} \"$1\"", shell_single_quote(&msg_path_str));
        assert!(
            script.contains(&expected_cp),
            "script must contain shell-quoted cp pattern {expected_cp:?} (T-75-T04 mitigation), got: {script:?}",
        );
    }

    #[test]
    fn keyed_editor_script_reads_the_directory_the_rebase_writes() {
        let editor = keyed_rebase_editor().expect("keyed_rebase_editor() must succeed");
        let script = fs::read_to_string(editor.script_path()).unwrap();

        assert!(
            script.contains(MESSAGE_DIR),
            "the script must look in the directory interactive_rebase files messages in, got: {script:?}",
        );
        assert!(
            !script.contains("@MESSAGE_DIR@"),
            "placeholder must be substituted, got: {script:?}",
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(editor.script_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o755, "git has to be able to execute it");
        }
    }

    #[test]
    fn keyed_editor_script_is_removed_when_the_handle_leaves_scope() {
        let script_path = {
            let editor = keyed_rebase_editor().expect("keyed_rebase_editor() must succeed");
            editor.script_path().to_path_buf()
        };

        assert!(
            !script_path.exists(),
            "an early return must not leak an executable script",
        );
    }

    #[test]
    fn shell_single_quote_wraps_plain_paths() {
        assert_eq!(shell_single_quote("/tmp/foo"), "'/tmp/foo'");
    }

    #[test]
    fn shell_single_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_single_quote("/tmp/it's/foo"), "'/tmp/it'\\''s/foo'");
    }

    #[test]
    fn shell_single_quote_passes_double_quotes_through_inert() {
        assert_eq!(shell_single_quote("/tmp/a\"b"), "'/tmp/a\"b'");
    }

    #[test]
    fn message_file_contains_payload_verbatim_including_newlines_and_pound_signs() {
        let payload = "Merge branch 'foo'\n\n# preserved verbatim, no comment stripping\n";
        let handle = prepare(payload).expect("prepare() must succeed");

        let written = fs::read_to_string(handle.msg_path()).unwrap();
        assert_eq!(
            written, payload,
            "message file must contain payload verbatim (MSG-04: defaults flow through unchanged)",
        );
    }

    #[test]
    fn message_file_contains_empty_string_when_prepared_with_empty_payload() {
        let handle = prepare("").expect("prepare() must succeed even with empty payload");
        let written = fs::read_to_string(handle.msg_path()).unwrap();
        assert_eq!(written, "", "empty payload must yield empty msg file");
    }

    #[test]
    fn drop_removes_both_files_on_happy_path() {
        let handle = prepare("x").expect("prepare() must succeed");
        let script_path = handle.script_path().to_path_buf();
        let msg_path = handle.msg_path().to_path_buf();

        assert!(script_path.exists(), "script file must exist before drop");
        assert!(msg_path.exists(), "msg file must exist before drop");

        drop(handle);

        assert!(
            !script_path.exists(),
            "script file must be removed on Drop (MSG-05)",
        );
        assert!(
            !msg_path.exists(),
            "msg file must be removed on Drop (MSG-05)",
        );
    }

    #[test]
    fn drop_removes_both_files_when_handle_leaves_scope() {
        // Models Phase 76's `?` early-return path: the handle is constructed
        // and immediately goes out of scope when the next call returns Err.
        let (script_path, msg_path) = {
            let handle = prepare("x").expect("prepare() must succeed");
            (
                handle.script_path().to_path_buf(),
                handle.msg_path().to_path_buf(),
            )
        };

        assert!(
            !script_path.exists(),
            "script file must be removed when handle leaves scope",
        );
        assert!(
            !msg_path.exists(),
            "msg file must be removed when handle leaves scope",
        );
    }

    #[test]
    fn temp_paths_live_under_system_temp_dir() {
        let handle = prepare("x").expect("prepare() must succeed");
        let temp_dir = std::env::temp_dir();

        // Canonicalize to handle symlinked /tmp → /private/tmp on macOS.
        let temp_canonical = fs::canonicalize(&temp_dir).unwrap_or(temp_dir);
        let script_canonical = fs::canonicalize(handle.script_path())
            .unwrap_or_else(|_| handle.script_path().to_path_buf());
        let msg_canonical =
            fs::canonicalize(handle.msg_path()).unwrap_or_else(|_| handle.msg_path().to_path_buf());

        assert!(
            script_canonical.starts_with(&temp_canonical),
            "script path must live under temp_dir() (T-75-T01 TOCTOU mitigation): \
             script={script_canonical:?} temp_dir={temp_canonical:?}",
        );
        assert!(
            msg_canonical.starts_with(&temp_canonical),
            "msg path must live under temp_dir() (T-75-T01 TOCTOU mitigation): \
             msg={msg_canonical:?} temp_dir={temp_canonical:?}",
        );
    }

    #[test]
    fn multiple_prepare_calls_produce_distinct_paths() {
        let a = prepare("a").expect("first prepare() must succeed");
        let b = prepare("b").expect("second prepare() must succeed");

        assert_ne!(
            a.script_path(),
            b.script_path(),
            "distinct calls must yield distinct script paths (no fixed names)",
        );
        assert_ne!(
            a.msg_path(),
            b.msg_path(),
            "distinct calls must yield distinct msg paths (no fixed names)",
        );
    }

    // Note on the partial-cleanup invariant (D-07):
    //
    // `prepare()` must clean up partially-created files if it fails mid-way
    // (e.g. msg write succeeds but script write fails). The `Drop` impl only
    // runs once `EditorHandle` has been constructed; the pre-construction
    // window is the helper's own responsibility.
    //
    // Injecting a deterministic failure (e.g. blocking chmod by mounting the
    // path as a read-only directory) requires more test scaffolding than the
    // cleanup branch itself, and OS behaviour varies across CI runners. The
    // invariant is documented in code via the per-step cleanup arms inside
    // `prepare()` and the `T-75-T05` row of the plan's threat model. Skipping
    // the test here per the executor decision called out in the PLAN
    // (Task 1 behavior, last bullet).
}
