# Architecture

**Analysis Date:** 2026-05-14

> Snapshot, not a live contract. It maps the whole system as of that date and has not been
> re-derived since — v0.14 and later work (push recovery, markdown diffs, the prefs store)
> is missing. Trust `docs/architecture/commit-graph.md` and the source over this file where
> they disagree.

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        Svelte 5 Frontend (WebView)                   │
│                                                                      │
│  App.svelte — tab manager, layout state, global event listeners      │
│    └── RepoView.svelte — per-repo orchestrator (all per-repo state)  │
│          ├── CommitGraph.svelte — graph + SVG overlay                │
│          ├── BranchSidebar.svelte — refs / branches                  │
│          ├── StagingPanel.svelte — working tree status               │
│          ├── DiffPanel.svelte — diff viewer                          │
│          ├── Toolbar.svelte — fetch/pull/push/undo controls          │
│          ├── RebaseEditor.svelte — interactive rebase UI             │
│          └── MergeEditor.svelte — three-way merge conflict editor    │
│                                                                      │
│  src/lib/ — pure utilities, Svelte $state stores, IPC wrapper        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  invoke("command_name", args)
                                │  Tauri IPC bridge
                                │  events: "repo-changed", "remote-progress"
┌───────────────────────────────▼──────────────────────────────────────┐
│                          Rust Backend (Tauri 2)                       │
│                                                                      │
│  src-tauri/src/lib.rs — app setup, plugin registration, invoke table │
│  src-tauri/src/commands/ — one file per domain (12 command modules)  │
│  src-tauri/src/git/ — git2-based logic (graph, repository, types)    │
│  src-tauri/src/state.rs — Tauri-managed shared state (Mutex-wrapped) │
│  src-tauri/src/watcher.rs — notify-based fs watcher                  │
│  src-tauri/src/shell_env.rs — macOS PATH resolution                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  git2 (libgit2 bindings)
                                │  subprocess: git fetch/pull/push/rebase
