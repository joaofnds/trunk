# Phase 13: Remote Operations - Research

**Researched:** 2026-03-12
**Domain:** Git remote operations (fetch/pull/push) via subprocess with async progress streaming in Tauri 2
**Confidence:** HIGH

## Summary

Phase 13 adds git fetch, pull, and push operations to the Trunk app, along with a permanent status bar for progress/error feedback and a GitKraken-style toolbar. The backend must use `tokio::process::Command` (not `std::process::Command`) because remote operations can take seconds to minutes and require real-time stderr streaming for progress feedback. The frontend needs a new `remote-progress` Tauri event listener, a `StatusBar.svelte` component, and a `Toolbar.svelte` component.

The critical technical challenge is that git writes progress to stderr using `\r` (carriage return without newline) for in-place percentage updates. Standard `BufReader::lines()` splits only on `\n`, so it will buffer all progress updates until the operation completes. The solution is to read raw bytes and split on both `\r` and `\n`. Additionally, since stderr is piped (not a TTY), git suppresses progress by default -- the `--progress` flag must be passed explicitly to fetch/pull/push.

**Primary recommendation:** Use `tokio::process::Command` with piped stderr, `--progress` flag on all remote commands, and a custom byte-level reader that splits on `\r`/`\n` to emit per-line `remote-progress` Tauri events. Store the `Child` process handle in app state so the cancel button can call `child.kill()`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Permanent status bar at the bottom of the window -- always visible, not just during operations
- During remote ops: shows spinner + latest progress line (e.g., "Receiving objects: 45%")
- Cancel button ('X') appears in the status bar during running operations -- kills the git subprocess
- All remote trigger buttons are disabled while any remote operation is running (no concurrent ops)
- All errors display in the status bar (no dialogs) -- styled as warning/error
- Error persists until next operation replaces it (no auto-clear, no dismiss button)
- Auth failures include actionable hints (e.g., "Authentication failed -- check your SSH key or credential helper")
- Non-fast-forward push rejection includes a clickable "Pull now" action in the status bar that triggers pull
- Respects gitconfig settings for push.default and push.autoSetupRemote -- no app-level override
- If git push fails due to no upstream config, pass through git's native error (no auto-retry with -u)
- Push targets the branch's configured tracking remote, falling back to 'origin' only for new branches without config
- GitKraken-style centered toolbar in the header area: Pull, Push, Branch, Stash, Pop
- Pull has a side chevron dropdown with strategies: Fetch, Fast-forward if possible, Fast-forward only, Pull (rebase)
- Default Pull action (clicking the button, not chevron): respects gitconfig (pull.rebase, pull.ff settings)
- Branch button: opens create-branch dialog (reuses Phase 12 InputDialog)
- Stash button: triggers stash save (reuses Phase 11 stash_save command)
- Pop button: triggers stash pop (reuses Phase 11 stash_pop command)
- Undo/Redo deferred to Phase 14

### Claude's Discretion
- Status bar idle state content
- Exact toolbar button styling and icon choices
- Status bar implementation details (component structure, animation)
- How the pull dropdown chevron is built (native menu vs custom Svelte dropdown)
- Exact error message copy for each error type
- How cancel kills the subprocess (SIGTERM vs SIGKILL, cleanup)

### Deferred Ideas (OUT OF SCOPE)
- Undo/Redo buttons in toolbar -- Phase 14 (TOOLBAR-02, TOOLBAR-03)
- Ahead/behind counts in sidebar -- Phase 14 (TRACK-01, TRACK-02)
- Force push with --force-with-lease -- v0.4+ (REMOTE-05)
- Pull rebase strategy as default -- v0.4+ (REMOTE-06, though dropdown exposes it now)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| REMOTE-01 | User can fetch all remotes with per-line progress feedback | `git fetch --all --progress` with tokio async stderr streaming; `--progress` required because piped stderr is non-TTY |
| REMOTE-02 | User can pull the current branch (merge strategy) | `git pull --progress` respecting gitconfig pull.rebase/pull.ff; graph refresh via `repo-changed` event after completion |
| REMOTE-03 | User can push the current branch (auto-sets upstream for new branches) | `git push --progress` respecting gitconfig push.default/push.autoSetupRemote; no app-level -u override per user decision |
| REMOTE-04 | User sees actionable error messages for auth failures and non-fast-forward rejections | Stderr parsing for error taxonomy: auth_failure, non_fast_forward, upstream_not_set, generic_error |
| TOOLBAR-01 | Quick actions bar visible at top with Pull, Push, Branch, Stash, Pop | Centered toolbar component; Pull dropdown with fetch/ff/rebase strategies; Branch/Stash/Pop reuse existing commands |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tokio (via tauri) | 1.50.0 | Async process spawning + stderr streaming | Already a transitive dependency through Tauri 2; provides `tokio::process::Command` |
| tauri | 2.x | Event emission (`app.emit`), command registration | Existing app framework |
| svelte | 5.x | Frontend components (StatusBar, Toolbar) | Existing UI framework |
| @tauri-apps/api/event | 2.x | `listen()` for `remote-progress` events | Already used for `repo-changed` events |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| serde/serde_json | 1.x | Serialize progress/error events to frontend | Already in Cargo.toml |

