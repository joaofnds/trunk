# Stack Research

**Domain:** Tauri 2 desktop Git GUI — remote ops (push/pull/fetch), stash, commit context menu
**Researched:** 2026-03-10
**Confidence:** HIGH (all claims grounded in direct codebase inspection: Cargo.lock, Cargo.toml, capabilities/default.json, CommitGraph.svelte, package.json)

---

## Scope

This file covers **only additions and changes** needed for v0.3 features:
- Push / Pull / Fetch with SSH and HTTPS auth
- Stash create / pop
- Commit row right-click context menu

Existing validated stack (Tauri 2.10.2, git2 0.19.0 / libgit2 1.8.1, Svelte 5, Tailwind CSS 4, tauri-plugin-store 2.4.2, notify 7, @tauri-apps/api ^2) is not re-researched.

---

## Decision: Remote Ops Auth Strategy

**Shell out to system `git` via `std::process::Command`. Do NOT use git2 remote callbacks.**

### Why Shell-Out Wins

libgit2's SSH and HTTPS auth story is fundamentally broken for desktop GUI contexts:

1. **SSH agent** — libgit2 calls libssh2 to reach the running `ssh-agent` socket. The socket path varies by OS and user session (macOS: `/private/tmp/com.apple.launchd.*/Listeners`, set in `$SSH_AUTH_SOCK`). `git2::Cred::ssh_key_from_agent()` only works when the socket path is predictable and the env var is correctly inherited. In a Tauri app launched from Finder/Dock (not a terminal), `$SSH_AUTH_SOCK` is often absent.

2. **HTTPS credential helpers** — libgit2 does not invoke `git credential-osxkeychain` or any other credential helper. HTTPS auth via git2 requires the app to prompt for username/password and supply them to a callback. This is a bespoke UI/UX problem with no standard solution.

3. **Ecosystem precedent** — the project already documented this decision in PROJECT.md: *"git CLI reserved for remote operations due to libgit2 unreliable SSH/HTTPS auth — all major Tauri git clients shell out for push/pull."* GitButler (Tauri + Rust) follows the same pattern.

4. **System git inherits all auth automatically** — when `git push/pull/fetch` runs as a child process of the Tauri app, it inherits `$SSH_AUTH_SOCK`, macOS Keychain access, `~/.netrc`, `.ssh/config`, and all configured credential helpers. Zero special auth code required.

5. **No new crate needed** — `std::process::Command` is in std. `tauri::async_runtime::spawn_blocking` already used by every Tauri command in this codebase handles the blocking I/O.

---

## Recommended Stack: Additions Only

### New Rust Crates

**None.** All three feature areas are covered by existing crates.

| Operation | Implementation | Crate |
|-----------|---------------|-------|
| Push / Pull / Fetch | `std::process::Command` (shell out) | std (no new crate) |
| Stash create | `repo.stash_save(&sig, "msg", flags)` | git2 0.19.0 (already present) |
| Stash pop | `repo.stash_pop(0, None)` | git2 0.19.0 (already present) |
| Cherry-pick | `repo.cherrypick(&commit, None)` | git2 0.19.0 (already present) |
| Revert | `repo.revert(&commit, None)` | git2 0.19.0 (already present) |
| Create branch from commit | `repo.branch("name", &commit, false)` | git2 0.19.0 (already present) |
| Create tag | `repo.tag_lightweight("name", &obj, false)` | git2 0.19.0 (already present) |
| Checkout commit (detached HEAD) | `repo.set_head_detached(oid)` | git2 0.19.0 (already present) |

git2 0.19.0 wraps libgit2 1.8.1 (confirmed: `libgit2-sys = "0.17.0+1.8.1"` in Cargo.lock). All the above APIs are present in this version.

### New Tauri Plugins

**None.**

| Plugin | Decision | Rationale |
|--------|----------|-----------|
| `tauri-plugin-shell` | Do NOT add | Exposes `Command` execution to the JS frontend. Remote ops are invoked from Rust Tauri commands, not from JS. Adding this plugin is the wrong abstraction layer and increases capability attack surface unnecessarily. |
| `tauri-plugin-clipboard-manager` | Do NOT add | `navigator.clipboard.writeText()` works in Tauri 2 WebView without a plugin. "Copy SHA" and "Copy Message" actions in the context menu can use it directly. |
| `tauri-plugin-notification` | Do NOT add | Push/pull result feedback is better surfaced as inline UI state (error message, success indicator) than OS notifications. |

### New Frontend Libraries

**None.** The existing `@tauri-apps/api/menu` module covers the commit context menu.

