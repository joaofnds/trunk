# Architecture Research

**Domain:** Tauri 2 + Svelte 5 + Rust desktop Git GUI — v0.3 remote ops, stash, commit context menu
**Researched:** 2026-03-10
**Confidence:** HIGH — existing codebase fully read; all integration points derived from code, not assumptions

---

## Existing Architecture Summary

Before describing what changes, here is what is already in place and MUST NOT be disrupted.

**Rust managed state:**
- `RepoState(Mutex<HashMap<String, PathBuf>>)` — path registry; `git2::Repository` is NOT stored (not Sync)
- `CommitCache(Mutex<HashMap<String, GraphResult>>)` — cached lane graph per repo
- `WatcherState(Mutex<WatcherMap>)` — filesystem watchers per repo

**Command pattern (inner-fn):** Every Tauri command delegates immediately to a pure `_inner` function that takes `&HashMap<String, PathBuf>` and returns `Result<T, TrunkError>`. The Tauri command does: lock state → clone → `spawn_blocking` → update cache → emit `repo-changed`. The inner fn has no Tauri dependency and is directly unit-testable.

**Mutation pattern (cache-repopulate-before-emit):** After any mutation, call `refresh_commit_cache()` inside the same `spawn_blocking` block, update `CommitCache` under the lock, then emit `repo-changed`. This prevents the frontend from seeing a stale empty cache when it re-renders.

**IPC:** `safeInvoke<T>` on the frontend wraps all `invoke()` calls and parses `TrunkError` JSON from Rust error strings. All commands return `Result<T, String>` where the `String` is `serde_json::to_string(&TrunkError)`.

**Event bus:** Rust emits `repo-changed` (payload: path string) after mutations. Frontend subscribes with `listen()` in `App.svelte` and increments `refreshSignal` to trigger `CommitGraph.svelte` refresh.

**Native context menu (already used):** `CommitGraph.svelte` already uses `@tauri-apps/api/menu` — `Menu.new({ items })` + `menu.popup()` — for the column header right-click. This exact same pattern applies to per-commit context menus.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Svelte 5 Frontend (WebView)                                     │
│                                                                  │
│  App.svelte                                                      │
│    ├── CommitGraph.svelte  ← NEW: oncontextmenu per row          │
│    │     └── CommitRow.svelte  ← NEW: contextmenu handler        │
│    ├── BranchSidebar.svelte  ← NEW: remote op buttons            │
│    └── StagingPanel.svelte  ← NEW: stash save/pop controls       │
│                                                                  │
│  invoke.ts (safeInvoke<T>) ← no changes needed                  │
│  types.ts  ← NEW: RemoteOpProgress, StashEntry                   │
├─────────────────────────────────────────────────────────────────┤
│  Tauri IPC Layer                                                 │
│    invoke  → Rust #[tauri::command]                              │
│    emit    ← Rust app.emit(event, payload)                       │
├─────────────────────────────────────────────────────────────────┤
│  Rust Backend (src-tauri/src/)                                   │
│                                                                  │
│  commands/                                                       │
│    remote.rs  ← NEW: push, pull, fetch                           │
│    stash.rs   ← NEW: stash_save, stash_pop, stash_drop           │
│    commit.rs  ← EXTEND: checkout_commit, cherry_pick, revert,   │
│                          create_tag                               │
│    branches.rs  (existing: checkout_branch, create_branch)       │
│                                                                  │
│  git/                                                            │
│    remote.rs  ← NEW: shell-out wrappers (push/pull/fetch)        │
│    stash.rs   ← NEW: git2 stash operations                       │
│                                                                  │
│  state.rs  ← no changes                                          │
│  watcher.rs  ← no changes                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Feature 1: Remote Operations (Push / Pull / Fetch)

### Why Shell-Out (Decision Already Made)

`git2` / libgit2 has incomplete and unreliable SSH agent forwarding and HTTPS credential helper integration. All major open-source Tauri git clients (GitButler, Aho) shell out to the `git` CLI for remote operations. The git CLI handles SSH agents, macOS Keychain, git-credential-helper, and SSH passphrase prompts natively. libgit2 requires reimplementing the entire credential callback chain — which is brittle and platform-specific. This decision is already recorded in `PROJECT.md`.

