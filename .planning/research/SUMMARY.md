# Project Research Summary

**Project:** Trunk — Desktop Git GUI
**Domain:** Native desktop Git GUI client (Tauri 2 + Rust + Svelte 5)
**Researched:** 2026-03-03
**Confidence:** HIGH

## Executive Summary

Trunk is a native desktop Git GUI built on Tauri 2 (Rust backend + OS webview) with a Svelte 5 frontend. The architecture is already decided and documented in the PRD: a strict two-process model where the Rust backend owns all git operations via `git2` and the Svelte frontend communicates exclusively through Tauri's IPC bridge using `invoke()` and `listen()`. This is a well-understood pattern for Tauri apps, and the chosen stack (Rust 1.93.1, Bun 1.3.8, Svelte 5.53.6, Tauri 2.10.2) is verified from actual lockfiles — not assumed. The primary opportunity this project has over competitors (GitKraken, Sourcetree) is native feel and performance at scale: Tauri's OS webview delivers a significantly smaller binary and faster startup than Electron-based alternatives, and the Rust lane algorithm can handle 100k+ commits without the slowdowns competitors suffer.

The recommended build order is foundation-first: migrate the current SvelteKit scaffold to plain Vite+Svelte (SvelteKit adds routing and SSR machinery that is pure waste for a single-window desktop app), then establish the Rust infrastructure (error types, state management, DTO layer), then build features in dependency order: repo open → commit graph → branch sidebar → staging/working tree → commit creation → diff display. The commit graph is the "wow" moment that earns user trust and must be correct from day one — the virtual scrolling and lane algorithm must handle large repos and correct topology from the start, not as a later optimization.

The critical risks are architectural, not feature-related. The three that require attention before any feature code is written: (1) `git2::Repository` is not `Sync` — the state architecture must avoid holding a mutex across long-running operations or the UI will freeze; (2) git2 types carry repo lifetimes and cannot be stored or returned across the IPC boundary — a DTO translation layer must be established before any git2 code is written; (3) Tauri IPC errors arrive in JavaScript as strings, not Error objects — a typed invoke wrapper is needed from day one to prevent silent error swallowing. These three are rewrites if addressed late; they are trivial to prevent if addressed first.

---

## Key Findings

### Recommended Stack

The stack is entirely pinned and verified from actual lockfiles. The key technologies are production-ready and the correct choices for this domain. The one immediate action required before any other work: **migrate from SvelteKit to plain Vite+Svelte**. The scaffold currently uses SvelteKit with `adapter-static`, which adds routing, SSR, and `.svelte-kit/` generated files that are wasted overhead for a single-window desktop app. See STACK.md for the 8-step migration procedure.