┌───────────────────────────────▼──────────────────────────────────────┐
│                      Git Repository (disk)                            │
│  All reads: git2::Repository opened fresh per command in             │
│  spawn_blocking. All writes: git2 API (except remote ops which       │
│  shell out to `git` subprocess for progress streaming).              │
└──────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `App.svelte` | Tab lifecycle, global layout state, keyboard shortcuts, window events, `repo-changed` dirty tracking | `src/App.svelte` |
| `RepoView.svelte` | Per-repo orchestration: commit selection, staging selection, diff state, `refreshSignal`, repo-changed listener | `src/components/RepoView.svelte` |
| `CommitGraph.svelte` | Fetches & paginates commit history, renders 4-layer graph pipeline, context menus, search | `src/components/CommitGraph.svelte` |
| `BranchSidebar.svelte` | Lists local/remote branches, tags, stashes; checkout/create/delete | `src/components/BranchSidebar.svelte` |
| `StagingPanel.svelte` | Shows working tree status, stage/unstage/discard per file and hunk | `src/components/StagingPanel.svelte` |
| `DiffPanel.svelte` | Orchestrates diff view mode (inline/split, hunk/full) | `src/components/DiffPanel.svelte` |
| `Toolbar.svelte` | Fetch/pull/push buttons, remote progress display, undo/redo buttons | `src/components/Toolbar.svelte` |
| `RebaseEditor.svelte` | Interactive rebase todo list UI | `src/components/RebaseEditor.svelte` |
| `MergeEditor.svelte` | Three-way merge conflict editor | `src/components/MergeEditor.svelte` |
| `invoke.ts` | Wraps `@tauri-apps/api/core invoke`, parses JSON error strings into `TrunkError` | `src/lib/invoke.ts` |
| `store.ts` | All persistent preferences via `@tauri-apps/plugin-store` (`trunk-prefs.json`) | `src/lib/store.ts` |
| `toast.svelte.ts` | Global toast notification state using module-level `$state` | `src/lib/toast.svelte.ts` |
| `remote-state.svelte.ts` | Per-tab remote operation state (`isRunning`, `progressLine`, `error`) | `src/lib/remote-state.svelte.ts` |
| `undo-redo.svelte.ts` | Per-tab redo stack (client-side, mirrors backend undo log) | `src/lib/undo-redo.svelte.ts` |
| `commands/repo.rs` | `open_repo`, `close_repo`, `force_close_repo` — loads cache, starts watcher | `src-tauri/src/commands/repo.rs` |
| `commands/history.rs` | `get_commit_graph`, `refresh_commit_graph`, `search_commits` — reads from `CommitCache` | `src-tauri/src/commands/history.rs` |
| `commands/staging.rs` | Full staging surface: status, stage/unstage/discard file/hunk/lines | `src-tauri/src/commands/staging.rs` |
| `commands/diff.rs` | `diff_unstaged`, `diff_staged`, `diff_commit`, `diff_commit_file`, `list_commit_files`, `list_compare_files`, `diff_compare_file`, `get_commit_detail` — the compare pair diffs any two commit trees (Base → Target, no ancestry required; null Base = empty tree); highlighting parses a bounded window above each side's first displayed line, with no cache and no warming | `src-tauri/src/commands/diff.rs` |
| `commands/branches.rs` | `list_refs`, `resolve_ref`, `checkout_branch`, `fast_forward_to`, `create_branch`, `delete_branch`, `rename_branch` | `src-tauri/src/commands/branches.rs` |
| `commands/remote.rs` | `git_fetch`, `git_fetch_background`, `git_pull`, `git_push`, `delete_remote_branch`, `cancel_remote_op` — subprocess with progress streaming | `src-tauri/src/commands/remote.rs` |
| `commands/commit.rs` | `create_commit`, `amend_commit`, `get_head_commit_message` | `src-tauri/src/commands/commit.rs` |
| `commands/commit_actions.rs` | `checkout_commit`, `create_tag`, `delete_tag`, `cherry_pick`, `revert_commit`, `reset_to_commit`, `undo_commit`, `redo_commit`, `check_undo_available` | `src-tauri/src/commands/commit_actions.rs` |
| `commands/stash.rs` | `list_stashes`, `stash_save`, `stash_pop`, `stash_apply`, `stash_drop` | `src-tauri/src/commands/stash.rs` |
| `commands/operation_state.rs` | `get_operation_state`, `merge_continue/abort`, `rebase_continue/skip/abort`, `merge_branch`, `rebase_branch` | `src-tauri/src/commands/operation_state.rs` |
| `commands/interactive_rebase.rs` | `get_rebase_todo`, `get_fork_point`, `start_interactive_rebase` | `src-tauri/src/commands/interactive_rebase.rs` |
| `commands/merge_editor.rs` | `get_merge_sides`, `save_merge_result` | `src-tauri/src/commands/merge_editor.rs` |
| `git/graph.rs` | `walk_commits()` = `capture()` piped into `graph_input::layout()` — commit ordering and every git2 read the pipeline makes | `src-tauri/src/git/graph.rs` |
| `git/placement.rs` | `assign_lanes()` — the pure lane assignment algorithm, columns, colours and edges | `src-tauri/src/git/placement.rs` |
| `git/graph_input.rs` | `layout()` — page slice and row hydration, and the committed capture format the golden suite reads | `src-tauri/src/git/graph_input.rs` |
| `git/repository.rs` | `validate_and_open()`, `build_ref_map()` | `src-tauri/src/git/repository.rs` |
| `git/types.rs` | All Rust DTOs (`GraphCommit`, `FileDiff`, `WorkingTreeStatus`, etc.) — no git2 types, all owned | `src-tauri/src/git/types.rs` |
| `state.rs` | `RepoState`, `CommitCache`, `RunningOp` — all `Mutex<HashMap<String, …>>` keyed by repo path | `src-tauri/src/state.rs` |
| `watcher.rs` | `start_watcher` / `stop_watcher` — `notify_debouncer_mini` emitting `"repo-changed"` events; `WatcherState::disabled()` turns the watch off | `src-tauri/src/watcher.rs` |

## Pattern Overview

**Overall:** Event-driven desktop app with strict frontend/backend separation via Tauri IPC.

