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

### Active

- [ ] Push / Pull / Fetch with SSH/HTTPS auth
- [ ] Hunk-level staging (stage individual hunks, not just whole files)
- [ ] Stash create/pop
- [ ] Resizable panels (splitters)
- [ ] Keyboard shortcuts for common operations
- [ ] Merge commit visual distinction (GRAPH-04 gap from v0.1)
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
- **Current state**: Shipped v0.1 with ~53,990 LOC Rust, ~2,043 LOC Svelte, ~193 LOC TypeScript. 17 Tauri commands, 10 Svelte components, 6 phases complete.
- **Architecture**: Svelte UI communicates with Rust backend via Tauri `invoke` (commands) and `listen` (events). Rust holds `RepoState` (path-keyed PathBuf registry), `CommitCache` (cached graph data), and `WatcherState` (filesystem watchers) in managed state.
- **Remote ops**: `git2` used for all local read/write; shell-out to `git` CLI reserved for remote operations (future milestones) due to libgit2 unreliable SSH/HTTPS auth
- **Graph rendering**: Inline SVG per row (not Canvas/one giant SVG) with virtual scrolling. Lane algorithm runs in Rust — O(n), ~5ms for 10k commits.
- **Patterns established**: inner-fn pattern for testable Tauri commands, safeInvoke<T> for all IPC, sequence counter for stale async guard, cache-repopulate-before-emit for mutation commands
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

---
*Last updated: 2026-03-09 after v0.1 milestone*