### Async Long-Running Commands in Tauri

The existing pattern uses `tauri::async_runtime::spawn_blocking` for blocking git2 calls. Remote ops cannot use `spawn_blocking` in the same way because:
1. They can take 10-60+ seconds
2. They produce stderr output (progress lines like `remote: Counting objects: 100%`)
3. They may require interactive credential input

**Correct approach: `tokio::process::Command` (async, non-blocking)**

Tauri 2's async runtime is Tokio. `tokio::process::Command` lets you spawn a subprocess, capture stdout/stderr line-by-line asynchronously, and emit each line as a Tauri event — without blocking the async executor and without `spawn_blocking`.

```rust
// Pattern for streaming remote ops
#[tauri::command]
pub async fn git_fetch(
    path: String,
    remote: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let path_buf = {
        let map = state.0.lock().unwrap();
        map.get(&path)
            .ok_or_else(|| /* TrunkError JSON */ )?
            .clone()
    };

    let mut child = tokio::process::Command::new("git")
        .args(["fetch", "--progress", &remote])
        .current_dir(&path_buf)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(/* ... */)?;

    // Stream stderr (git remote progress goes to stderr)
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let path_clone = path.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit("remote-progress", RemoteProgress {
                    path: path_clone.clone(),
                    line,
                });
            }
        });
    }

    let status = child.wait().await.map_err(/* ... */)?;
    if !status.success() {
        return Err(/* TrunkError JSON: exit code */);
    }

    // cache-repopulate-before-emit pattern
    let path_clone = path.clone();
    let state_map = state.0.lock().unwrap().clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        let path_buf = state_map.get(&path_clone).ok_or(/* ... */)?;
        let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
        graph::walk_commits(&mut repo, 0, usize::MAX)
    })
    .await
    .map_err(/* ... */)?
    .map_err(/* ... */)?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}
```

**Note on `spawn_blocking` vs `tokio::process::Command`:** The existing commands use `spawn_blocking` because git2 is synchronous. Remote shell-out uses `tokio::process::Command` which is natively async — no `spawn_blocking` wrapper needed.

### Progress Streaming to Frontend

New event: `remote-progress` with payload `{ path: string; line: string }`.

Git remote progress appears on stderr. Example lines:
```
remote: Counting objects: 100% (52/52), done.
remote: Compressing objects: 100% (35/35), done.
Receiving objects: 100% (52/52), 4.55 KiB | 1.52 MiB/s, done.
```

**Frontend pattern:**
```typescript
// In BranchSidebar.svelte or a dedicated RemoteOpsModal.svelte
let progressLines = $state<string[]>([]);
let remoteOpRunning = $state(false);

async function handleFetch() {
    remoteOpRunning = true;
    progressLines = [];
    const unlisten = await listen<{ path: string; line: string }>('remote-progress', (e) => {
        if (e.payload.path === repoPath) {
            progressLines = [...progressLines, e.payload.line];
        }
    });
    try {
        await safeInvoke('git_fetch', { path: repoPath, remote: 'origin' });
    } finally {
        unlisten();
        remoteOpRunning = false;
    }
}
```

The `unlisten()` call in `finally` ensures the listener is removed after the command resolves.

### SSH / HTTPS Credential Handling

**SSH (agent-based):** When the git CLI runs, it calls the SSH agent normally via the running `ssh-agent` / macOS Keychain. No special handling needed for repos already set up with SSH keys.

**SSH passphrase prompts:** If the key has a passphrase and is not in the agent, `git fetch` will block waiting for terminal input. Since the process has no controlling terminal, it will fail with "Permission denied (publickey)". The frontend should show the error from stderr and guide the user to add the key to ssh-agent.

**HTTPS credentials:** The `git` CLI will use whatever credential helper is configured (macOS Keychain via `git-credential-osxkeychain`, Windows Credential Manager, etc.). If no helper is configured and credentials are needed, git will block waiting for stdin — which will fail the same way (no TTY).