**Key Characteristics:**
- Frontend is stateful (Svelte 5 `$state`/`$derived`) but never touches git directly — all git operations are `invoke(...)` calls
- Backend is stateless per-command: each command receives Tauri-managed state via `State<'_, T>` and opens a fresh `git2::Repository` inside `spawn_blocking`
- `git2::Repository` is not `Sync` — it is NEVER stored in `RepoState`. Only `PathBuf` is stored. Every command calls `git2::Repository::open(path)` fresh.
- Events flow backend→frontend via Tauri `Emitter`: `"repo-changed"` (fs watcher + after write ops) and `"remote-progress"` (per stderr line of git subprocess)
- Remote ops (fetch/pull/push) shell out to `git` subprocess for real-time progress streaming; all other git ops use git2 API directly

## Layers

**Frontend UI Layer:**
- Purpose: User interaction, state display, keyboard shortcuts, layout management
- Location: `src/components/`
- Contains: Svelte 5 components, each co-located with a `.test.ts` file
- Depends on: `src/lib/` utilities, `invoke()` for all data
- Used by: Nothing (top of stack)

**Frontend Library Layer:**
- Purpose: Pure utilities, IPC wrapper, Svelte reactive stores
- Location: `src/lib/`
- Contains: `invoke.ts`, `store.ts`, `toast.svelte.ts`, `remote-state.svelte.ts`, `undo-redo.svelte.ts`, `types.ts`, graph pipeline utilities
- Depends on: `@tauri-apps/api/*` plugins
- Used by: `src/components/`

**Commit Graph Pipeline (TypeScript, 4 layers):**
- Layer 1 (Rust): `graph::walk_commits()` assigns columns, colors, edge types → `GraphCommit[]`
- Layer 2 (TS): `buildGraphData()` in `src/lib/active-lanes.ts` → `OverlayGraphData` (nodes + connections)
- Layer 3 (TS): `buildOverlayPaths()` in `src/lib/overlay-paths.ts` → SVG path strings
- Culling (TS): `getVisibleOverlayElements()` in `src/lib/overlay-visible.ts` drops off-screen paths, dots and pills
- Layer 4 (Svelte): `CommitGraph.svelte` renders SVG dots, paths, ref pills via `VirtualList.svelte`
- Binding rules for this pipeline: `.claude/rules/commit-graph.md`

**Tauri Command Layer:**
- Purpose: Receive IPC calls, validate state, dispatch to git layer
- Location: `src-tauri/src/commands/`
- Contains: 12 command modules, each a thin coordinator (open repo from state, call git fn, update cache, emit events)
- Depends on: `src-tauri/src/git/`, `src-tauri/src/state.rs`
- Used by: Frontend via `invoke()`

**Git Abstraction Layer:**
- Purpose: All git2-based logic — pure functions operating on `git2::Repository`
- Location: `src-tauri/src/git/`
- Contains: `graph.rs` (the repository read), `placement.rs` (the pure lane algorithm), `graph_input.rs` (page hydration), `repository.rs` (shared helpers), `types.rs` (DTOs), `syntax.rs` (syntax highlighting)
- Depends on: `git2` crate, `syntect` (for syntax highlighting)
- Used by: `src-tauri/src/commands/`

**Managed State Layer:**
- Purpose: Cross-command shared state, Tauri-managed singletons
- Location: `src-tauri/src/state.rs`, `src-tauri/src/watcher.rs`
- Contains: `RepoState` (path registry), `CommitCache` (full graph per repo), `RunningOp` (PID for cancel), `WatcherState` (fs watchers)
- All state is `Mutex<HashMap<String, T>>` keyed by repo path string. `WatcherState` wraps that map beside an `enabled` flag: `WatcherState::disabled()` makes `start_watcher` register nothing, which is how a test host runs `open_repo` unchanged with no filesystem watch
- Used by: All command modules via `State<'_, T>` injection

## Data Flow

### Primary Request Path: Open Repository

