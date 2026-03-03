# Trunk -- PRD (Product Requirements Document)

## Context

Trunk is a new desktop Git GUI application built with Tauri 2 + Svelte 5 + Rust. The goal is a fast, native, cross-platform Git client comparable to GitKraken/Fork -- with a commit graph, branch management, staging workflow, and multi-repo support. The git backend uses the `git2` Rust crate (libgit2 bindings) for all read/write operations, with shell-out to `git` CLI reserved for remote operations in future milestones.

The project is currently a fresh Tauri+Svelte scaffold with the default "greet" example. No git-related code exists yet.

---

## Architecture

```
Svelte 5 UI (Vite SPA)  <--invoke/events-->  Rust Backend (Tauri 2 + git2)
```

- **Commands** (request/response): `invoke("command_name", { args })` maps to `#[tauri::command]` Rust functions. Used for all user-initiated operations.
- **Events** (push): Rust emits `fs_changed` via `notify` crate when files change on disk. Frontend re-fetches status.
- **State**: Rust holds `Mutex<HashMap<String, Repository>>` in Tauri managed state. Svelte uses runes (`$state`, `$derived`).

> **Note on SvelteKit vs plain Vite+Svelte**: The initial scaffold uses SvelteKit with `adapter-static`. For a Tauri desktop app with no server-side rendering or file-based routing needs, plain Vite+Svelte is simpler and avoids unnecessary machinery. Migrate away from SvelteKit before building any UI features.

### Rust Module Structure

```
src-tauri/src/
  lib.rs              -- Tauri app builder, command registration
  main.rs             -- Entry point
  commands/
    mod.rs, repo.rs, history.rs, branches.rs, staging.rs, commit.rs, diff.rs
  git/
    mod.rs, repository.rs, graph.rs, types.rs
  watcher.rs          -- Filesystem watcher (notify crate)
  error.rs            -- Unified error type
  state.rs            -- Tauri managed state
```

### Dependencies to Add

**Rust** (`Cargo.toml`): `git2 = "0.19"`, `notify = "7"`, `notify-debouncer-mini = "0.5"`
- `notify-debouncer-mini 0.5.x` depends on `notify ^7` -- versions are compatible.

**Frontend**: `tailwindcss`, `@tailwindcss/vite`. `@tauri-apps/api` already provides `invoke` and `listen`.

---

## UI Layout

```
+------------------------------------------------------------------+
|  TOP BAR (40px)                                                   |
|  [repo-tab] [+]           [Pull] [Push] [Branch] [Stash] [Pop]  |
+----------+-----------------------------------+-------------------+
|  SIDEBAR |  CENTER: COMMIT GRAPH             |  RIGHT PANEL      |
|  (200px) |  (flexible)                       |  (300px)          |
|          |                                   |                   |
|  Search  |  GRAPH | MSG | AUTHOR | DATE      |  Unstaged Files   |
|  LOCAL   |  -----row per commit------        |  Staged Files     |
|  REMOTE  |  (virtualized scrolling)          |  Commit Form      |
|  TAGS    |                                   |                   |
|  STASHES |                                   |                   |
+----------+-----------------------------------+-------------------+
```

### Component Tree

```
App.svelte
  TopBar.svelte (RepoTabs + ActionButtons)
  MainLayout.svelte (CSS Grid)
    Sidebar.svelte (SearchFilter + RefSection x4)
    CenterPanel.svelte
      CommitGraph.svelte (VirtualList > GraphRow > GraphLanes + CommitInfo)
      DiffView.svelte (shown when a commit or file is selected)
    RightPanel.svelte (FileList x2 + CommitForm)
```

### Styling

- Dark theme by default, CSS custom properties for future light theme
- Tailwind CSS for utility-based styling + scoped Svelte styles where needed
- Monospace for graph/diffs, sans-serif elsewhere
- Fixed panel proportions for v0.1 (resizable splitters in v0.2)

### Graph Rendering

- HTML grid with **inline SVG per row** (not one giant SVG or Canvas)
- Virtual scrolling: render only visible rows + a dynamic buffer of `ceil(viewportHeight / rowHeight) * 2 + 20` rows
- Lane spacing: 16px per lane, commit dot as `<circle r=4>`; merge commits (parent count > 1) use `<circle r=5>` with a ring stroke to visually distinguish them
- Color palette by lane index: `["#4dc9f6", "#f67019", "#f53794", "#537bc4", "#acc236", "#166a8f", "#00a950", "#58595b"]`
- Graph lane algorithm runs in Rust (O(n), ~5ms for 10k commits)

#### Graph Lane Algorithm

The lane algorithm runs in a single pass over the topologically-sorted commit list:

