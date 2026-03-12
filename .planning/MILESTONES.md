# Milestones

## v0.3 Actions (Shipped: 2026-03-12)

**Phases:** 4 | **Plans:** 14 | **Commits:** 88 | **Timeline:** 3 days
**LOC:** ~5,009 Rust / ~3,553 Svelte / ~345 TypeScript
**Git range:** c30394be (start milestone) → 100a1b90 (merge TabBar/Toolbar)

**Delivered:** Full stash management, commit row context menu with cherry-pick/revert, remote push/pull/fetch with progress streaming, quick actions toolbar with undo/redo, and branch ahead/behind tracking.

**Key accomplishments:**
1. Stash create/pop/apply/drop via git2 with graph-integrated synthetic stash rows (square dots, dashed connectors) and right-click context menu
2. Commit context menu with copy SHA/message, checkout, create branch/tag, cherry-pick, and revert (merge commits disabled)
3. Remote fetch/pull/push via git CLI subprocess with per-line progress streaming and structured auth/rejection error taxonomy
4. Quick actions toolbar (Pull, Push, Branch, Stash, Pop, Undo, Redo) merged into single top bar
5. Branch ahead/behind counts computed inside list_refs to avoid extra IPC, auto-refreshed after remote ops
6. Undo/redo commit with isUndoing/isRedoing race-condition guards and clearRedoStack moved to user-initiated sites

---

## v0.2 Commit Graph (Shipped: 2026-03-10)

**Phases:** 4 | **Plans:** 9 | **Commits:** 76 | **Timeline:** 2 days
**LOC:** ~3,344 Rust / ~2,458 Svelte / ~290 TypeScript
**Git range:** 80a714c (test(07-01)) → 2c18aa2 (docs(phase-07))

**Delivered:** GitKraken-quality commit graph with continuous vertical lane rails, Manhattan-routed merge/fork edges, vivid 8-color palette, hollow merge dots, WIP dashed connector, lane-colored ref pills, resizable 6-column layout, and column visibility toggles.

**Key accomplishments:**
1. Hardened lane algorithm with ghost lane fix, octopus merge protection, max_columns tracking, and deterministic branch color counter
2. Three-layer SVG lane rendering with vivid 8-color palette, continuous vertical rails, and Manhattan-routed merge/fork edges
3. Merge commits display as hollow circles, WIP row integrated into virtual list with dashed connector to HEAD
4. Lane-colored ref pills with remote dimming and horizontal connector lines to commit dots
5. Spreadsheet-style 6-column resizable layout with LazyStore-persisted column widths
6. Header right-click context menu with per-column visibility toggles via native Tauri Menu API

---

## v0.1 MVP (Shipped: 2026-03-09)

**Phases:** 6 | **Plans:** 27 (26 complete) | **Commits:** 155 | **Timeline:** 7 days
**LOC:** ~53,990 Rust / ~2,043 Svelte / ~193 TypeScript
**Git range:** 5e8a251 (initial) → 80d0151 (UAT re-test)

**Delivered:** A native desktop Git GUI where a developer can open any repository, browse its full commit history as a visual lane graph, manage branches, stage files, create/amend commits, and inspect diffs — all without touching the terminal.

**Key accomplishments:**
1. Vite+Svelte SPA with Tailwind v4 dark theme and shared Rust/TypeScript primitives
2. Visual commit graph with Rust lane algorithm (O(n)), inline SVG per row, virtual scrolling with 200-commit pagination
3. Branch sidebar with checkout, dirty-workdir error handling, and client-side search
4. Working tree staging panel with real-time file status, whole-file stage/unstage, and filesystem watcher auto-refresh
5. Commit creation and amendment with subject+body form, validation, and immediate graph refresh
6. Unified diff display for workdir/staged/commit diffs with commit metadata header

### Known Gaps
- **GRAPH-04**: Merge commits not visually distinct in CommitRow.svelte (Rust DTO carries `is_merge` correctly, frontend never reads it)
- **DIFF-01–04**: Phase 06 VERIFICATION.md never created (code-complete and wiring-verified, lacks formal report)
- **Plan 02-09**: No SUMMARY.md (active_lanes[0] None initialization fix — plan created, not executed)
- **Checkout → StagingPanel**: Non-deterministic refresh after checkout/create-branch (relies on watcher, not explicit event emit)

---