**Recommended approach for v0.3:** Do NOT implement a credential input UI. Instead:
1. Capture the exit code and full stderr output
2. On failure, surface the stderr in a modal/error display
3. Document that repos must have credentials configured in the system (SSH key in agent, or HTTPS credentials in OS keychain)

This is what GitButler and other Tauri git clients do for v1. A credential prompt UI is a later feature requiring `tauri-plugin-dialog` for secure text input or a dedicated Tauri window.

**The `GIT_TERMINAL_PROMPT=0` env var:** Set this on the spawned process to prevent git from blocking forever waiting for credentials it will never receive:

```rust
tokio::process::Command::new("git")
    .env("GIT_TERMINAL_PROMPT", "0")  // Fail fast instead of blocking
    .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")  // SSH: fail fast on passphrase prompt
    .args(["fetch", "--progress", remote])
    .current_dir(&path_buf)
    // ...
```

### New Rust Commands (Remote)

| Command | Rust fn | git CLI args | Emits |
|---------|---------|-------------|-------|
| `git_fetch` | `git_fetch` | `git fetch [remote] --progress` | `remote-progress`, `repo-changed` |
| `git_pull` | `git_pull` | `git pull [remote] [branch] --progress` | `remote-progress`, `repo-changed` |
| `git_push` | `git_push` | `git push [remote] [branch] --progress` | `remote-progress`, `repo-changed` |

**No new git module file needed for remote ops** — these are thin wrappers around `tokio::process::Command`. Put them in `commands/remote.rs` directly. There is no "inner function" testable equivalent for shell-out commands (the test would require a real git remote), so unit tests are skipped for remote commands; integration tests with a bare repo can be added later.

### New Rust Type

```rust
// In types.rs (or directly in commands/remote.rs)
#[derive(Debug, Serialize, Clone)]
pub struct RemoteProgress {
    pub path: String,
    pub line: String,
}
```

---

## Feature 2: Stash Operations

### git2 Stash API Coverage

The `git2` crate provides native stash operations. The existing codebase already uses `stash_foreach` (in `branches.rs` for listing stashes and in `repository.rs` for building the ref map). The full API available:

| git2 method | Signature | Notes |
|-------------|-----------|-------|
| `repo.stash_save` | `(&mut self, stasher: &Signature, message: &str, flags: Option<StashFlags>) -> Result<Oid>` | Requires `&mut repo`. `StashFlags::DEFAULT` stashes tracked changes. |
| `repo.stash_apply` | `(&mut self, index: usize, opts: Option<&mut StashApplyOptions>) -> Result<()>` | Apply without removing. |
| `repo.stash_pop` | `(&mut self, index: usize, opts: Option<&mut StashApplyOptions>) -> Result<()>` | Apply and remove. |
| `repo.stash_drop` | `(&mut self, index: usize) -> Result<()>` | Remove without applying. |
| `repo.stash_foreach` | `(&mut self, callback: F) -> Result<()>` | Iterate. Already used. |

**Critical:** All stash methods require `&mut Repository`. This is already the pattern used in `branches.rs` (`list_refs_inner` calls `repo.stash_foreach` with `&mut repo`).

`StashFlags` for `stash_save`:
- `StashFlags::DEFAULT` — stash all tracked changes (staged + unstaged)
- `StashFlags::INCLUDE_UNTRACKED` — also stash untracked files
- `StashFlags::KEEP_INDEX` — keep staged changes in the index after stashing

For v0.3, `StashFlags::DEFAULT` is the right choice. Include-untracked is a follow-on feature.

### Stash and CommitCache

Stash operations mutate the working tree and the stash ref list. After `stash_save` or `stash_pop`, both the commit graph (stash commits appear/disappear in the graph) and the refs list (stashes panel in sidebar) need to refresh.

**Pattern: follow cache-repopulate-before-emit exactly as existing mutation commands.**

After `stash_save` or `stash_pop` completes, call `walk_commits` to rebuild the graph, update `CommitCache`, then emit `repo-changed`. The frontend's existing `repo-changed` listener handles the refresh automatically.

### Stash and WatcherState

The filesystem watcher (`notify`) is watching the entire repo directory including `.git`. Any mutation (including stash) triggers a `repo-changed` event from the watcher. This means if the user stashes from the terminal while Trunk is open, the UI will auto-refresh. No changes needed to `WatcherState`.