1. Maintain a `lanes: Vec<Option<Oid>>` representing active lanes, where each slot holds the OID of the child commit that "owns" the lane (i.e., is waiting for this parent).
2. For each commit:
   a. Find its lane: locate the first slot in `lanes` where the value equals this commit's OID. That slot becomes `commit.column`.
   b. If no slot matched (root commit or first commit), assign the first free slot.
   c. For each parent of this commit:
      - The first parent inherits the current commit's lane slot (continuity -- straight line).
      - Additional parents (merge parents) claim the first free slot.
      - Record an edge from `commit.column` to the parent's assigned column with the appropriate `EdgeType`.
   d. Release the current commit's slot from `lanes` (it has been consumed), then fill in the parent slots.
3. `EdgeType` is determined by the relative column positions:
   - Same column: `Straight`
   - Parent column < current: `MergeLeft` (line bends left)
   - Parent column > current: `MergeRight` (line bends right)
   - Conversely for forks: `ForkLeft`, `ForkRight`
4. `color_index` for an edge = `parent_column % palette.len()`

---

## Core Features (v0.1)

### 1. Open Repository
- Native file dialog to select folder
- Validate with `git2::Repository::open(path)`
- Store in managed state, start filesystem watcher
- Return `RepoInfo { path, head_name, head_oid, is_bare, is_empty }`

### 2. Commit History & Graph
- `get_commits(path, offset, limit)` -- paginated, 200 commits per batch
- `Revwalk` with topological + time ordering
- Graph lane algorithm computes `column`, `edges`, and `is_merge` per commit
- Pre-build `OID -> Vec<RefLabel>` map to attach branch/tag labels
- Infinite scroll: fetch next batch when near bottom

### 3. Branch List (Sidebar)
- `get_refs(path)` returns categorized: local branches, remote branches, tags, stashes
- Collapsible sections with filter search (frontend-side filtering)
- Click branch to checkout, current branch highlighted

### 4. Working Tree Status
- `get_status(path)` returns `{ unstaged: Vec<FileStatus>, staged: Vec<FileStatus> }`
- File status types: New, Modified, Deleted, Renamed, Typechange, Conflicted
- Auto-refreshes on `fs_changed` events from watcher

### 5. Stage / Unstage Files
- `stage_files(path, paths)` -- `index.add_path()` + `index.write()`
- `unstage_files(path, paths)` -- `repo.reset_default()` (equivalent to `git reset HEAD -- <paths>`)
- Stage All / Unstage All buttons
- Whole-file only (no hunk staging in v0.1)

### 6. Create Commit
- `create_commit(path, message, description)` -- writes tree from index, creates commit object
- Signature from gitconfig (`repo.signature()`)
- Message + description joined with `\n\n`
- Validation: refuse empty message or empty staging area

### 7. File Diffs
- Shown in the **center panel**, replacing the commit graph when a commit or file is selected
- Click a commit in the graph -> `get_commit_diff(path, oid)` is called; center panel shows all changed files for that commit
- Click a file in the unstaged list -> `get_diff_workdir(path, file_path)` is called
- Click a file in the staged list -> `get_diff_staged(path, file_path)` is called
- `get_diff_workdir(path, file_path)` -- index vs working directory
- `get_diff_staged(path, file_path)` -- HEAD vs index
- `get_commit_diff(path, oid)` -- commit vs its first parent (or empty tree for root commits)
- Returns hunks with line-level detail (origin, content, line numbers)
- Unified view, plain monospace, green/red backgrounds (no syntax highlighting)
- Back navigation to return to the commit graph

### 8. Commit Detail
- Click a commit in the graph -> sidebar or panel shows full commit metadata via `get_commit(path, oid)`
- Displays: full OID, short OID, author name/email, author timestamp, committer (if different), full message + body
- Used to populate the detail header above the diff view

### 9. Branch Checkout
- `checkout_branch(path, branch_name)` -- set HEAD + checkout tree
- Safety: if the command returns a `TrunkError` with `code: "dirty_workdir"`, the frontend shows an inline error banner with the message "Commit or stash your changes before switching branches." No modal.

### 10. Filesystem Watching
- `notify` + `notify-debouncer-mini` (300ms debounce)
- Watch workdir, ignore `.git/` except `HEAD`, `refs/`, `index`
- Emit Tauri event `fs_changed` -> frontend re-fetches status

---

## Data Models

### Rust Types (`src-tauri/src/git/types.rs`)

Key structures (all `#[derive(Serialize, Clone)]`):