### No New Dependencies Required
The project already has all necessary dependencies. `tokio` is available as a transitive dependency through Tauri. The only change needed is adding `tokio` as an explicit dependency in `Cargo.toml` with the `process` and `io-util` features to use `tokio::process::Command` and `tokio::io::AsyncBufReadExt`.

**Installation:**
```toml
# Add to [dependencies] in src-tauri/Cargo.toml
tokio = { version = "1", features = ["process", "io-util"] }
```

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/commands/
    remote.rs           # NEW: git_fetch, git_pull, git_push commands
    mod.rs              # Add: pub mod remote;

src-tauri/src/state.rs  # Add: RunningOp state for cancel support

src/components/
    StatusBar.svelte    # NEW: permanent bottom bar with progress/error
    Toolbar.svelte      # NEW: centered header toolbar
    PullDropdown.svelte # NEW: chevron dropdown for pull strategies (optional split)

src/App.svelte          # Modified: add StatusBar + Toolbar to layout
```

### Pattern 1: Async Subprocess with Stderr Streaming
**What:** Spawn git via `tokio::process::Command`, pipe stderr, read progress line-by-line, emit Tauri events.
**When to use:** All remote operations (fetch, pull, push).
**Why not spawn_blocking:** Unlike cherry-pick/revert which use `std::process::Command::output()` (blocking, waits for completion), remote ops need real-time progress streaming. `tokio::process::Command` is natively async and supports piped I/O with `tokio::io::BufReader`.

**Example:**
```rust
// Source: tokio docs + Tauri event pattern
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};

async fn run_git_remote(
    args: &[&str],
    cwd: &std::path::Path,
    app: &tauri::AppHandle,
    repo_path: &str,
) -> Result<(), TrunkError> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))?;

    // Store child PID for cancellation
    // (store in app state before reading stderr)

    let stderr = child.stderr.take()
        .ok_or_else(|| TrunkError::new("io_error", "Failed to capture stderr"))?;

    let reader = BufReader::new(stderr);
    let mut lines = reader.lines(); // splits on \n

    while let Ok(Some(line)) = lines.next_line().await {
        // Git progress uses \r for in-place updates within a line.
        // lines() splits on \n, so a single "line" may contain multiple
        // \r-separated progress updates. Take the last segment.
        let display = line.rsplit('\r').next().unwrap_or(&line).trim();
        if !display.is_empty() {
            let _ = app.emit("remote-progress", serde_json::json!({
                "path": repo_path,
                "line": display,
            }));
        }
    }

    let status = child.wait().await
        .map_err(|e| TrunkError::new("process_error", e.to_string()))?;

    if !status.success() {
        // Collect any remaining stderr for error classification
        // (already consumed above, so collect during streaming)
        return Err(classify_git_error(&collected_stderr));
    }

    Ok(())
}
```

### Pattern 2: Error Taxonomy from Git Stderr
**What:** Classify git stderr into structured error codes for the frontend.
**When to use:** After any failed remote operation.

**Example:**
```rust
fn classify_git_error(stderr: &str) -> TrunkError {
    let lower = stderr.to_lowercase();

    if lower.contains("authentication failed")
        || lower.contains("permission denied")
        || lower.contains("could not read from remote")
        || lower.contains("host key verification failed")
        || lower.contains("connection refused")
    {
        TrunkError::new("auth_failure", stderr.to_owned())
    } else if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("failed to push some refs")
    {
        TrunkError::new("non_fast_forward", stderr.to_owned())
    } else if lower.contains("no upstream")
        || lower.contains("has no upstream branch")
        || lower.contains("the current branch .* has no upstream")
    {
        TrunkError::new("no_upstream", stderr.to_owned())
    } else {
        TrunkError::new("remote_error", stderr.to_owned())
    }
}
```

### Pattern 3: Running Operation State for Cancel + Mutual Exclusion
**What:** Store the running child process handle in Tauri managed state so cancel button can kill it and concurrent ops are prevented.
**When to use:** All remote operations share a single `RunningOp` slot.

**Example:**
```rust
use std::sync::Mutex;
use tokio::process::Child;