The watcher fires AFTER stash commands complete (it watches filesystem events). There is no double-refresh risk: the command itself emits `repo-changed` after updating the cache, and the watcher may fire a second event — but the frontend's `refreshSignal` increment is idempotent (it just refreshes the graph again).

### New Rust Commands (Stash)

| Command | Rust fn | git2 call | Args |
|---------|---------|-----------|------|
| `stash_save` | `stash_save` | `repo.stash_save(&sig, message, None)` | `path: String, message: String` |
| `stash_pop` | `stash_pop` | `repo.stash_pop(index, None)` | `path: String, index: usize` |
| `stash_drop` | `stash_drop` | `repo.stash_drop(index)` | `path: String, index: usize` |

`stash_apply` (without removing) is less commonly needed for v0.3. Include `stash_drop` because the sidebar already shows stashes and users will want to delete them.

### Inner-fn Pattern for Stash

```rust
// commands/stash.rs

pub fn stash_save_inner(
    path: &str,
    message: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", /* ... */))?;
    let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
    let sig = repo.signature().map_err(TrunkError::from)?;
    repo.stash_save(&sig, message, None).map_err(TrunkError::from)?;
    Ok(())
}

pub fn stash_pop_inner(
    path: &str,
    index: usize,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", /* ... */))?;
    let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
    repo.stash_pop(index, None).map_err(TrunkError::from)?;
    Ok(())
}
```

The Tauri command wrappers follow the same `spawn_blocking` + cache-repopulate + `repo-changed` emit pattern as `create_commit`.

### New git module file

Create `src-tauri/src/git/stash.rs` (optional but recommended) if stash logic becomes complex. For simple save/pop/drop, the inner fns can live directly in `commands/stash.rs`.

---

## Feature 3: Commit Row Context Menu

### Existing Native Menu Pattern

`CommitGraph.svelte` already has a working example:

```typescript
// Existing: column header right-click
async function showHeaderContextMenu(e: MouseEvent) {
    e.preventDefault();
    const items = await Promise.all(columnLabels.map(col => CheckMenuItem.new({ ... })));
    const menu = await Menu.new({ items });
    await menu.popup();  // Pops at cursor position automatically
}
```

`menu.popup()` with no arguments uses the current cursor position. This is already the correct API.

### Per-Commit Dynamic Menu

The commit context menu must:
1. Be triggered on `contextmenu` event on a `CommitRow`
2. Know which commit was right-clicked (the `oid`, `short_oid`, `summary`)
3. Show relevant actions based on commit state (e.g., HEAD commit gets different options)
4. Execute actions that require the `repoPath`

**Component design:** Add `oncontextmenu` to `CommitRow.svelte`. Pass a callback up through `CommitGraph.svelte` to `App.svelte`, or handle it entirely within `CommitGraph.svelte`.

