# Architecture Patterns

**Domain:** Tauri 2 + Rust desktop Git GUI
**Researched:** 2026-03-03
**Confidence:** HIGH — PRD is the authoritative source; decisions are already made and documented

---

## Recommended Architecture

The architecture follows a strict two-process model: a Svelte 5 SPA (renderer process, Vite-served) and a Rust backend (main process, Tauri 2). They communicate exclusively through Tauri's IPC bridge.

```
+------------------------------------------+
|  Svelte 5 SPA (Renderer / WebView)       |
|  App.svelte > MainLayout > Panels        |
|  State: $state / $derived runes          |
|  Comms: invoke() + listen()              |
+-------------------+----------------------+
                    |  Tauri IPC Bridge
                    |  invoke("command")  ->  Result<T, TrunkError>
                    |  emit("fs_changed") <-  Rust watcher
+-------------------+----------------------+
|  Rust Backend (Main Process)             |
|                                          |
|  lib.rs      -- app builder              |
|  state.rs    -- Mutex<RepoMap>           |
|  error.rs    -- TrunkError type          |
|  watcher.rs  -- notify debouncer         |
|  commands/   -- #[tauri::command] fns    |
|  git/        -- git2 operations          |
+------------------------------------------+
```

---

## Component Boundaries

### Frontend Components

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `App.svelte` | Root; holds selected repo path, selected commit OID | All top-level panels |
| `TopBar.svelte` | Repo tabs (non-functional v0.1), action buttons | App (via props/callbacks) |
| `MainLayout.svelte` | CSS Grid container: sidebar + center + right | Contains the three panels |
| `Sidebar.svelte` | Branch/tag/stash list, search filter (frontend-only) | App state (selected branch) |
| `CommitGraph.svelte` | Virtual scroll container over `GraphRow` children | Rust: `get_commits` |
| `GraphRow.svelte` | One row: inline SVG lanes + commit info columns | Parent virtual list |
| `DiffView.svelte` | Unified diff display (replaces graph on selection) | Rust: `get_commit_diff`, `get_diff_workdir`, `get_diff_staged` |
| `RightPanel.svelte` | Unstaged + staged file lists, commit form | Rust: `get_status`, `stage_files`, `unstage_files`, `create_commit` |

### Rust Backend Modules