**Core technologies:**
- **Rust 1.93.1 + Tauri 2.10.2**: Desktop shell, IPC bridge, native APIs — Tauri 2 is the current stable major with significant API changes from Tauri 1; documentation for Tauri 1 is abundant but wrong for this project
- **git2 0.19**: libgit2 Rust bindings — covers all v0.1 local git operations (open, revwalk, index, refs, diff, commit); chosen over gitoxide (gix) for its broader API maturity
- **Svelte 5.53.6 + Vite 6.4.1**: Frontend framework + build tool — Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`) are the required paradigm; zero Svelte 4 legacy patterns
- **Tailwind CSS v4 + `@tailwindcss/vite`**: Styling — v4 only; v3 is incompatible with the Vite 6 pipeline
- **notify 7 + notify-debouncer-mini 0.5**: Cross-platform filesystem watching — 300ms debounce to handle event storms from external git operations
- **Bun 1.3.8**: Package manager and dev server runner — already pinned in mise.toml

Tauri 1 vs Tauri 2 is a meaningful distinction: the `invoke` import path changed (`@tauri-apps/api/tauri` → `@tauri-apps/api/core`), plugins moved to crates.io, and permissions now use capability files in `src-tauri/capabilities/` instead of `allowlist`. The scaffold already uses the correct Tauri 2 patterns.

### Expected Features

The Git GUI market is mature with well-established expectations. Table stakes are non-negotiable — absence of any of them causes users to immediately dismiss the tool. Trunk's primary differentiator opportunity is performance at scale and native feel, which the Rust/Tauri architecture directly enables.

**Must have (table stakes) — v0.1:**
- Visual commit graph with lane rendering — the core reason to use a GUI over `git log`
- Branch/tag/stash sidebar — navigation foundation
- Working tree status with staged/unstaged split — staging workflow entry
- Whole-file stage and unstage — minimum viable write operation
- File diff view (workdir, staged, commit) — confidence before committing
- Create commit with subject + body — completing the write loop
- Commit detail view on click (metadata + diff) — history exploration
- Checkout branch with dirty-workdir error handling — daily workflow, must not fail silently
- Open repository with native file picker — entry point to everything
- Auto-refresh on external changes (filesystem watch) — makes the app feel alive

**Should have — v0.2:**
- Hunk-level staging — power users will notice the absence; plan architecture for it from v0.1
- Remote operations (push/pull/fetch) — requires SSH/HTTPS auth surface; defer entirely, show explicit placeholder
- Inline diff in staging panel — differentiator; Fork does this well
- Stash create/pop — listing is sufficient for v0.1

**Defer (v2+):**
- Conflict resolution UI (v0.3+) — high complexity, high correctness bar
- Search/filter commits — nice-to-have, not day-one
- Multi-repo tabs — show the tab bar for architecture visibility, but non-functional in v0.1
- Syntax-highlighted diffs (v0.3+) — aspirational, not essential
- Settings/preferences panel, auto-update, terminal emulator, forge integration (PR/issues) — all explicitly out of scope

**Hard constraints (do not defer quietly):**
- Dirty-workdir error on checkout: users hit this day one; silent failure destroys trust
- Binary file handling in diffs: rendering binary data as text is a crash/hang risk
- Large repo performance: the graph must render large repos correctly from launch; this is Trunk's stated differentiator

### Architecture Approach

The architecture follows a strict two-process model: Svelte 5 SPA (renderer, Vite-served webview) and Rust backend (main process). All communication goes through Tauri IPC: `invoke()` for user-initiated commands (request/response), `listen()` for Rust-initiated events (filesystem change notifications). The Rust backend is organized into thin command dispatchers (`commands/`) that delegate to git logic modules (`git/`), with managed state (`RepoState`) storing a path-keyed map of open repositories. The path string is the repository's canonical identifier across the IPC boundary.

**Major components:**
1. **`state.rs` — `Mutex<HashMap<String, Repository>>`**: Repository handle registry; path is the key; accessed by all command handlers
2. **`error.rs` — `TrunkError { code, message }`**: The only error type at the IPC boundary; structured `code` field enables frontend to branch on error type without string matching
3. **`git/graph.rs` — Lane algorithm (O(n))**:  Single-pass Revwalk with `SORT_TOPOLOGICAL | SORT_TIME`; emits `GraphCommit` with absolute lane indices, not pixel coordinates
4. **`watcher.rs` — notify-debouncer-mini (300ms)**: Watches workdir (not `.git/` internals); emits `fs_changed` event as a nudge; frontend always re-fetches, event carries no payload
5. **`CommitGraph.svelte` — Virtual scroll**: Only renders visible rows (~40 DOM nodes regardless of repo size); SVG lanes per row, indexed by absolute commit position not DOM slot position
6. **`RightPanel.svelte` — Staging workflow**: File lists (staged/unstaged), stage/unstage actions, commit form; all write operations go through Rust commands

### Critical Pitfalls

1. **`Repository` not `Sync` — mutex contention on long operations**: A slow revwalk over 10k commits holds the mutex while the UI tries to refresh status. Prevention: store only `PathBuf` in managed state, re-open `Repository` per operation inside `spawn_blocking` for read-heavy commands. Address in Phase 1 — wrong architecture here forces a rewrite of all command handlers.

2. **git2 lifetime traps — cannot store or return `Commit<'repo>` types**: git2 types carry repo lifetimes; they cannot be stored in structs or returned across threads. Prevention: define owned DTO structs (e.g., `GraphCommit { oid: String, summary: String, ... }`) that implement `serde::Serialize` before writing any git2 code. Establish a `git_to_dto()` translation layer in Phase 1.

