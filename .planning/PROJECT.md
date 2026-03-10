# Trunk

## What This Is

Trunk is a fast, native, cross-platform desktop Git GUI built with Tauri 2 + Svelte 5 + Rust. It provides a visual commit graph, branch management, staging workflow, and file diffs — without the performance penalties or licensing costs of existing tools like GitKraken or Fork.

## Core Value

A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits — all without touching the terminal.

## Requirements

### Validated

- ✓ Migrate scaffold from SvelteKit to plain Vite+Svelte — v0.1
- ✓ Open a Git repository via native file dialog — v0.1
- ✓ Display paginated commit history with visual lane graph — v0.1
- ✓ List branches, remote branches, tags, and stashes in sidebar — v0.1
- ✓ Show working tree status (unstaged and staged files) — v0.1
- ✓ Stage and unstage individual files (whole-file only) — v0.1
- ✓ Create commits with message and optional description — v0.1
- ✓ Show file diffs (workdir, staged, and commit diffs) — v0.1
- ✓ Show full commit detail (metadata + diff) when a commit is clicked — v0.1
- ✓ Checkout branches with dirty-workdir error handling — v0.1
- ✓ Watch filesystem and auto-refresh status on external changes — v0.1
- ✓ GitKraken-quality commit graph with lane rendering — v0.2
- ✓ Continuous vertical colored lines per branch with lane packing — v0.2
- ✓ Manhattan-routed merge/fork edges with vivid 8-color palette — v0.2
- ✓ Merge commit visual distinction (hollow dots) and WIP dashed connector — v0.2
- ✓ Lane-colored ref pills and resizable 6-column layout — v0.2

### Active

- [ ] Push / Pull / Fetch with SSH/HTTPS auth
- [ ] Hunk-level staging (stage individual hunks, not just whole files)
- [ ] Stash create/pop
- [ ] Resizable panels (splitters)
- [ ] Keyboard shortcuts for common operations
- [ ] Deterministic StagingPanel refresh after checkout/create-branch

### Out of Scope

- Merge / Rebase / Cherry-pick — high correctness bar, deferred to v0.3
- Conflict resolution UI — requires merge support, deferred to v0.3+
- Multi-repo functional tabs — tab bar visible but non-functional
- Syntax highlighting in diffs — deferred to v0.3
- Settings/preferences UI — deferred to v1.0
- Commit signing — deferred to v1.0
- Auto-updates — deferred to v1.0
- Mobile / web versions — desktop only
- Undo/Redo — deferred

## Context

- **Stack**: Tauri 2 + Svelte 5 (Vite SPA, not SvelteKit) + Rust with `git2` crate (libgit2 bindings)
- **Current state**: Shipped v0.2 with ~3,344 LOC Rust, ~2,458 LOC Svelte, ~290 LOC TypeScript. 10 phases complete across 2 milestones.
- **Architecture**: Svelte UI communicates with Rust backend via Tauri `invoke` (commands) and `listen` (events). Rust holds `RepoState` (path-keyed PathBuf registry), `CommitCache` (cached GraphResult with max_columns), and `WatcherState` (filesystem watchers) in managed state.
- **Remote ops**: `git2` used for all local read/write; shell-out to `git` CLI reserved for remote operations (future milestones) due to libgit2 unreliable SSH/HTTPS auth
- **Graph rendering**: Three-layer inline SVG per row (rails -> edges -> dots) with virtual scrolling. Lane algorithm runs in Rust — O(n), ~5ms for 10k commits. Manhattan-routed merge/fork edges with 8-color vivid palette. GraphResult wraps commits + max_columns for consistent SVG widths.
- **Graph UI**: 6-column resizable layout (ref, graph, message, author, date, SHA) with LazyStore-persisted widths, native Tauri context menu for column visibility, lane-colored ref pills
- **Patterns established**: inner-fn pattern for testable Tauri commands, safeInvoke<T> for all IPC, sequence counter for stale async guard, cache-repopulate-before-emit for mutation commands, LazyStore for UI state persistence, sentinel oid ('__wip__') for synthetic virtual list items
- **Motivation**: Personal learning project (Tauri/Rust/Svelte) + building a better tool for personal use + eventual open source release