1. User picks repo path via `tauri-plugin-dialog` → `WelcomeScreen.svelte` calls `safeInvoke("open_repo", { path })` (`src/lib/invoke.ts:10`)
2. Rust `open_repo` command (`src-tauri/src/commands/repo.rs:8`) runs `repository::validate_and_open()`, then calls `graph::walk_commits()` in `spawn_blocking`
3. Graph result cached in `CommitCache`, repo path registered in `RepoState`, `start_watcher()` called for path
4. Frontend receives `Ok(())`, updates `tabs` state in `App.svelte`, renders `RepoView.svelte`
5. `RepoView` → `CommitGraph` calls `safeInvoke("get_commit_graph", { path, offset: 0 })` → returns first 200 `GraphCommit` rows from cache
6. `CommitGraph` runs `buildGraphData()` → `buildOverlayPaths()` → renders SVG overlay via `VirtualList`

### Filesystem Change Path

1. `notify_debouncer_mini` detects change in watched repo directory (300ms debounce)
2. `watcher.rs:start_watcher` emits Tauri event `"repo-changed"` with repo path string
3. `App.svelte` listener calls `safeInvoke("get_dirty_counts", { path })` → updates `tab.dirty` badge
4. `RepoView.svelte` listener increments `refreshSignal` → `CommitGraph` and `StagingPanel` re-fetch
5. `Toolbar.svelte` listener calls `check_undo_available` to update undo button state

### Staging a File

1. User clicks stage button in `StagingPanel.svelte` → calls `safeInvoke("stage_file", { path, filePath })`
2. Rust `stage_file` (`src-tauri/src/commands/staging.rs`) opens fresh `git2::Repository`, calls `repo.index().add_path()`, writes index
3. Returns `Ok(())` → frontend calls `emit("repo-changed", path)` indirectly via watcher (or directly refreshes)
4. `StagingPanel` re-fetches status; `DiffPanel` re-fetches diff

### Remote Operation (Fetch/Pull/Push) Path

1. User clicks Fetch in `Toolbar.svelte` → `safeInvoke("git_fetch", { path })`
2. Rust `git_fetch` (`src-tauri/src/commands/remote.rs:159`) calls `run_git_remote()` which spawns `git fetch --all --progress` subprocess
3. PID stored in `RunningOp` for cancel support; stderr lines emitted as `"remote-progress"` events per line
4. `Toolbar.svelte` listens to `"remote-progress"` → updates `remoteState.progressLine`
5. On subprocess exit: cache refreshed via `refresh_graph()`, `"repo-changed"` event emitted
6. Frontend graph auto-refreshes via step 3-5 of Filesystem Change Path

### Background Periodic Fetch

1. `RepoView.svelte` sets up a `setInterval` using `getFetchIntervalMs()` (default 60s) when `windowVisible` is true
2. Calls `safeInvoke("git_fetch_background", { path })` — a silent best-effort fetch
3. Rust `git_fetch_background` skips if repo is in non-clean state (merge/rebase in progress) or another op is running
4. On success emits `"repo-changed"` → triggers normal refresh cycle

**State Management:**
- `App.svelte` owns: tab array, active tab, layout dimensions (pane widths, zoom) — all `$state`
- `RepoView.svelte` owns: per-repo selection state (selected commit OID, selected file, dirty counts, head branch) — all `$state`
- `App.svelte` creates per-tab `RemoteState` and `UndoRedoManager` via factory functions and passes them as props to `RepoView` and `Toolbar`
- `toast.svelte.ts` and `undo-redo.svelte.ts` use module-level `$state` as lightweight global stores (toast is truly global; undo-redo has a singleton shim but the canonical API is per-tab factory)
- Persistence via `@tauri-apps/plugin-store` (`trunk-prefs.json`) through `src/lib/store.ts`

## Key Abstractions