- **`GraphCommit`**: `oid, short_oid, summary, body, author_name, author_email, author_timestamp, parent_oids, column, edges: Vec<GraphEdge>, refs: Vec<RefLabel>, is_head, is_merge`
- **`GraphEdge`**: `from_column, to_column, edge_type: {Straight, MergeLeft, MergeRight, ForkLeft, ForkRight}, color_index`
- **`RefLabel`**: `name, short_name, ref_type: {LocalBranch, RemoteBranch, Tag, Stash}, is_head`
- **`BranchInfo`**: `name, is_head, upstream, ahead, behind, last_commit_timestamp`
- **`RefsResponse`**: `local: Vec<BranchInfo>, remote: Vec<BranchInfo>, tags: Vec<RefLabel>, stashes: Vec<RefLabel>`
- **`WorkingTreeStatus`**: `unstaged: Vec<FileStatus>, staged: Vec<FileStatus>, conflicted: Vec<FileStatus>`
- **`FileStatus`**: `path, status: {New, Modified, Deleted, Renamed, Typechange, Conflicted}, is_binary`
- **`FileDiff`**: `path, is_binary, hunks: Vec<DiffHunk>`
- **`DiffHunk`**: `header, old_start, old_lines, new_start, new_lines, lines: Vec<DiffLine>`
- **`DiffLine`**: `origin: {Context, Add, Delete}, content, old_lineno, new_lineno`
- **`CommitDetail`**: `oid, short_oid, summary, body, author_name, author_email, author_timestamp, committer_name, committer_email, committer_timestamp, parent_oids`

TypeScript mirrors in `src/lib/types.ts` (manual for v0.1, `tauri-specta` later).

---

## Tauri Commands Summary

| Command | Returns | Description |
|---------|---------|-------------|
| `open_repo(path)` | `RepoInfo` | Open repo, start watcher |
| `close_repo(path)` | `()` | Close repo, stop watcher |
| `get_commits(path, offset, limit)` | `Vec<GraphCommit>` | Paginated history with graph |
| `get_commit(path, oid)` | `CommitDetail` | Full metadata for one commit |
| `get_refs(path)` | `RefsResponse` | All branches, tags, stashes |
| `get_status(path)` | `WorkingTreeStatus` | Unstaged + staged files |
| `stage_files(path, paths)` | `WorkingTreeStatus` | Stage files, return updated |
| `unstage_files(path, paths)` | `WorkingTreeStatus` | Unstage files, return updated |
| `stage_all(path)` | `WorkingTreeStatus` | Stage everything |
| `unstage_all(path)` | `WorkingTreeStatus` | Unstage everything |
| `create_commit(path, msg, desc?)` | `String` (OID) | Create commit |
| `checkout_branch(path, name)` | `RepoInfo` | Switch branch; errors with `dirty_workdir` if changes exist |
| `create_branch(path, name, oid?)` | `BranchInfo` | Create branch |
| `get_diff_workdir(path, file)` | `FileDiff` | Diff: index vs workdir |
| `get_diff_staged(path, file)` | `FileDiff` | Diff: HEAD vs index |
| `get_commit_diff(path, oid)` | `Vec<FileDiff>` | Diff: commit vs parent |

All commands return `Result<T, TrunkError>` where `TrunkError { code, message }`.

---

## Roadmap

| Milestone | Features |
|-----------|----------|
| **v0.1** | Graph, branches, staging, commits, diffs, checkout, fs watching |
| **v0.2** | Push/pull/fetch (shell out to git), stash create/pop, commit amend, discard changes, resizable panels, keyboard shortcuts |
| **v0.3** | Multi-repo tabs, merge/rebase, blame, commit search, syntax highlighting |
| **v1.0** | Cherry-pick/revert, submodules, settings UI, auto-update, commit signing, large-repo perf |

---

## Non-Goals for v0.1

- Push / Pull / Fetch (needs auth handling)
- Merge / Rebase / Cherry-pick
- Conflict resolution UI
- Multiple repositories (tabs visible but non-functional)
- Stash create/pop (listed but read-only)
- Hunk staging (whole-file only)
- Syntax highlighting in diffs
- Settings/preferences
- Undo/Redo
- Commit signing
- Auto-updates

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Vite+Svelte (not SvelteKit)** | Desktop app has no routing or SSR needs; SvelteKit adds unnecessary complexity |
| **git2 for reads/writes, git CLI for remotes (future)** | libgit2 has unreliable SSH/HTTPS auth. All major Tauri git clients shell out for push/pull. |
| **Graph computed in Rust** | O(n), avoids serializing intermediate data, doesn't block JS thread |
| **Inline SVG per row (not Canvas)** | Free scrolling, text selection, accessibility. Simple enough geometry. |
| **Virtual scrolling with dynamic buffer** | Constant DOM nodes regardless of history size (50k commits = still ~40 nodes) |
| **`dirty_workdir` error code for checkout** | Structured error codes let the frontend show contextual UI without string matching |

---

## Verification

1. `cargo build` in `src-tauri/` -- Rust compiles with git2
2. `bun run dev` + `cargo tauri dev` -- app launches, file dialog opens a repo
3. Open a real repo (e.g., trunk itself) -- graph renders with correct topology, merge commits show distinct dot style
4. Stage a file, write a commit message, click Commit -- commit appears in history
5. Click a branch in sidebar -- HEAD switches, graph updates
6. Try to checkout a branch with uncommitted changes -- inline error banner appears, no crash
7. Click a commit in the graph -- commit detail and diff load in center panel
8. Modify a file externally -- status panel updates automatically via fs watcher