3. **Virtual scroll coordinate desync — DOM slot index vs absolute commit index**: If SVG lane rendering is indexed by DOM slot position instead of absolute commit index, lanes are correct at the top of the list and broken everywhere else. Prevention: Rust lane algorithm emits absolute commit indices; Svelte virtual scroll passes absolute index (not DOM position) to each `GraphRow.svelte`.

4. **`notify` watcher firing on own writes — event loop**: Every staging/commit operation writes to `.git/index` or `.git/refs/`, which triggers the watcher, which triggers a status refresh. Prevention: watch working tree directories but filter `.git/` internals; 300ms debounce (already decided); suppress watcher events for 500ms after backend-initiated writes.

5. **Tauri IPC errors arrive as strings, not Error objects**: `await invoke()` rejects with a raw string; `catch(e) { e.message }` returns `undefined`. Prevention: create a typed `safeInvoke<T>()` wrapper that parses the error string into a `{ code, message }` object. Do this before wiring any commands.

---

## Implications for Roadmap

Based on combined research, the natural phase structure follows strict dependency order. Each phase has a clear output that enables the next. The commit graph is prioritized above staging because it is the app's primary value proposition and the feature that earns user trust. Staging and commit creation follow naturally once the repo is open and visible.

### Phase 1: Foundation

**Rationale:** Every subsequent module depends on these primitives. Getting them wrong forces a rewrite. This phase has no UI features — it is infrastructure only.
**Delivers:** Working Vite+Svelte scaffold with Tailwind; Rust module structure with correct types, error handling, and state architecture; all dependencies installed.
**Addresses:** Prerequisite for all features.
**Avoids:**
- Pitfall 1 (`Repository` not `Sync`): establish correct state architecture (path-only state + re-open per operation)
- Pitfall 2 (git2 lifetimes): define all DTO structs and the `git_to_dto()` pattern before any git2 code
- Pitfall 6 (`TrunkError` not Serialize): define `AppError` with `From<git2::Error>` before the first command
- Pitfall 8 (invoke error swallowing): create typed `safeInvoke` wrapper before any command is wired

**Key tasks:**
- Migrate SvelteKit → plain Vite+Svelte (8-step procedure in STACK.md)
- Add git2, notify, notify-debouncer-mini, tauri-plugin-dialog to Cargo.toml
- Scaffold `error.rs`, `state.rs`, `git/types.rs` (all serializable DTOs)
- Add Tailwind CSS v4 with `@tailwindcss/vite`
- Configure Tauri 2 capability file with `dialog:allow-open`

### Phase 2: Repository Open + Commit Graph

**Rationale:** The commit graph is the core value proposition and the "wow" moment. Everything else is built around it. Repo open is the required entry point — nothing works without it.
**Delivers:** A working app that opens a repository and renders a scrollable commit graph with correct visual lanes.
**Features:** Open repository (native file picker), visual commit graph (table stakes), auto-display of branches in lane colors.
**Uses:** `git2` Revwalk with `SORT_TOPOLOGICAL | SORT_TIME` (Pitfall 9), virtual scroll (constant DOM nodes), SVG per row.
**Avoids:**
- Pitfall 3 (virtual scroll desync): define `ROW_HEIGHT` as single constant; test at >100% zoom
- Pitfall 4 (SVG lane coordinate mismatch): Rust emits lane indices, not pixels; frontend does pixel math
- Pitfall 17 (SVG viewBox mismatch): `LANE_WIDTH` defined once in CSS custom properties, referenced in all SVG math
- Pitfall 18 (HEAD edge cases): handle empty repo, detached HEAD from the start

### Phase 3: Branch Sidebar + Checkout