## Constraints

- **Tech stack**: Tauri 2 + Svelte 5 + Rust — already chosen, non-negotiable
- **Frontend framework**: Plain Vite+Svelte (not SvelteKit) — desktop app has no routing/SSR needs
- **Git backend**: `git2 = "0.19"` for all local operations
- **Filesystem watching**: `notify = "7"` + `notify-debouncer-mini = "0.5"` with 300ms debounce
- **Styling**: Tailwind CSS v4 + forced dark theme via CSS custom properties
- **Graph**: Virtual scrolling — render only visible rows + dynamic buffer; ~40 DOM nodes for any history size

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Vite+Svelte over SvelteKit | Desktop app has no routing or SSR needs; SvelteKit adds unnecessary complexity | ✓ Good — eliminated entire class of build issues |
| git2 for reads/writes, git CLI for remotes (future) | libgit2 has unreliable SSH/HTTPS auth; all major Tauri git clients shell out for push/pull | ✓ Good — all local ops work reliably |
| Graph lane algorithm in Rust | O(n), avoids serializing intermediate data, doesn't block JS thread | ✓ Good — ~5ms for 10k commits, required 3 gap-closure iterations |
| Inline SVG per row (not Canvas) | Free scrolling, text selection, accessibility; simple enough geometry | ✓ Good — works well with virtual list |
| Virtual scrolling with dynamic buffer | Constant DOM nodes regardless of history size | ✓ Good — smooth performance on large repos |
| `dirty_workdir` error code for checkout | Structured error codes let frontend show contextual UI without string matching | ✓ Good — clean error handling pattern |
| RepoState stores PathBuf only | git2::Repository is not Sync; open fresh per command in spawn_blocking | ✓ Good — avoids lifetime issues, minimal overhead |
| inner-fn pattern for Tauri commands | Separates Tauri state from pure git logic, enables direct unit testing | ✓ Good — all commands testable without Tauri runtime |
| Cache repopulate before emit | Prevents CommitGraph remount from racing a cleared cache | ✓ Good — eliminated race conditions in commit/amend flows |
| DiffPanel replaces CommitGraph (toggle not split) | User feedback found split pane confusing | ✓ Good — simpler UX |

| Lanes removed, dots only for v0.1 | v0.1 lane rendering had visual bugs; simpler to ship dots and revisit with dedicated focus | ✓ Good — shipped v0.1 clean, dedicated v0.2 milestone for graph |
| GraphResult wrapper return type | walk_commits returns struct with commits + max_columns metadata instead of bare Vec | ✓ Good — enables consistent SVG widths, clean separation |
| GraphResponse IPC struct at command boundary | Separate from internal GraphResult; slices commits for pagination | ✓ Good — clean internal/external type separation |
| Branch color counter with deterministic color_index | HEAD gets 0, new branches get incrementing colors, freed columns remove entries | ✓ Good — enables consistent per-branch coloring in frontend |
| Three-layer SVG rendering (rails -> edges -> dots) | Correct z-stacking: rails behind edges behind dots; each layer is a separate SVG group | ✓ Good — clean visual layering, easy to add new element types |
| Manhattan routing for merge/fork edges | Horizontal + arc + vertical path segments with 6px corner radius; simpler than full bezier | ✓ Good — clean visual appearance, straightforward path math |
| Vivid 8-color dark-theme palette | GitHub-dark-inspired high-contrast colors replacing low-contrast originals | ✓ Good — all colors readable against #0d1117 |
| WIP sentinel oid ('__wip__') | Synthetic virtual list item rather than extending GraphCommit type | ✓ Good — keeps TypeScript type aligned with Rust backend struct |
| LazyStore for UI state persistence | Column widths and visibility persisted via Tauri store with lazy load | ✓ Good — consistent pattern for all UI state |
| Native Tauri Menu API over custom Svelte component | Replaced HeaderContextMenu.svelte with @tauri-apps/api/menu | ✓ Good — native look and feel, simpler code |

---
*Last updated: 2026-03-10 after v0.2 milestone*
