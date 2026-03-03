# Trunk

## What This Is

Trunk is a fast, native, cross-platform desktop Git GUI built with Tauri 2 + Svelte 5 + Rust. It targets developers who want a polished Git client comparable to GitKraken or Fork — with a commit graph, branch management, staging workflow, and file diffs — without the performance penalties or licensing costs of existing tools.

## Core Value

A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits — all without touching the terminal.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Migrate scaffold from SvelteKit to plain Vite+Svelte
- [ ] Open a Git repository via native file dialog
- [ ] Display paginated commit history with visual lane graph
- [ ] List branches, remote branches, tags, and stashes in sidebar
- [ ] Show working tree status (unstaged and staged files)
- [ ] Stage and unstage individual files (whole-file only)
- [ ] Create commits with message and optional description
- [ ] Show file diffs (workdir, staged, and commit diffs)
- [ ] Show full commit detail (metadata + diff) when a commit is clicked
- [ ] Checkout branches with dirty-workdir error handling
- [ ] Watch filesystem and auto-refresh status on external changes

### Out of Scope

- Push / Pull / Fetch — needs auth handling, deferred to v0.2
- Merge / Rebase / Cherry-pick — deferred to v0.3
- Conflict resolution UI — deferred to v0.3+
- Multi-repo tabs — tabs visible but non-functional in v0.1
- Stash create/pop — listed in sidebar but read-only in v0.1
- Hunk staging — whole-file only for v0.1
- Syntax highlighting in diffs — deferred to v0.3
- Settings/preferences — deferred to v1.0
- Undo/Redo — deferred
- Commit signing — deferred to v1.0
- Auto-updates — deferred to v1.0

## Context

- **Stack**: Tauri 2 + Svelte 5 (Vite SPA, not SvelteKit) + Rust with `git2` crate (libgit2 bindings)
- **Current state**: Fresh Tauri+Svelte scaffold with default "greet" example — no git-related code exists yet
- **Architecture**: Svelte UI communicates with Rust backend via Tauri `invoke` (commands) and `listen` (events). Rust holds `Mutex<HashMap<String, Repository>>` in managed state.
- **Remote ops**: `git2` used for all local read/write; shell-out to `git` CLI reserved for remote operations (future milestones) due to libgit2 unreliable SSH/HTTPS auth
- **Graph rendering**: Inline SVG per row (not Canvas/one giant SVG) with virtual scrolling. Lane algorithm runs in Rust — O(n), ~5ms for 10k commits.
- **Motivation**: Personal learning project (Tauri/Rust/Svelte) + building a better tool for personal use + eventual open source release

## Constraints

- **Tech stack**: Tauri 2 + Svelte 5 + Rust — already chosen, non-negotiable
- **Frontend framework**: Plain Vite+Svelte (not SvelteKit) — desktop app has no routing/SSR needs
- **Git backend**: `git2 = "0.19"` for all local operations in v0.1
- **Filesystem watching**: `notify = "7"` + `notify-debouncer-mini = "0.5"` with 300ms debounce
- **Styling**: Tailwind CSS + dark theme by default; CSS custom properties for future light theme
- **Graph**: Virtual scrolling — render only visible rows + dynamic buffer; ~40 DOM nodes for any history size

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Vite+Svelte over SvelteKit | Desktop app has no routing or SSR needs; SvelteKit adds unnecessary complexity | — Pending |
| git2 for reads/writes, git CLI for remotes (future) | libgit2 has unreliable SSH/HTTPS auth; all major Tauri git clients shell out for push/pull | — Pending |
| Graph lane algorithm in Rust | O(n), avoids serializing intermediate data, doesn't block JS thread | — Pending |
| Inline SVG per row (not Canvas) | Free scrolling, text selection, accessibility; simple enough geometry | — Pending |
| Virtual scrolling with dynamic buffer | Constant DOM nodes regardless of history size | — Pending |
| `dirty_workdir` error code for checkout | Structured error codes let frontend show contextual UI without string matching | — Pending |

---
*Last updated: 2026-03-03 after initialization*