**`TrunkError` (Rust + TypeScript mirror):**
- Purpose: Typed error transport across IPC boundary
- Rust: `src-tauri/src/error.rs` — `{ code: String, message: String }`, serialized as JSON string (not Tauri's native error type)
- TypeScript: `src/lib/invoke.ts:5` — `safeInvoke` parses the JSON string back into `TrunkError`
- Pattern: All commands return `Result<T, String>` where `Err` is `serde_json::to_string(&TrunkError{...})`

**`GraphCommit` DTO:**
- Purpose: Complete per-commit graph data crossing the IPC boundary
- Rust: `src-tauri/src/git/types.rs`, `GraphCommit` — owned types only, no git2 lifetimes
- TypeScript mirror: `src/lib/types.ts`, `GraphCommit`
- Contains: OID, summary, author, column assignment, color index, edges, ref labels, flags (is_head, is_merge, is_stash)

**`CommitCache`:**
- Purpose: Full walk of all commits cached in memory, served in 200-row pages
- Location: `src-tauri/src/state.rs:32`
- Populated: On `open_repo`, refreshed on `refresh_commit_graph` and after each write op
- Consumed: `get_commit_graph` slices `[offset..offset+200]` from cache

**`RepoState` (path registry):**
- Purpose: Maps repo path strings to `PathBuf` — proof that a repo is "open"
- Location: `src-tauri/src/state.rs:8`
- Note: NEVER stores `git2::Repository` handles (not Sync). Every command opens fresh.

**`safeInvoke`:**
- Purpose: Single IPC call site that normalizes error handling
- Location: `src/lib/invoke.ts:10`
- Pattern: All frontend→backend calls go through this. Do not call `invoke()` directly.

## Entry Points

**Rust binary:**
- Location: `src-tauri/src/main.rs` (4 lines) — delegates to `trunk_lib::run()`
- Actual startup: `src-tauri/src/lib.rs:69` — `run()` hands `tauri::Builder::default()` plus `tauri_plugin_single_instance` to `configure<R>` (`lib.rs:88`), which adds every other plugin, the managed state and the `invoke_handler` table of all 115 commands, then calls `.run(generate_context!())`. `configure` is generic over the runtime so a test host can build the same application on `tauri::test::MockRuntime`

**Frontend HTML:**
- Location: `index.html` — loads `src/main.ts`

**Frontend TypeScript:**
- Location: `src/main.ts` — mounts `App.svelte` to `#app`

**Frontend root component:**
- Location: `src/App.svelte` — tab manager, layout, global listeners

**Tauri command surface (registered in `lib.rs`):**
- `repo`: `open_repo`, `close_repo`, `force_close_repo`
- `history`: `get_commit_graph`, `refresh_commit_graph`, `search_commits`
- `branches`: `list_refs`, `resolve_ref`, `checkout_branch`, `fast_forward_to`, `create_branch`, `delete_branch`, `rename_branch`
- `staging`: `get_dirty_counts`, `get_status`, `stage_file`, `unstage_file`, `stage_files`, `unstage_files`, `stage_all`, `unstage_all`, `discard_file`, `discard_all`, `stage_hunk`, `unstage_hunk`, `discard_hunk`, `stage_lines`, `unstage_lines`, `discard_lines`
- `commit`: `create_commit`, `amend_commit`, `get_head_commit_message`
- `diff`: `diff_unstaged`, `diff_staged`, `diff_commit`, `list_commit_files`, `diff_commit_file`, `list_compare_files`, `diff_compare_file`, `get_commit_detail`
- `stash`: `list_stashes`, `stash_save`, `stash_pop`, `stash_apply`, `stash_drop`
- `commit_actions`: `checkout_commit`, `create_tag`, `delete_tag`, `cherry_pick`, `revert_commit`, `reset_to_commit`, `undo_commit`, `redo_commit`, `check_undo_available`
- `remote`: `git_fetch`, `git_fetch_background`, `git_pull`, `git_push`, `delete_remote_branch`, `cancel_remote_op`
- `operation_state`: `get_operation_state`, `merge_continue`, `merge_abort`, `rebase_continue`, `rebase_skip`, `rebase_abort`, `merge_branch`, `rebase_branch`
- `merge_editor`: `get_merge_sides`, `save_merge_result`
- `interactive_rebase`: `get_rebase_todo`, `get_fork_point`, `start_interactive_rebase`

## Architectural Constraints

- **Threading:** Tauri uses tokio async runtime. All git2 calls run in `spawn_blocking` because git2 is synchronous. Remote ops use `tokio::process::Command` for async subprocess with stderr streaming.
- **git2 not Sync:** `git2::Repository` cannot be stored in shared state. Each command opens its own fresh `Repository` handle. Constraint is documented in `src-tauri/src/state.rs:5`.
- **No git shelling out for local ops:** All local git operations (stage, commit, checkout, etc.) use git2 API. Only remote ops (fetch/pull/push/delete-remote-branch, rebase/merge message editing) shell out — documented in `CLAUDE.md`.
- **Global state:** `RepoState`, `CommitCache`, `RunningOp`, `WatcherState` are module-level singletons managed by Tauri, each holding a `Mutex<HashMap<String, T>>` keyed by repo path string. `WatcherState` is the one with a second field, `enabled`, and it is passed into `configure` rather than constructed there, because `Builder::manage` panics on a duplicate type.
- **Circular imports:** None detected. Frontend has a clear dependency direction: `components/` → `lib/` → `@tauri-apps/`.
- **macOS PATH:** `src-tauri/src/shell_env.rs` uses `/usr/libexec/path_helper` to resolve full system PATH for git subprocess calls — required because GUI apps inherit a minimal launchd PATH.
- **Multi-tab:** All backend state is keyed by repo path string. Multiple tabs can have the same or different repos open simultaneously. Per-tab frontend state (`RemoteState`, `UndoRedoManager`) is created in `App.svelte` via factory functions and passed as props.

## Anti-Patterns

### Bypassing `safeInvoke`

**What happens:** Calling `invoke()` from `@tauri-apps/api/core` directly in a component.
**Why it's wrong:** IPC errors arrive as JSON strings, not `Error` objects. Direct `invoke()` calls will have `undefined` in `catch(e) { e.message }`.
**Do this instead:** Always use `safeInvoke()` from `src/lib/invoke.ts`. It parses the JSON error string into a typed `TrunkError`.

### Storing git2 Types in State

**What happens:** Storing `git2::Repository`, `Commit<'repo>`, or any lifetime-bearing git2 type in `RepoState` or another `Tauri::State`.
**Why it's wrong:** `git2::Repository` is not `Sync` — the compiler will reject it.
**Do this instead:** Store only `PathBuf` in `RepoState`. Call `git2::Repository::open(path)` fresh inside `spawn_blocking` in each command.

### Fixing Graph Layers Cross-Layer

**What happens:** Post-processing `buildGraphData()` output in `CommitGraph.svelte` to compensate for something `graph.rs` should have done (or vice versa).
**Do this instead:** Fix the stage that owns the data. The prohibition and its reasoning are a binding rule in `.claude/rules/commit-graph.md`; `docs/architecture/commit-graph.md` has the stage ownership.

## Error Handling

**Strategy:** Typed error transport via JSON serialization across IPC boundary.

**Patterns:**
- Rust commands return `Result<T, String>` where `Err` is always `serde_json::to_string(&TrunkError{...}).unwrap()`
- `TrunkError` has a string `code` (e.g., `"not_open"`, `"auth_failure"`, `"dirty_workdir"`) and a human-readable `message`
- `safeInvoke` on the frontend parses the JSON string back into a typed `TrunkError` object and rethrows
- Components `catch` the typed error and either show a toast (`showToast(e.message, "error")`) or display inline error state
- Remote op errors are classified by `classify_git_error()` in `src-tauri/src/commands/remote.rs:15` which maps stderr substrings to error codes

## Cross-Cutting Concerns

**Logging:** No structured logging framework — Rust uses `eprintln!` sparingly; frontend uses `console.error` for non-fatal catch blocks.
**Validation:** Input validation in Rust commands (repo path must be in `RepoState`, OIDs parsed via `git2::Oid::from_str()`). No frontend validation layer.
**Authentication:** No app-level auth. Git remote auth is handled by the `git` subprocess using the user's existing credentials (SSH agent, credential helper, etc.).
**Persistence:** `@tauri-apps/plugin-store` → `trunk-prefs.json` via `src/lib/store.ts`. Covers: recent repos, open tabs, zoom level, pane sizes, column visibility/widths, diff preferences, fetch interval.

---

*Architecture analysis: 2026-05-14*