**Rationale:** Branch navigation is the entry point to daily workflows. Users need to see where HEAD is and switch branches before staging makes sense.
**Delivers:** Sidebar listing local branches, remote branches, tags, and stashes with active branch highlighted. Checkout with dirty-workdir error handling.
**Features:** Branch list in sidebar (table stakes), checkout branch (table stakes), dirty-workdir error banner (must not be deferred).
**Implements:** `commands/branches.rs`, `Sidebar.svelte`.
**Avoids:**
- Dirty-workdir silent failure: `checkout_branch` must return `TrunkError { code: "dirty_workdir" }` and the frontend must surface a visible banner — not silently succeed or show a generic error

### Phase 4: Working Tree + Staging + Filesystem Watch

**Rationale:** Staging depends on having a repo open (Phase 2). The filesystem watcher depends on the repo path from `open_repo`. These belong together because the watcher is the mechanism that makes the staging panel feel live.
**Delivers:** Real-time working tree status panel showing staged/unstaged files; whole-file stage and unstage; auto-refresh when external tools (terminal, IDE) modify files.
**Features:** Working tree status (table stakes), whole-file stage/unstage (table stakes), auto-refresh on external changes (table stakes).
**Avoids:**
- Pitfall 5 (notify fires on own writes): filter `.git/` internals from watch scope; debounce 300ms; suppress post-command events
- Pitfall 10 (Windows path separators): normalize to forward slashes in JS path comparisons
- Pitfall 12 (macOS sandbox kills FSEvents): test production `.app` build, not just `tauri dev`
- Pitfall 15 (index write-back missing): always call `index.write()` after any index modification

### Phase 5: Commit Creation

**Rationale:** Create commit is the final step in the core write loop. It depends on a working staging area (Phase 4). The commit must trigger a graph refresh to close the feedback loop.
**Delivers:** Commit form in the right panel with subject + body fields; created commit immediately appears in the graph.
**Features:** Create commit with message (table stakes).
**Avoids:**
- Pitfall 13 (wrong author identity): always use `repo.signature()`, never hardcoded values; fall back to UI prompt only if `repo.signature()` returns an error

### Phase 6: Diff Display

**Rationale:** Diffs are display-only with no new state. They can be added last without blocking any other feature. They complete the inspection workflow: click a commit in the graph → see what changed; click a file in the staging panel → see the diff before staging.
**Delivers:** Unified diff view for workdir files, staged files, and historical commits. Click commit → diff; click file in panel → diff.
**Features:** File diff view (table stakes), commit detail view (table stakes).
**Avoids:**
- Pitfall 11 (large diff blocks IPC): hard-limit diff to 5000 lines / 500KB; return `{ lines, truncated: bool }`; surface "diff too large" prompt to user

### Phase Ordering Rationale

- **Foundation before everything**: DTO types, error types, and state architecture are referenced by every subsequent module. Wrong choices here propagate into every command and require a full rewrite.
- **Graph before staging**: The graph is the primary value proposition; it earns trust that makes users willing to try the staging workflow. Also, graph requires only read operations which simplifies the initial mutex/concurrency design.
- **Sidebar before staging**: Users need to see the branch structure before staging makes sense contextually. Checkout error handling must be correct before users encounter it.
- **Staging before commit**: The commit form is meaningless without a staging area.
- **Diffs last**: Display-only, no new state, no new dependencies. Completes the workflow without blocking any earlier feature.

### Research Flags

Phases with areas needing deeper research during planning:
- **Phase 2 (Graph):** The virtual scroll + SVG lane rendering is the most technically complex UI component. The lane algorithm implementation in Rust should be specified in detail before coding begins. Consider a short research-phase spike for the specific SVG coordinate math and scroll handler implementation.
- **Phase 4 (Watcher):** macOS sandbox behavior for FSEvents in production Tauri builds may need verification against current Tauri 2 macOS entitlements documentation. PITFALLS.md rates this MEDIUM confidence.