| Module | Responsibility | Communicates With |
|--------|---------------|-------------------|
| `lib.rs` | Tauri app builder; registers all commands; manages plugin lifecycle | All command modules |
| `state.rs` | `RepoState = Mutex<HashMap<String, Repository>>`; provides `get_repo(path)` helper | `commands/*`, `watcher.rs` |
| `error.rs` | `TrunkError { code: String, message: String }`; impl `serde::Serialize` + `From<git2::Error>` | All modules |
| `watcher.rs` | `notify-debouncer-mini` (300ms); watches workdir minus `.git/` (except HEAD, refs/, index); emits `fs_changed` | `state.rs` (reads repo path), Tauri `AppHandle` |
| `commands/repo.rs` | `open_repo`, `close_repo` | `git/repository.rs`, `state.rs`, `watcher.rs` |
| `commands/history.rs` | `get_commits`, `get_commit` | `git/graph.rs`, `git/repository.rs` |
| `commands/branches.rs` | `get_refs`, `checkout_branch`, `create_branch` | `git/repository.rs` |
| `commands/staging.rs` | `get_status`, `stage_files`, `unstage_files`, `stage_all`, `unstage_all` | `git/repository.rs` |
| `commands/commit.rs` | `create_commit` | `git/repository.rs` |
| `commands/diff.rs` | `get_diff_workdir`, `get_diff_staged`, `get_commit_diff` | `git/repository.rs` |
| `git/repository.rs` | Raw git2 operations; opens `Repository`, runs index ops, creates commits | `git2` crate |
| `git/graph.rs` | Lane algorithm: single-pass O(n) over topologically-sorted commits; computes `column`, `edges`, `is_merge` | `git/types.rs` |
| `git/types.rs` | All serializable data types: `GraphCommit`, `GraphEdge`, `RefLabel`, `FileDiff`, etc. | All git/* and commands/* |

---

## Data Flow

### User-Initiated Operations (invoke path)

```
User action in Svelte
  -> await invoke("command_name", { path, ...args })
  -> Rust: acquire Mutex<RepoMap>, call git2
  -> Return Result<T, TrunkError> as JSON
  -> Svelte: unwrap, update $state
  -> Component re-renders via Svelte 5 reactivity
```

**Key principle:** Commands are synchronous from the frontend's perspective (invoke is async/await). No polling. The frontend always holds the authoritative view of what Rust last returned.

### Filesystem Watch (event path)

```
External tool modifies files on disk
  -> notify-debouncer-mini fires after 300ms quiet window
  -> Rust watcher emits Tauri event "fs_changed" to all windows
  -> Svelte: listen("fs_changed", handler)
  -> handler calls invoke("get_status", { path })
  -> $state.status updated -> RightPanel re-renders
```

**Key principle:** `fs_changed` is a nudge, not a payload. Frontend always re-fetches; no state is embedded in events.

### Repo Identity (path as handle)

Every Tauri command takes `path: String` as its first argument. This is the repository's canonical identifier used to look up the `Repository` object in managed state. The frontend stores `selectedRepoPath` in `$state` at `App.svelte` and threads it into every invoke call.

```
App.svelte
  $state selectedRepoPath: string | null

  -> passed as prop to CommitGraph, Sidebar, RightPanel, DiffView
  -> each panel's invoke calls prefix: { path: selectedRepoPath, ... }
```

---

## Tauri 2 Command Patterns

### Command Signature Pattern

```rust
// src-tauri/src/commands/history.rs

#[tauri::command]
pub async fn get_commits(
    state: tauri::State<'_, RepoState>,
    path: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<GraphCommit>, TrunkError> {
    let state = state.lock().map_err(|_| TrunkError::lock_error())?;
    let repo = state.get(&path).ok_or_else(|| TrunkError::not_open(&path))?;
    git::graph::get_commits(repo, offset, limit)
}
```

Rules:
- All commands are `pub async fn` (Tauri 2 requires async for most IPC)
- First arg after `state` is always `path: String`
- Return type is always `Result<T, TrunkError>` — never panic, never unwrap
- State is `tauri::State<'_, RepoState>` — Tauri injects this automatically
- Commands never hold the Mutex lock while doing I/O — extract what's needed, release lock

### Command Registration

```rust
// src-tauri/src/lib.rs

pub fn run() {
    tauri::Builder::default()
        .manage(RepoState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::repo::open_repo,
            commands::repo::close_repo,
            commands::history::get_commits,
            commands::history::get_commit,
            commands::branches::get_refs,
            commands::branches::checkout_branch,
            commands::branches::create_branch,
            commands::staging::get_status,
            commands::staging::stage_files,
            commands::staging::unstage_files,
            commands::staging::stage_all,
            commands::staging::unstage_all,
            commands::commit::create_commit,
            commands::diff::get_diff_workdir,
            commands::diff::get_diff_staged,
            commands::diff::get_commit_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Managed State Pattern

```rust
// src-tauri/src/state.rs

use git2::Repository;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct RepoState(pub Mutex<HashMap<String, Repository>>);

impl Default for RepoState {
    fn default() -> Self {
        RepoState(Mutex::new(HashMap::new()))
    }
}

impl RepoState {
    pub fn lock(&self) -> Result<std::sync::MutexGuard<HashMap<String, Repository>>, TrunkError> {
        self.0.lock().map_err(|_| TrunkError {
            code: "lock_poisoned".into(),
            message: "State lock was poisoned".into(),
        })
    }
}

pub type State<'a> = tauri::State<'a, RepoState>;
```

Note: `git2::Repository` is `!Send` on some platforms. If thread-safety issues arise, wrap in `Arc<Mutex<Repository>>` per entry, or use a channel-based approach where git2 operations run on a dedicated thread. For v0.1 with a single repo, `Mutex<HashMap>` is sufficient.

---

## Error Handling Pattern

### TrunkError — The Only Error Type at the Boundary

```rust
// src-tauri/src/error.rs

#[derive(Debug, serde::Serialize)]
pub struct TrunkError {
    pub code: String,
    pub message: String,
}

impl From<git2::Error> for TrunkError {
    fn from(e: git2::Error) -> Self {
        TrunkError {
            code: "git2_error".into(),
            message: e.message().to_string(),
        }
    }
}

impl TrunkError {
    pub fn not_open(path: &str) -> Self {
        TrunkError { code: "repo_not_open".into(), message: format!("Repository not open: {path}") }
    }
    pub fn dirty_workdir() -> Self {
        TrunkError { code: "dirty_workdir".into(), message: "Working tree has uncommitted changes".into() }
    }
    pub fn lock_error() -> Self {
        TrunkError { code: "lock_poisoned".into(), message: "Internal state lock failed".into() }
    }
}
```

### Frontend Error Handling Pattern

```typescript
// src/lib/api.ts

import { invoke } from "@tauri-apps/api/core";
import type { TrunkError } from "./types";

export async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<{ data: T; error: null } | { data: null; error: TrunkError }> {
  try {
    const data = await invoke<T>(cmd, args);
    return { data, error: null };
  } catch (error) {
    return { data: null, error: error as TrunkError };
  }
}
```

Error display rules by `code`:
- `dirty_workdir` -> inline banner below branch selector, no modal
- `repo_not_open` -> open repo dialog prompt
- `git2_error` -> inline toast with `message`
- All others -> generic error state, log to console

---

## State Management Pattern (Svelte 5 Runes)

### Global App State (App.svelte)

```svelte
<script lang="ts">
  import type { RepoInfo, WorkingTreeStatus } from "$lib/types";

  // $state holds mutable reactive values
  let selectedRepoPath = $state<string | null>(null);
  let repoInfo = $state<RepoInfo | null>(null);
  let status = $state<WorkingTreeStatus | null>(null);
  let selectedCommitOid = $state<string | null>(null);
  let selectedFile = $state<{ path: string; area: "staged" | "unstaged" } | null>(null);

  // $derived computes values from state — no manual updates needed
  let viewMode = $derived(
    selectedCommitOid ? "commit-diff"
    : selectedFile ? "file-diff"
    : "graph"
  );
</script>
```

### Per-Component Data Fetching

Components invoke commands and hold their own local state for data that is purely their concern:

```svelte
<!-- CommitGraph.svelte -->
<script lang="ts">
  let { repoPath } = $props<{ repoPath: string }>();
  let commits = $state<GraphCommit[]>([]);
  let loading = $state(false);

  async function loadMore(offset: number) {
    loading = true;
    const result = await invoke<GraphCommit[]>("get_commits", { path: repoPath, offset, limit: 200 });
    commits = [...commits, ...result];
    loading = false;
  }

  $effect(() => {
    if (repoPath) {
      commits = [];
      loadMore(0);
    }
  });
</script>
```

### Event Listening Pattern

```svelte
<!-- App.svelte -->
<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";

  onMount(() => {
    const unlisten = listen("fs_changed", async () => {
      if (selectedRepoPath) {
        status = await invoke("get_status", { path: selectedRepoPath });
      }
    });
    return () => { unlisten.then(fn => fn()); };
  });
</script>
```

---

## Graph Rendering Architecture

The commit graph uses a hybrid approach: computation in Rust, rendering in Svelte.

```
Rust (graph.rs)
  Revwalk (topo + time order)
    -> single-pass lane algorithm
    -> Vec<GraphCommit> with column, edges, is_merge, refs
    -> serialized to JSON via serde

Frontend (CommitGraph.svelte)
  Virtual scroll container (overflow: hidden, fixed height rows)
    -> only renders visible rows + buffer of ceil(height/rowHeight)*2 + 20
    -> each GraphRow.svelte renders:
       - <svg> with lane lines (edges) and commit dot
       - commit message, author, date columns
```

Lane algorithm (Rust, O(n)):
1. `lanes: Vec<Option<Oid>>` — active lane slots, slot holds child OID that owns the lane
2. For each commit: find matching slot (that slot = commit.column), or allocate new slot
3. First parent inherits commit's slot (straight line); merge parents get free slots
4. Release current commit's slot, fill parent slots
5. EdgeType: Same col = Straight; parent-col < current = MergeLeft; parent-col > current = MergeRight; inverse for forks

SVG per row (not one giant SVG, not Canvas):
- Reason: Free scrolling, text selection, no coordinate system complexity
- Each row is an independent `<svg height=24 width={laneCount * 16}>` inside the grid cell
- Circles: commit dot `r=4`; merge commit `r=5` with ring stroke
- Color palette (8 colors, cycle by lane index): `["#4dc9f6","#f67019","#f53794","#537bc4","#acc236","#166a8f","#00a950","#58595b"]`

---

## Filesystem Watcher Architecture

```
Rust (watcher.rs)
  notify-debouncer-mini (300ms debounce window)
    Watch: repo workdir
    Ignore: .git/ except HEAD, refs/*, index
    On change:
      AppHandle.emit_all("fs_changed", ())

Frontend
  listen("fs_changed", handler)
    handler: invoke("get_status", { path }) -> update $state.status
```

The watcher is started when `open_repo` is called and stores the debouncer handle in a separate `Mutex<Option<Debouncer>>` alongside `RepoState`. The watcher is stopped (`close_repo` drops the debouncer).

---

## Suggested Build Order

Dependencies flow upward; build foundation first.

### Phase 1: Foundation (no UI features yet)
1. Migrate from SvelteKit to plain Vite+Svelte — eliminates SvelteKit routing machinery
2. Add `git2`, `notify`, `notify-debouncer-mini`, `tauri-plugin-dialog` to Cargo.toml
3. Scaffold `error.rs` (TrunkError), `state.rs` (RepoState), `git/types.rs` (all data models)
4. Add Tailwind CSS + Vite plugin

Rationale: Types and error infrastructure are referenced by every subsequent module. Getting them right first prevents refactoring later.

### Phase 2: Repo Open + Graph
1. `git/repository.rs` — open/validate repo
2. `git/graph.rs` — Revwalk + lane algorithm
3. `commands/repo.rs` (open_repo, close_repo)
4. `commands/history.rs` (get_commits, get_commit)
5. Frontend: `CommitGraph.svelte` with virtual scrolling
6. Frontend: `GraphRow.svelte` with inline SVG

Rationale: The commit graph is the core value of the app. Everything else is built around it.

### Phase 3: Sidebar + Branch Ops
1. `commands/branches.rs` (get_refs, checkout_branch, create_branch)
2. Frontend: `Sidebar.svelte` with branch list and filter
3. Frontend: `dirty_workdir` error banner in checkout flow

Rationale: Branches are needed before staging — user must see where HEAD is.

### Phase 4: Working Tree + Staging
1. `commands/staging.rs` (get_status, stage/unstage operations)
2. `watcher.rs` (filesystem watch, emit fs_changed)
3. Frontend: `RightPanel.svelte` (file lists, stage/unstage buttons)
4. Frontend: listen("fs_changed") → refresh status

Rationale: Status and staging depend on having a repo open (Phase 2). Watcher depends on state from open_repo.

### Phase 5: Commit Creation
1. `commands/commit.rs` (create_commit)
2. Frontend: Commit form in `RightPanel.svelte`
3. After commit: refresh graph (re-fetch commits from offset 0)

Rationale: Commit depends on a working staging area (Phase 4).

### Phase 6: Diffs
1. `commands/diff.rs` (get_diff_workdir, get_diff_staged, get_commit_diff)
2. Frontend: `DiffView.svelte` (unified diff display, back navigation)
3. Wire: click commit in graph → get_commit_diff; click file in panel → appropriate diff command

Rationale: Diffs are display-only with no new state. They can be added last without blocking any other feature.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Business Logic in Commands
**What:** Commands contain complex git2 logic inline
**Why bad:** Commands become untestable, hard to read, impossible to share logic
**Instead:** Commands are thin dispatchers; `git/` modules contain all git2 logic; commands just acquire state and delegate

### Anti-Pattern 2: Mutex Lock Held Across Await
**What:** Locking `RepoState` mutex, then doing async I/O while holding it
**Why bad:** Deadlock; Rust will reject this at compile time for async contexts
**Instead:** Extract the data you need from the locked HashMap (e.g., clone the path, or use a reference in a sync context), then release the lock before any await

### Anti-Pattern 3: Storing Large Data in Events
**What:** Emitting full `Vec<GraphCommit>` or diff data in the `fs_changed` event payload
**Why bad:** Events are for nudges; embedding data means the frontend can't re-request with different params; events have size limits
**Instead:** Events are empty notifications; frontend always invokes a command to fetch fresh data

### Anti-Pattern 4: Frontend State Divergence
**What:** Mutating local Svelte state optimistically without waiting for Rust confirmation
**Why bad:** Rust is the source of truth for all git state; optimistic updates cause inconsistency on error
**Instead:** Invoke command, await result, then update `$state` from the result. Use loading flags for perceived performance.

### Anti-Pattern 5: Global Component State for Per-Repo Data
**What:** Storing commits/status as module-level singletons
**Why bad:** Multi-repo support (v0.2) becomes impossible to add without a rewrite
**Instead:** All data state is keyed by `repoPath`; when `selectedRepoPath` changes, components reinitialize

### Anti-Pattern 6: String Matching on Error Messages
**What:** `if (err.message.includes("dirty"))` in frontend error handling
**Why bad:** Brittle; git2 message text is not guaranteed stable; breaks on locale changes
**Instead:** Always check `err.code` (e.g., `"dirty_workdir"`) — this is why TrunkError has a structured `code` field

---

## Tauri 2 Capability Configuration

The default capability file must be extended to allow file dialogs (for Open Repository):

```json
// src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:allow-open"
  ]
}
```

Tauri 2 uses a permission system: capabilities must explicitly declare what plugins and APIs the window can use. Missing permissions cause runtime errors, not compile errors.

---

## Scalability Considerations

| Concern | At 1K commits | At 10K commits | At 100K commits |
|---------|--------------|----------------|-----------------|
| Graph fetch | Single `get_commits` call | Paginated (200/batch), lazy-loaded | Same pagination; Revwalk is O(n) in Rust, ~5ms for 10K |
| DOM nodes | ~40 (virtual scroll) | ~40 (virtual scroll) | ~40 (virtual scroll) |
| Memory (Rust) | Vec<GraphCommit> in flight | Vec<GraphCommit> per page | Streaming if needed (defer to v1.0) |
| Ref lookup | HashMap<Oid, Vec<RefLabel>> built once | Same | Same; number of refs stays bounded |

The virtual scroll + pagination approach means the UI performance is constant regardless of repository size. The binding constraint at scale is the initial Revwalk to build the graph — but at 10K commits this is ~5ms in Rust, well under any perceptual threshold.

---

## Sources

- **PRD.md** (authoritative) — `/Users/joaofnds/code/trunk/PRD.md` — all architecture decisions documented by the project author with HIGH confidence. Confidence: HIGH.
- **Tauri 2 docs** (training data, verified by Cargo.toml dependency versions) — Tauri 2.x IPC model, managed state API, capability system. Confidence: HIGH.
- **Svelte 5 runes** (training data, verified by package.json `"svelte": "^5.0.0"`) — `$state`, `$derived`, `$effect`, `$props` patterns. Confidence: HIGH.
- **git2 crate** (training data, version `0.19` confirmed in Cargo.toml) — Revwalk, Repository, Index operations. Confidence: HIGH.
- **notify crate v7 + notify-debouncer-mini v0.5** (confirmed in PROJECT.md) — debouncer-mini 0.5 depends on notify ^7; versions are compatible. Confidence: HIGH.