pub struct RunningOp(pub Mutex<Option<u32>>); // Store PID, not Child (Child is not Send)

// In the command: store PID before streaming
let pid = child.id();
if let Some(pid) = pid {
    *running_op.0.lock().unwrap() = Some(pid);
}

// Cancel command:
#[tauri::command]
pub async fn cancel_remote_op(running_op: State<'_, RunningOp>) -> Result<(), String> {
    if let Some(pid) = running_op.0.lock().unwrap().take() {
        unsafe { libc::kill(pid as i32, libc::SIGTERM); }
    }
    Ok(())
}
```

**Alternative (simpler):** Use `tokio::sync::Mutex<Option<tokio::process::Child>>` directly if Child can be held across await points. However, `Child` is not `Sync`, so wrapping in `Arc<Mutex<>>` is needed. The PID approach is simpler.

### Pattern 4: Toolbar with Pull Dropdown
**What:** Centered toolbar with buttons, where Pull has a chevron that opens a dropdown with strategy options.
**When to use:** Toolbar.svelte component.
**Recommendation for dropdown:** Use a custom Svelte dropdown (not native `<select>`) for consistent styling. A small absolutely-positioned panel that appears on chevron click, with click-outside-to-close.

### Anti-Patterns to Avoid
- **Using `std::process::Command::output()` for remote ops:** This blocks until completion with no progress streaming. Use `tokio::process::Command` instead.
- **Forgetting `--progress` flag:** Without it, git suppresses progress when stderr is piped (non-TTY). All fetch/pull/push commands MUST include `--progress`.
- **Using `BufReader::lines()` alone for progress:** Git sends `\r`-separated progress updates within a single `\n`-terminated chunk. `lines()` works but each "line" may contain multiple `\r`-separated updates. Parse accordingly.
- **Holding `Child` in `Mutex<Option<Child>>`:** `tokio::process::Child` is `!Sync`. Store the PID instead, or use `tokio::sync::Mutex`.
- **Allowing concurrent remote ops:** User decision says all remote buttons disabled during any running op. Enforce in both backend (check RunningOp state) and frontend (disable buttons).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Async process management | Manual thread + pipe handling | `tokio::process::Command` | Handles async I/O, signal delivery, process cleanup |
| Line-by-line async reading | Manual byte buffer management | `tokio::io::BufReader` + `AsyncBufReadExt::lines()` | Built-in buffering, handles partial reads |
| Event emission | Custom IPC channel | `app.emit("remote-progress", payload)` | Established Tauri pattern, already used for `repo-changed` |
| Create branch dialog | New dialog component | Existing `InputDialog.svelte` | User decision: reuse Phase 12 InputDialog |
| Stash save/pop | New commands | Existing `stash_save`/`stash_pop` commands | User decision: toolbar buttons call existing commands |

## Common Pitfalls

### Pitfall 1: Git Suppresses Progress in Non-TTY
**What goes wrong:** `git fetch`/`pull`/`push` produce no progress output when stderr is piped.
**Why it happens:** Git detects that stderr is not a terminal and suppresses progress by default.
**How to avoid:** Always pass `--progress` flag to fetch, pull, and push commands.
**Warning signs:** Status bar never shows progress, only final result.

### Pitfall 2: Carriage Return Progress Updates
**What goes wrong:** Progress appears as a single long string instead of updating in place.
**Why it happens:** Git writes "Receiving objects: 45%\rReceiving objects: 46%\r..." -- `lines()` returns this as one line when `\n` finally comes.
**How to avoid:** After reading each line from `lines()`, split on `\r` and take the last non-empty segment as the current progress.
**Warning signs:** Status bar shows concatenated progress percentages.

### Pitfall 3: Subprocess Blocks on stdin
**What goes wrong:** Git hangs waiting for username/password prompt.
**Why it happens:** Without `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND=ssh -o BatchMode=yes`, git may prompt for credentials.
**How to avoid:** Set both env vars on ALL subprocess invocations. This is already established in `commit_actions.rs` for cherry-pick/revert.
**Warning signs:** App freezes during remote operation with no progress or error.

### Pitfall 4: SSH_AUTH_SOCK Missing When Launched from Finder
**What goes wrong:** SSH-based remotes fail with auth error when app is launched from macOS Finder/Dock.
**Why it happens:** GUI apps on macOS don't inherit the shell's SSH agent environment variables.
**How to avoid:** Document as known limitation for v0.3 (per STATE.md blocker note). Do NOT attempt to fix.
**Warning signs:** SSH remote ops work in `cargo tauri dev` but fail in production build.

### Pitfall 5: Zombie Process on Cancel
**What goes wrong:** Cancelled git process becomes a zombie or leaves lock files.
**Why it happens:** Sending SIGKILL doesn't let git clean up. Git may hold `.git/index.lock`.
**How to avoid:** Send SIGTERM first (allows graceful shutdown). If process doesn't exit within 2 seconds, escalate to SIGKILL. After cancel, check for and clean up stale lock files.
**Warning signs:** "Unable to create '.git/index.lock': File exists" error after cancelling.

### Pitfall 6: Race Condition on Graph Refresh
**What goes wrong:** Graph cache is stale after remote op completes.
**Why it happens:** Remote commands don't update the CommitCache before emitting `repo-changed`.
**How to avoid:** Follow established pattern: rebuild graph via `walk_commits`, insert into CommitCache, THEN emit `repo-changed`.
**Warning signs:** Graph doesn't update after pull/push until manual refresh.

## Code Examples

### Tauri Command Registration (lib.rs)
```rust
// Add to invoke_handler in lib.rs
commands::remote::git_fetch,
commands::remote::git_pull,
commands::remote::git_push,
commands::remote::cancel_remote_op,
```

### Frontend Event Listener for Progress
```typescript
// Source: established pattern from App.svelte repo-changed listener
import { listen } from '@tauri-apps/api/event';