Phases with well-established patterns (skip research-phase):
- **Phase 1 (Foundation):** SvelteKit migration steps are explicit in STACK.md; Tauri 2 capability file format is documented; DTO/error patterns are fully specified in ARCHITECTURE.md.
- **Phase 5 (Commit):** `repo.signature()` is a single well-documented git2 API call; commit creation pattern is straightforward.
- **Phase 6 (Diff):** diff commands map directly to git2 `Diff` API; the IPC truncation pattern is specified.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions verified directly from Cargo.lock, bun.lock, package.json, and mise.toml — not assumed from docs |
| Features | MEDIUM | Table stakes categorization is stable and well-established; competitive differentiator rankings based on training data (mid-2025); web research tools unavailable during research session |
| Architecture | HIGH | PRD.md is the authoritative source; all decisions already made by project author; Tauri 2 / Svelte 5 / git2 patterns verified against installed versions |
| Pitfalls | HIGH (most) / MEDIUM (some) | Core Rust/git2/Tauri pitfalls are HIGH confidence from documented API behavior; Svelte 5 runes reactivity edge cases and macOS sandbox behavior are MEDIUM — verify during implementation |

**Overall confidence:** HIGH

### Gaps to Address

- **Competitor feature parity**: FEATURES.md notes that web research was unavailable. The table-stakes list is stable, but competitive differentiators should be spot-checked against current competitor feature pages before the roadmap is finalized. Particularly: has any competitor shipped hunk-level staging improvements or performance fixes since mid-2025?
- **macOS sandbox + FSEvents in production**: The interaction between Tauri 2's macOS app bundle, FSEvents entitlements, and the `notify` crate should be validated by building and testing a production `.app` bundle early (during or immediately after Phase 4), not just relying on `tauri dev` behavior.
- **git2 `Repository` thread safety in practice**: PITFALLS.md recommends re-opening `Repository` per operation for read-heavy commands rather than sharing a single handle. The exact pattern to use with Tauri 2's async command handlers should be validated against current Tauri 2 state management docs before Phase 1 state architecture is finalized.
- **Svelte 5 runes reactivity edge cases**: Pitfalls 7 and 14 are rated MEDIUM confidence. The `$props()` destructuring reactivity behavior and object mutation tracking should be verified against current Svelte 5 documentation, as Svelte 5 was relatively new at the training data cutoff.

---

## Sources

### Primary (HIGH confidence)
- `/Users/joaofnds/code/trunk/src-tauri/Cargo.lock` — exact locked versions of tauri, serde, tokio, git2
- `/Users/joaofnds/code/trunk/node_modules/*/package.json` — exact installed versions of svelte, vite, @tauri-apps/api
- `/Users/joaofnds/code/trunk/package.json` — declared dependency ranges
- `/Users/joaofnds/code/trunk/src-tauri/Cargo.toml` — declared Rust dependency ranges
- `/Users/joaofnds/code/trunk/PRD.md` — authoritative architecture decisions from project author
- `/Users/joaofnds/code/trunk/mise.toml` — pinned Rust 1.93.1 and Bun 1.3.8

### Secondary (MEDIUM confidence)
- Training-data knowledge of Tauri 2 IPC, managed state, capability system (cutoff August 2025) — verify against https://v2.tauri.app
- Training-data knowledge of Svelte 5 runes reactivity model — verify against https://svelte.dev/docs/svelte/what-are-runes
- Training-data knowledge of GitKraken, Fork, Sourcetree, Tower, GitHub Desktop, Sublime Merge feature sets (mid-2025) — spot-check against current competitor feature pages
- Training-data knowledge of macOS FSEvents sandbox behavior in Tauri 2 production builds

### Tertiary (verify during implementation)
- Tailwind CSS v4 `@tailwindcss/vite` integration — verify against https://tailwindcss.com/docs/installation/vite
- git2 crate API — verify against https://docs.rs/git2/latest/git2/
- notify crate v7 API — verify against https://docs.rs/notify/latest/notify/

---

*Research completed: 2026-03-03*
*Ready for roadmap: yes*