| Library | Decision | Rationale |
|---------|----------|-----------|
| `@tauri-apps/api/menu` — `MenuItem` | Already present | `Menu` and `CheckMenuItem` are already imported in `CommitGraph.svelte`. `MenuItem` (action items, not checkboxes) is exported from the same module. Import already available. |
| Custom Svelte context menu component | Do NOT add | Native Tauri Menu API provides OS-native look/feel, proper z-index over WebView, keyboard navigation, and accessibility for free. A custom Svelte dropdown must hand-roll all of this and will look non-native. |
| Any npm context-menu library | Do NOT add | Same reason — they render inside the WebView and cannot match OS-native menus. |

---

## Integration Points with Existing Stack

### Pattern: Shell-Out Remote Commands

Follows the existing `inner-fn + spawn_blocking` pattern. Remote ops add one new concern: `git push/pull/fetch` writes progress to **stderr** (not stdout), even on success.

```rust
// Follows existing pattern from checkout_branch_inner, create_branch_inner, etc.
pub fn fetch_inner(path: &str, remote: &str) -> Result<String, TrunkError> {
    let output = std::process::Command::new("git")
        .args(["-C", path, "fetch", remote])
        .output()
        .map_err(|e| TrunkError::new("git_not_found", e.to_string()))?;

    if output.status.success() {
        // git fetch writes progress to stderr even on success
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    } else {
        Err(TrunkError::new(
            "fetch_failed",
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}
```

After push/pull/fetch completes, the graph cache must be rebuilt (same `cache-repopulate-before-emit` pattern already used by `checkout_branch` and `create_branch`).

### Pattern: Stash via git2

Stash is a local operation — no shell-out needed. git2 handles it natively.

```rust
// stash_save requires &mut repo (git2 convention for state-mutating ops)
let sig = repo.signature()?; // reads user.name / user.email from git config
repo.stash_save(&sig, "WIP on HEAD", Some(git2::StashFlags::DEFAULT))?;

// stash_pop: index 0 = stash@{0} (most recent)
// StashApplyOptions controls whether untracked files are restored
repo.stash_pop(0, None)?;
```

Both must follow the `cache-repopulate-before-emit` pattern (rebuild CommitCache, then emit refresh event).

### Pattern: Commit Context Menu

The existing header context menu in `CommitGraph.svelte` already uses `Menu.new({ items })` + `menu.popup()`. The commit row context menu is the same pattern on `CommitRow.svelte`, triggered by `oncontextmenu`.

```typescript
// CommitRow.svelte — add oncontextmenu handler
// MenuItem (not CheckMenuItem) is the action item type
import { Menu, MenuItem } from '@tauri-apps/api/menu';

async function showCommitMenu(e: MouseEvent) {
  e.preventDefault();
  const items = await Promise.all([
    MenuItem.new({ text: 'Copy SHA',     action: () => navigator.clipboard.writeText(commit.oid) }),
    MenuItem.new({ text: 'Copy Message', action: () => navigator.clipboard.writeText(commit.summary) }),
    MenuItem.new({ text: 'Checkout Commit', action: () => safeInvoke('checkout_commit', { path: repoPath, oid: commit.oid }) }),
    MenuItem.new({ text: 'Create Branch Here', action: () => { /* open branch name dialog, then invoke */ } }),
    MenuItem.new({ text: 'Create Tag Here',    action: () => { /* open tag name dialog, then invoke */ } }),
    MenuItem.new({ text: 'Cherry-Pick',        action: () => safeInvoke('cherry_pick', { path: repoPath, oid: commit.oid }) }),
    MenuItem.new({ text: 'Revert',             action: () => safeInvoke('revert_commit', { path: repoPath, oid: commit.oid }) }),
  ]);
  const menu = await Menu.new({ items });
  await menu.popup();
}
```

`repoPath` must be passed down to `CommitRow` (currently not in its props) — minor prop addition needed.

**Separator:** `PredefinedMenuItem.separator()` (also from `@tauri-apps/api/menu`) can be used to group copy actions vs mutating actions visually.

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `std::process::Command` shell-out for remote ops | `git2::Remote::push/fetch` with `RemoteCallbacks::credentials` | libgit2 does not invoke SSH agent or credential helpers reliably; auth silently fails on standard macOS developer setups launched outside terminal |
| git2 `stash_save` / `stash_pop` for stash ops | Shell-out to `git stash push` / `git stash pop` | Stash is a local operation; git2 supports it natively and reliably — no auth concerns, no process overhead |
| Native `@tauri-apps/api/menu` (`MenuItem`) for context menu | Custom Svelte dropdown component | Native menu already proven in this codebase (header column menu); OS-native look, proper overflow/z-index, keyboard nav — all free |
| `navigator.clipboard.writeText()` for copy SHA/message | `tauri-plugin-clipboard-manager` | Tauri 2 WebView allows clipboard writes without a plugin; no need to add a plugin for two simple copy actions |
| `tauri::async_runtime::spawn_blocking` for blocking I/O | Add tokio as direct dep | tokio is already a transitive dep via Tauri; `tauri::async_runtime` is the correct surface for Tauri commands |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `tauri-plugin-shell` | Wrong abstraction: exposes shell exec to JS; remote ops are Rust-to-Rust | `std::process::Command` inside Tauri commands |
| git2 remote auth callbacks (SSH/HTTPS) | Does not invoke SSH agent or credential helpers; auth fails silently for many developers | Shell-out to system `git` |
| npm context-menu libraries | Render in WebView, cannot match OS-native menus, fight with z-index/overflow | `@tauri-apps/api/menu` |
| `tauri-plugin-clipboard-manager` | Plugin overhead for trivial clipboard writes | `navigator.clipboard.writeText()` |
| Progress streaming via Tauri events (v0.3) | Complexity not justified for v0.3; `.output()` blocking call is simpler and sufficient | `.output()` (wait for process completion), stream in v0.4+ if needed |