Since `CommitGraph.svelte` already owns `repoPath` (it's a prop), it can implement the context menu handler directly without lifting state to `App.svelte`.

```typescript
// In CommitGraph.svelte

async function showCommitContextMenu(e: MouseEvent, commit: GraphCommit) {
    e.preventDefault();
    e.stopPropagation();  // Prevent row click (commit select) from firing

    const items = await buildCommitMenuItems(commit);
    const menu = await Menu.new({ items });
    await menu.popup();
}

async function buildCommitMenuItems(commit: GraphCommit): Promise<MenuItem[]> {
    // Build items array based on commit state
    const isWip = commit.oid === '__wip__';
    if (isWip) return [];  // No context menu for WIP row

    return [
        await MenuItem.new({
            text: 'Copy SHA',
            action: () => navigator.clipboard.writeText(commit.oid),
        }),
        await MenuItem.new({
            text: 'Copy Message',
            action: () => navigator.clipboard.writeText(commit.summary),
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({
            text: 'Checkout Commit',
            action: () => handleCheckoutCommit(commit.oid),
        }),
        await MenuItem.new({
            text: 'Create Branch Here',
            action: () => handleCreateBranchAt(commit.oid),
        }),
        await MenuItem.new({
            text: 'Create Tag Here',
            action: () => handleCreateTagAt(commit.oid),
        }),
        await PredefinedMenuItem.new({ item: 'Separator' }),
        await MenuItem.new({
            text: 'Cherry-pick',
            action: () => handleCherryPick(commit.oid),
        }),
        await MenuItem.new({
            text: 'Revert',
            action: () => handleRevert(commit.oid),
        }),
    ];
}
```

### Passing the Handler into CommitRow

`CommitRow.svelte` currently accepts:
```typescript
interface Props {
    commit: GraphCommit;
    onselect?: (oid: string) => void;
    maxColumns?: number;
    columnWidths: ColumnWidths;
    columnVisibility: ColumnVisibility;
}
```

Add `oncontextmenu?: (e: MouseEvent, commit: GraphCommit) => void` to Props.

In CommitRow's root div:
```svelte
<div
  ...
  oncontextmenu={(e) => oncontextmenu?.(e, commit)}
>
```

In CommitGraph's virtual list snippet:
```svelte
{#snippet renderItem(commit)}
    <CommitRow
        {commit}
        onselect={...}
        oncontextmenu={showCommitContextMenu}
        {maxColumns}
        {columnWidths}
        {columnVisibility}
    />
{/snippet}
```

### New Rust Commands (Commit Context Menu Actions)

| Action | Rust command | git2 / CLI | Notes |
|--------|-------------|-----------|-------|
| Checkout commit | `checkout_commit` | `repo.set_head_detached(oid)` + `repo.checkout_tree` | Detaches HEAD; git2 supported |
| Create branch at commit | Extend existing `create_branch` | Add `from_oid: Option<String>` param | If provided, create from that commit instead of HEAD |
| Create tag | `create_tag` | `repo.tag_lightweight(name, &obj, false)` | Lightweight tag; annotated tags are v0.4+ |
| Cherry-pick | `cherry_pick` | Shell-out: `git cherry-pick <oid>` | git2 has `repo.cherrypick()` but conflict handling is complex; shell-out is safer for v0.3 |
| Revert | `revert` | Shell-out: `git revert <oid> --no-edit` | Same reasoning as cherry-pick |

**Cherry-pick and revert via shell-out:** git2 has `Repository::cherrypick()` and `Repository::revert()`, but both require manual conflict resolution handling (setting merge state, writing CHERRY_PICK_HEAD / REVERT_HEAD). The git CLI handles this cleanly, produces a commit automatically (for revert), and reports conflicts clearly in stderr. Using shell-out for these two is consistent with using shell-out for remote ops and avoids reimplementing merge state management.

**Checkout commit (detached HEAD):** git2 supports this cleanly:
```rust
pub fn checkout_commit_inner(
    path: &str,
    oid_str: &str,
    state_map: &HashMap<String, PathBuf>,
    cache_map: &mut HashMap<String, GraphResult>,
) -> Result<(), TrunkError> {
    let path_buf = state_map.get(path).ok_or_else(|| /* ... */)?;
    let repo = git2::Repository::open(path_buf)?;
    let oid = git2::Oid::from_str(oid_str).map_err(TrunkError::from)?;
    let commit = repo.find_commit(oid).map_err(TrunkError::from)?;
    let obj = commit.as_object();
    repo.checkout_tree(obj, Some(&mut git2::build::CheckoutBuilder::new().safe()))?;
    repo.set_head_detached(oid)?;
    drop(repo);
    // Rebuild cache
    let mut repo2 = git2::Repository::open(path_buf)?;
    cache_map.insert(path.to_owned(), graph::walk_commits(&mut repo2, 0, usize::MAX)?);
    Ok(())
}
```

**Create tag:** git2 lightweight tag:
```rust
repo.tag_lightweight(name, &obj, false)  // false = no force
```

---

## Data Flow Changes

### New Events

| Event | Payload Type | Direction | When |
|-------|-------------|-----------|------|
| `remote-progress` | `{ path: string; line: string }` | Rust → Frontend | During push/pull/fetch, one event per output line |
| `repo-changed` | `string` (path) | Rust → Frontend | After ANY mutation (existing; unchanged) |

No new persistent event channels. `remote-progress` is fire-and-forget; the frontend subscribes during the operation and unsubscribes after the invoke resolves.

### New IPC Commands

**Remote:**
- `git_fetch(path, remote)` → `Result<(), String>`
- `git_pull(path, remote, branch)` → `Result<(), String>`
- `git_push(path, remote, branch)` → `Result<(), String>`

**Stash:**
- `stash_save(path, message)` → `Result<(), String>`
- `stash_pop(path, index)` → `Result<(), String>`
- `stash_drop(path, index)` → `Result<(), String>`

**Commit context menu actions:**
- `checkout_commit(path, oid)` → `Result<(), String>`
- `create_tag(path, name, oid)` → `Result<(), String>`
- `cherry_pick(path, oid)` → `Result<(), String>`  (shell-out)
- `revert_commit(path, oid)` → `Result<(), String>`  (shell-out)
- `create_branch` — extend existing to accept `from_oid: Option<String>`

### New TypeScript Types

```typescript
// types.ts additions

export interface RemoteProgress {
    path: string;
    line: string;
}

export interface StashEntry {
    index: number;
    name: string;
    short_name: string;  // "stash@{0}"
}
```

---

## Component Boundaries

### Modified Components (Rust)

| File | Change | Why |
|------|--------|-----|
| `commands/mod.rs` | pub mod remote; pub mod stash; new pub use exports | Registration |
| `lib.rs` invoke_handler | Add all new commands | Registration |
| `commands/branches.rs` | Extend `create_branch` with optional `from_oid` | Branch-at-commit support |
| `commands/commit.rs` | Add `checkout_commit_inner`, `create_tag_inner` | Context menu actions |

### New Files (Rust)

| File | Contents |
|------|----------|
| `src-tauri/src/commands/remote.rs` | `git_fetch`, `git_pull`, `git_push` using `tokio::process::Command` |
| `src-tauri/src/commands/stash.rs` | `stash_save`, `stash_pop`, `stash_drop` with inner-fn pattern |

### Modified Components (Frontend)

| File | Change | Why |
|------|--------|-----|
| `CommitRow.svelte` | Add `oncontextmenu` prop | Per-commit right-click |
| `CommitGraph.svelte` | Add `showCommitContextMenu`, pass handler to CommitRow | Context menu logic lives here (has repoPath) |
| `BranchSidebar.svelte` | Add fetch/pull/push buttons + progress display | Remote op triggers |
| `StagingPanel.svelte` | Add stash save button + stash list with pop/drop | Stash controls |
| `App.svelte` | Listen for `remote-progress` if global overlay needed; otherwise no changes | Optional |
| `types.ts` | Add `RemoteProgress`, `StashEntry` | IPC type mirrors |

### New Files (Frontend)

No new Svelte components strictly required. Remote progress output can be displayed inline in `BranchSidebar.svelte` or in a small overlay. If the progress output grows complex, extract a `RemoteProgressToast.svelte`.

---

## Architectural Patterns for New Features

### Pattern 1: Async Shell-Out with Event Streaming

**What:** Use `tokio::process::Command` (not `spawn_blocking`) for remote ops. Stream stderr to frontend via `app.emit` in a spawned task. Await process exit before resolving the command.

**When to use:** Any long-running CLI subprocess where progress feedback matters.

**Trade-offs:** The invoke call blocks until the subprocess exits (which is correct — the frontend awaits it and can show a spinner). The streaming events provide incremental feedback. The `finally { unlisten() }` pattern on the frontend is essential to avoid listener leaks.

### Pattern 2: git2 Stash with &mut Repository

**What:** All stash operations require `&mut repo`. Open a fresh `git2::Repository::open(path_buf)` bound as `mut` inside the `spawn_blocking` closure. This is already the established pattern for any operation needing `&mut repo` (e.g., `stash_foreach` in `branches.rs`).

**When to use:** Any git2 operation that takes `&mut self` on Repository.

**Trade-offs:** Opening a fresh repo handle per command is the documented design constraint (`git2::Repository is not Sync`). The overhead is negligible.

### Pattern 3: Native Context Menu at Cursor Position

**What:** On `contextmenu` event, call `e.preventDefault()` (suppress browser right-click), build a `Menu` from `@tauri-apps/api/menu`, and call `menu.popup()` with no arguments (uses current cursor position automatically).

**When to use:** Any per-row or per-item right-click in the commit graph or sidebar.

**Trade-offs:** `Menu.new({ items })` is async (each `MenuItem.new` is a Tauri IPC call). Building a 8-item menu takes ~10-20ms. This is acceptable for a right-click action. Do not cache the menu object — it captures action closures that reference mutable state.

### Pattern 4: Shell-Out for Cherry-Pick / Revert

**What:** Use `tokio::process::Command` with `git cherry-pick <oid>` and `git revert <oid> --no-edit`. Check exit code; surface stderr on failure.

**When to use:** git2 operations that require complex merge state management (cherry-pick, revert, merge).

**Trade-offs:** Loses the "inner-fn testable" property. Prefer this over re-implementing git conflict state handling. Integration tests with real repos are needed instead of unit tests.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: spawn_blocking for Remote Ops

**What:** Wrapping `std::process::Command` (blocking) in `spawn_blocking` for push/pull/fetch.

**Why bad:** Blocks a thread-pool thread for 10-60+ seconds. `tokio::process::Command` is natively async and does not consume a thread-pool thread while the subprocess runs.

**Instead:** Use `tokio::process::Command`.

### Anti-Pattern 2: Blocking on stdin for Credentials

**What:** Spawning `git fetch` without `GIT_TERMINAL_PROMPT=0`, allowing git to block indefinitely waiting for a username/password on stdin that will never arrive.

**Why bad:** The Tauri command will hang and never resolve. The frontend spinner will spin forever.

**Instead:** Always set `GIT_TERMINAL_PROMPT=0` and `ssh -o BatchMode=yes` on the SSH command. On credential failure, git exits with a non-zero code and useful error text in stderr. Surface the stderr to the user.

### Anti-Pattern 3: git2 for Cherry-Pick / Revert

**What:** Using `repo.cherrypick()` / `repo.revert()` from git2.

**Why bad:** Requires implementing the full conflict state machine: detect conflicts, update CHERRY_PICK_HEAD / REVERT_HEAD, prompt user for resolution, complete the operation. This is a multi-screen feature, not a single command.

**Instead:** Shell out to `git cherry-pick` and `git revert --no-edit`. If conflicts occur, the command fails with a clear error message. Conflict resolution UI is deferred to v0.4+.

### Anti-Pattern 4: Lifting Context Menu to App.svelte

**What:** Passing commit context menu callbacks up to `App.svelte` to centralize all action handlers.

**Why bad:** The actions (cherry-pick, create-tag, etc.) need `repoPath` and `refreshSignal`, which are already in scope in `CommitGraph.svelte`. Lifting them adds unnecessary prop drilling.

**Instead:** Handle commit context menu actions inside `CommitGraph.svelte`. Only bubble up to `App.svelte` if an action needs to trigger something in a sibling component (e.g., opening the staging panel for cherry-pick conflicts — but that is v0.4+).

### Anti-Pattern 5: One Event Listener Per Row

**What:** Adding a `remote-progress` listener inside each `CommitRow.svelte`.

**Why bad:** Virtual scroll creates/destroys rows. If listener setup/teardown is tied to row lifecycle, listeners will be created/destroyed during scrolling.

**Instead:** Attach `remote-progress` listeners at `App.svelte` or `BranchSidebar.svelte` level, scoped to the duration of a remote operation only.

---

## Build Order

Dependencies flow upward. Complete each phase fully before starting the next.

### Phase 1: Stash Commands (Rust only)

1. Create `src-tauri/src/commands/stash.rs` with `stash_save_inner`, `stash_pop_inner`, `stash_drop_inner` and their Tauri command wrappers
2. Register in `commands/mod.rs` and `lib.rs` invoke_handler
3. Add unit tests using `make_test_repo()` and `repo.stash_save()`

**Rationale:** Stash uses only git2 (already depended on). No new Cargo dependencies. Testable in isolation. Unlocks stash UI work immediately.

### Phase 2: Stash UI

1. Update `StagingPanel.svelte` with stash save button and stash list (pop/drop per entry)
2. Stash list is already available from `list_refs` response (`stashes: RefLabel[]`)
3. Wire `stash_save` invoke with the current WIP subject line as the message
4. Wire `stash_pop(0)` for quick pop of latest stash

**Rationale:** No new backend work needed. Completes the stash feature.

### Phase 3: Commit Context Menu (Frontend + Rust for new actions)

1. Add `oncontextmenu` prop to `CommitRow.svelte`
2. Implement `showCommitContextMenu` in `CommitGraph.svelte`
3. Add Copy SHA and Copy Message (no backend needed — navigator.clipboard)
4. Add `checkout_commit` command in Rust (extends `commands/commit.rs`)
5. Add `create_tag` command in Rust (extends `commands/commit.rs`)
6. Add `cherry_pick` and `revert_commit` shell-out commands in Rust
7. Extend `create_branch` with `from_oid` parameter

**Rationale:** Copy SHA/message works immediately. Git2 actions (checkout, tag, branch) come next. Shell-out actions (cherry-pick, revert) come last since they share the shell-out infrastructure with remote ops.

### Phase 4: Remote Operations (Rust + Frontend)

1. Add `tokio::process::Command` remote commands to `commands/remote.rs`
2. Add `RemoteProgress` type and `remote-progress` event
3. Register new commands in `lib.rs`
4. Add progress listener + remote buttons to `BranchSidebar.svelte`
5. Test with real repos (push requires a remote — test with local bare repos)

**Rationale:** Remote ops are the most complex feature (async streaming, error handling, credential edge cases). Build last after all simpler features are working and patterns are established.

---

## Integration Points Summary

| Existing Component | What Touches It | Change Type |
|--------------------|-----------------|-------------|
| `commands/commit.rs` | Add `checkout_commit_inner`, `create_tag_inner` | Extend |
| `commands/branches.rs` | `create_branch` gains `from_oid: Option<String>` | Extend |
| `commands/mod.rs` | Add `pub mod remote; pub mod stash;` | Extend |
| `lib.rs` | Register new commands in invoke_handler | Extend |
| `CommitRow.svelte` | Add `oncontextmenu` prop | Extend |
| `CommitGraph.svelte` | Add context menu handler | Extend |
| `BranchSidebar.svelte` | Remote op buttons + progress output | Extend |
| `StagingPanel.svelte` | Stash save/pop/drop UI | Extend |
| `types.ts` | Add `RemoteProgress`, `StashEntry` | Extend |
| `state.rs` | No changes | Unchanged |
| `watcher.rs` | No changes | Unchanged |
| `error.rs` | No changes | Unchanged |
| `invoke.ts` | No changes | Unchanged |
| `App.svelte` | Minimal changes (optional remote-progress global listener) | Minimal |

---

## Sources

- **Existing codebase** — `commands/commit.rs`, `commands/branches.rs`, `commands/repo.rs`, `commands/history.rs`, `git/repository.rs`, `state.rs`, `watcher.rs`, `CommitGraph.svelte`, `CommitRow.svelte`, `App.svelte`, `lib.rs`, `Cargo.toml` — all read directly. Confidence: HIGH.
- **git2 stash API** — `stash_save`, `stash_pop`, `stash_drop`, `stash_foreach` signatures verified against docs.rs knowledge. `stash_foreach` already used in production code in `branches.rs` and `repository.rs`. Confidence: HIGH.
- **Tauri 2 tokio::process::Command pattern** — Tauri 2 runtime is Tokio; `tokio::process::Command` is the standard async subprocess API. Pattern consistent with how GitButler handles remote ops (confirmed via PROJECT.md note that major Tauri git clients shell out). Confidence: HIGH.
- **menu.popup() cursor position** — Verified against existing `showHeaderContextMenu` in `CommitGraph.svelte` which uses `menu.popup()` with no args. Confidence: HIGH.
- **GIT_TERMINAL_PROMPT=0** — Standard git environment variable for non-interactive credential suppression. Confidence: HIGH.

---

*Architecture research for: Trunk v0.3 — remote ops, stash, commit context menu*
*Researched: 2026-03-10*