// In StatusBar.svelte
let progressLine = $state('');
let isRunning = $state(false);
let errorState = $state<{ code: string; message: string } | null>(null);

$effect(() => {
  let unlisten: (() => void) | undefined;
  listen<{ path: string; line: string }>('remote-progress', (event) => {
    if (event.payload.path === repoPath) {
      progressLine = event.payload.line;
      isRunning = true;
    }
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
});
```

### Pull Dropdown Strategies
```typescript
// Pull dropdown options map to git commands:
const PULL_STRATEGIES = [
  { label: 'Fetch', command: 'git_fetch' },
  { label: 'Fast-forward if possible', command: 'git_pull', args: { strategy: 'ff' } },
  { label: 'Fast-forward only', command: 'git_pull', args: { strategy: 'ff-only' } },
  { label: 'Pull (rebase)', command: 'git_pull', args: { strategy: 'rebase' } },
] as const;

// Default Pull button (no chevron) uses no strategy override -- respects gitconfig
```

### Git Command Arguments
```rust
// Fetch all remotes
["fetch", "--all", "--progress"]

// Pull (default -- respects gitconfig)
["pull", "--progress"]

// Pull (fast-forward if possible)
["pull", "--ff", "--progress"]

// Pull (fast-forward only)
["pull", "--ff-only", "--progress"]

// Pull (rebase)
["pull", "--rebase", "--progress"]

// Push (default -- respects gitconfig push.default, push.autoSetupRemote)
["push", "--progress"]
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `std::process::Command::output()` | `tokio::process::Command` with piped stderr | This phase | Enables real-time progress streaming |
| Sync blocking git calls | Async git subprocess with event streaming | This phase | New pattern for long-running git ops |
| No status feedback | Permanent StatusBar with progress/error | This phase | UX improvement for remote operations |

**New patterns introduced in this phase:**
- `tokio::process::Command` for async subprocess (extends existing `std::process::Command` pattern)
- `remote-progress` Tauri event (extends existing `repo-changed` event pattern)
- `RunningOp` managed state for cancel support (new state type alongside `RepoState`, `CommitCache`)
- Toolbar component (new UI element in header area)

## Open Questions

1. **tokio dependency features**
   - What we know: tokio 1.50 is already a transitive dependency through Tauri
   - What's unclear: Whether adding it as explicit dependency with `process` feature causes version conflicts
   - Recommendation: Add `tokio = { version = "1", features = ["process", "io-util"] }` to Cargo.toml. Cargo will deduplicate with the transitive version. Test with `cargo check` early.

2. **Child process cancel mechanics**
   - What we know: `child.kill()` sends SIGKILL (no cleanup). SIGTERM via `libc::kill` is more graceful.
   - What's unclear: Whether SIGTERM is sufficient for git to clean up lock files
   - Recommendation: Use SIGTERM. If git leaves `.git/index.lock`, that's acceptable for v0.3 -- user can manually delete or relaunch.

3. **Pull dropdown: Svelte custom dropdown vs native**
   - What we know: User left as Claude's discretion
   - Recommendation: Custom Svelte dropdown for consistent styling. A simple absolutely-positioned `<div>` with click-outside handler. Matches GitKraken's visual style better than native OS menu.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in test (cargo test) |
| Config file | Cargo.toml (existing) |
| Quick run command | `cd src-tauri && cargo test --lib commands::remote` |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REMOTE-01 | Fetch all remotes | integration | `cd src-tauri && cargo test commands::remote::tests::fetch` | No -- Wave 0 |
| REMOTE-02 | Pull current branch | integration | `cd src-tauri && cargo test commands::remote::tests::pull` | No -- Wave 0 |
| REMOTE-03 | Push current branch | integration | `cd src-tauri && cargo test commands::remote::tests::push` | No -- Wave 0 |
| REMOTE-04 | Error classification | unit | `cd src-tauri && cargo test commands::remote::tests::classify` | No -- Wave 0 |
| TOOLBAR-01 | Toolbar renders buttons | manual-only | Manual: verify toolbar appears with correct buttons | N/A |

**Note on remote command testing:** Unlike stash/branch tests which use local repos, remote tests require a remote to fetch from/push to. Tests should create a bare repo as "remote" and a clone as "local" using `git2::Repository::init_bare` + `git clone`. This is a standard pattern for testing git remote operations.

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test --lib commands::remote`
- **Per wave merge:** `cd src-tauri && cargo test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/remote.rs` -- new file with `_inner` functions + tests
- [ ] Test helper: `make_test_repo_with_remote()` -- creates bare remote + clone pair
- [ ] Error classification unit tests -- verify stderr patterns map to correct error codes

## Sources

### Primary (HIGH confidence)
- Project codebase: `commit_actions.rs`, `stash.rs`, `branches.rs` -- established patterns for git CLI subprocess, event emission, inner-fn testing
- Project codebase: `App.svelte`, `StagingPanel.svelte` -- established `listen()` pattern for Tauri events
- [tokio::process docs](https://docs.rs/tokio/latest/tokio/process/index.html) -- async Command API
- [tokio::io::AsyncBufReadExt](https://docs.rs/tokio/latest/tokio/io/trait.AsyncBufReadExt.html) -- lines() method, \r\n handling
- [Git fetch docs](https://git-scm.com/docs/git-fetch) -- --progress flag behavior with non-TTY stderr
- [Git push docs](https://git-scm.com/docs/git-push) -- push.default, non-fast-forward error format

### Secondary (MEDIUM confidence)
- [Tauri async patterns](https://rfdonnelly.github.io/posts/tauri-async-rust-process/) -- AppHandle + event emission from spawned tasks
- [tokio Child::kill issue #2504](https://github.com/tokio-rs/tokio/issues/2504) -- SIGKILL vs SIGTERM on child process drop
- [GitHub Docs: non-fast-forward](https://docs.github.com/en/get-started/using-git/dealing-with-non-fast-forward-errors) -- stderr error message format

### Tertiary (LOW confidence)
- Git progress `\r` carriage return behavior -- based on practical knowledge of git output format; not formally documented. Verified indirectly via git-scm.com sideband protocol docs.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies needed beyond tokio features; all patterns extend existing codebase
- Architecture: HIGH -- async subprocess streaming is well-documented in tokio; Tauri event emission is established pattern in project
- Pitfalls: HIGH -- git stderr suppression in non-TTY is documented; SSH_AUTH_SOCK issue noted in STATE.md
- Error taxonomy: MEDIUM -- error message patterns based on common git output; may need tuning for edge cases

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable domain -- git CLI and tokio APIs change slowly)