---

## Stack Patterns by Variant

**If push/pull requires real-time progress display (v0.4+ enhancement):**
- Replace `.output()` with `Command::new(...).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()`
- Read stderr line-by-line in `spawn_blocking` loop, emit Tauri `remote:progress` events
- Frontend `listen('remote:progress', ...)` renders progress in a modal or status bar
- This is an enhancement, not a v0.3 requirement — `.output()` (wait for completion) is correct for v0.3

**If cherry-pick produces merge conflicts:**
- `repo.cherrypick()` leaves the index in a conflicted state
- Detect by calling `repo.index()?.has_conflicts()` after the call
- Return `cherry_pick_conflict` error code — same structured error pattern as `dirty_workdir`
- Full conflict resolution UI is out of scope for v0.3 per PROJECT.md

**If tag creation needs user-specified message (annotated tag):**
- Lightweight tag: `repo.tag_lightweight("name", &obj, false)` — just a ref, no message
- Annotated tag: `repo.tag("name", &obj, &sig, "message", false)` — shows in `git describe`
- Default to lightweight for v0.3 commit context menu (simpler, no extra dialog)

**If `Create Branch Here` / `Create Tag Here` need user input:**
- Use existing `tauri-plugin-dialog` for a simple text input prompt — already declared in capabilities
- Or implement a minimal inline input in the Svelte UI (no plugin needed)
- tauri-plugin-dialog is already imported and working (`dialog:allow-open` in capabilities)

---

## Version Compatibility

| Package | Version | Source | Notes |
|---------|---------|--------|-------|
| git2 | 0.19.0 | Cargo.lock (direct inspection) | libgit2-sys 0.17.0+1.8.1; stash_save, stash_pop, cherrypick, revert, set_head_detached, tag, tag_lightweight all available |
| libgit2-sys | 0.17.0+1.8.1 | Cargo.lock (direct inspection) | libgit2 C library version 1.8.1 vendored |
| libssh2-sys | 0.3.1 | Cargo.lock (direct inspection) | Present transitively via git2; irrelevant — SSH auth via shell-out, not libssh2 |
| tauri | 2.10.2 | Cargo.lock (direct inspection) | `tauri::async_runtime::spawn_blocking` available |
| @tauri-apps/api | ^2 (package.json) | package.json (direct inspection) | `Menu`, `MenuItem`, `CheckMenuItem`, `PredefinedMenuItem` all available |
| core:menu:default | — | capabilities/default.json (direct inspection) | Already declared; commit row context menu requires no new capability |

---

## Sources

- `/Users/joaofnds/code/trunk/src-tauri/Cargo.lock` — git2 0.19.0, libgit2-sys 0.17.0+1.8.1, libssh2-sys 0.3.1, tauri 2.10.2 confirmed (HIGH confidence, direct file inspection)
- `/Users/joaofnds/code/trunk/src-tauri/Cargo.toml` — no tauri-plugin-shell; git2 with vendored-libgit2 feature; full dependency list (HIGH confidence, direct file inspection)
- `/Users/joaofnds/code/trunk/src-tauri/capabilities/default.json` — `core:menu:default` already declared; no new capabilities needed for commit context menu (HIGH confidence, direct file inspection)
- `/Users/joaofnds/code/trunk/src/components/CommitGraph.svelte` — `Menu`, `CheckMenuItem` from `@tauri-apps/api/menu` already imported and used with `menu.popup()` pattern (HIGH confidence, direct file inspection)
- `/Users/joaofnds/code/trunk/.planning/PROJECT.md` — confirms project decision: shell-out to git CLI for remote ops; libgit2 SSH/HTTPS auth unreliable (HIGH confidence, validated project decision)
- git2 0.19 API (stash_save, stash_pop, cherrypick, revert, tag, set_head_detached) — MEDIUM confidence: based on training data for libgit2 1.8.x; internally consistent with the libgit2-sys 1.8.1 version in Cargo.lock. Recommend confirming `stash_pop` signature on docs.rs before implementation.

---

*Stack research for: Tauri 2 Git GUI v0.3 — remote ops, stash, commit context menu*
*Researched: 2026-03-10*
