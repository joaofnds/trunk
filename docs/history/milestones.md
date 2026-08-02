# Milestones

## v0.14 Commit Message UX (Shipped: 2026-05-29)

**Phases completed:** 2 phases, 6 plans, 14 tasks

**Key accomplishments:**

- Svelte 5 commit-message modal with host-owned `open(default: string): Promise<string | null>` API and uniform null-resolve abort across Esc/Cancel/backdrop/empty — covered by 13 vitest behaviors and ready for Phase 76 wiring.
- `git::editor::prepare()` + `EditorHandle` RAII type extracted from `interactive_rebase.rs` queue pattern, with `tempfile::Builder` TOCTOU defence and Drop-based cleanup proven by 8 unit tests.
- Two-step `merge_branch_begin` (`--ff-only` probe -> `--no-commit` -> `MergeBeginResult` tagged enum) plus a verbatim `get_merge_message` query and a `--cleanup=strip` merge-continue finish path — all proven against temp git repos, with the GIT_EDITOR/`--no-edit` bypasses removed.
- Two-step `revert_commit_begin` (`git revert --no-commit` -> verbatim `.git/MERGE_MSG` default with the full 40-char OID, emits `repo-changed`), a `revert_continue` finish (`git commit -m --cleanup=strip`, clears `REVERT_HEAD`), and a NEW `revert_abort` (`git revert --abort`) that makes MSG-06 satisfiable for revert — all proven against temp git repos, with the `--no-edit` bypass removed.
- A single RepoView-hosted MessageEditor with a reactive per-operation title, threaded via `onopenmessageeditor` to every merge/revert trigger site (CommitGraph, BranchSidebar, StagingPanel→OperationBanner); cancel/empty makes no commit (D-02).
- StagingPanel's inline merge-commit form is replaced by a single modal-routed merge-continue button (default verbatim from `get_merge_message`, cancel makes no commit), and OperationBanner now renders Continue + Abort buttons for a Revert state (previously zero buttons), giving the cancelled-revert recovery path MSG-06 requires.

---

## v0.13 Code Review Mode (Shipped: 2026-05-27)

**Phases completed:** 10 phases, 37 plans, 65 tasks | **Timeline:** 3 days (2026-05-25 → 2026-05-27) | **Commits:** 290

**Delivered:** A per-repo code review session — start/resume/end across restarts, seed from a commit range or hand-pick from the graph, comment on a diff line range or a full-file-at-commit line range, manage comments (edit/delete/jump/orphan handling), and render the whole session as one AI-framed markdown document copied to the clipboard. Two lifecycle endpoints in the UI: cold-boot resume on open and explicit two-step End-review.

**Key accomplishments:**

- Phase 65 — Frozen keystone schema (Rust DTOs + TS mirror, PascalCase enums / snake_case fields), atomic per-repo JSON store under `app_data_dir/sessions/<FNV-1a hash>.json` with corrupt-quarantine + newer-version refusal, canonical-path-keyed `ReviewSessionsState` with start/resume/end/get-status lifecycle commands and a throwaway 3-state ReviewPanel stub.
- Phase 66 — Pure git2 revwalk range core (root/merge handling, bad-range/unrelated-history validation, set ops, graph-ordered dedup) wrapped by four mutex-serialized seed/add/remove/list commands; CommitGraph two-right-click range gesture + Add/Remove context-menu toggle + in-session row marker.
- Phase 67 — Pure `buildDiffAnchor` capture-time adapter (selection indices → source-line anchor + diff-fenced cached excerpt, Delete-line drop with preservation in excerpt), shared `add_comment` + `save_draft_comment` writers, inline CommentComposer with debounced draft persistence, merge-commit disable, and auto-start of a session at the comment chokepoint.
- Phase 68 — Sibling `buildFullFileAnchor` adapter (flat selection → `FullFile/New` anchor + plain-content excerpt with gap markers), click + shift-click contiguous selection in `FullFileView` (new-side endpoints, even on merge commits), and CommentComposer reuse via injected FullFile captured result.
- Phase 69 — Schema v2 with stable `id: String` + `commit_oid?` on Comment and lazy v1→v2 migration; sibling `add_commit_comment`/`edit_comment`/`delete_comment` commands targeting by uuid (multi-tab-safe); `list_session_comments` + git2-backed `resolve_session_comments` orphan classifier; TS DTOs + `review-session.svelte.ts` rune; real center-pane ReviewPanel with grouped comments, inline edit, delete-confirm, jump-to-anchor, and orphan badges.
- Phase 70 — Pure Rust markdown renderer in `src-tauri/src/git/review.rs` (per-source fencing with collision-safe length, side-aware excerpt resolution, trailing unresolvable section, never panics) behind a single `generate_review_doc` IPC command with zero-comment gate; preview swap in ReviewPanel.
- Phase 71 — Awaited clipboard `writeText` with in-button ✓ Copied affordance and explicit error-toast on failure (no fire-and-forget); 8 vitest cases covering happy path, rapid re-click, timer cleanup, and three error-coercion paths.
- Phase 72 — Reviewing as a first-class in-window mode: Toolbar Review toggle with active state, simplified review-session rune (3 axes → 2), Copy directly on the comments view, and removal of the preview-pane detour (deleted `ReviewDocPreview.svelte` + its tests, removed RepoView blue strip).
- Phase 73 — Both lifecycle endpoints in the UI: cold-boot resume fires `resume_review_session` exactly once when ReviewPanel opens on a repo with an on-disk session (closes Bug 3 from 72-VERIFICATION); two-step End-review button in the header (REQ-73-END); three-way empty-state branching that distinguishes cold / warm-no-commits / warm-zero-comments; session summary caption.
- Phase 74 — Tech-debt close: CommitGraph listener canonicalPath filter + reloadSession error branching (66/WR-01..02), `seed_review_range` session-existence precheck (66/WR-03), `emit_session_changed` helper replacing 10 silent emits (66/WR-04), `slice_diff` per-hunk overlap gate via `Patch::from_diff` (70/CR-01), explicit `deriveDiffCapture` guard replacing 3× `noNonNullAssertion` (biome cleanup), and formal documentation of 70/WR-01 incidental closure by Phase 72.

### Known Gaps

Proceeded with the following non-blocking items unverified at close:

- **Pending human UAT** — cross-repo session-changed isolation across two Tauri windows (Phase 73). One outstanding scenario; all earlier UAT items in v0.13-MILESTONE-AUDIT.md still apply.
- **INT-W1** — `seed_review_range` resolves canonical repo path inside `spawn_blocking` while siblings resolve before. Stylistic inconsistency, not a bug.
- **INT-W2** — `save_draft_comment` can fail with `no_session` if End-review fires from another tab mid-draft. Edge case; out-of-band failure path is not surfaced to the composer UI.
- **Nyquist validation** — 3 of 9 phases compliant (67, 69, 72); phases 65, 66, 68, 70, 71, 73 carry draft VALIDATION.md with `wave_0_complete: false`.

Known deferred items at close: 40 (see STATE.md Deferred Items — all pre-existing across earlier milestones, none v0.13-specific blockers).

---

## v0.12 Better Diffs (Shipped: 2026-03-30)

**Phases completed:** 6 phases, 14 plans, 27 tasks

**Key accomplishments:**

- DiffRequestOptions struct with context_lines/whitespace/full-file threading through all 3 diff commands, plus WordSpan/SyntaxToken enrichment fields on DiffLine
- TypeScript DiffRequestOptions/WordSpan/SyntaxToken type mirrors, LazyStore diff preference persistence, and all 4 RepoView diff invoke calls wired to pass options
- Word-level diff via similar crate with iter_inline_changes, sequential Delete/Add pairing, and performance guards (500 char + 0.4 ratio thresholds)
- Word-diff highlights in DiffPanel with .word-add/.word-delete CSS classes, theme custom properties, and 3 new tests
- syntect-based syntax highlighting with base16-ocean.dark theme, MergedSpan type replacing separate word_spans/syntax_tokens, and 3-pass diff pipeline producing zero-gap span arrays
- MergedSpan TypeScript types, 15 syntax color CSS custom properties, DiffPanel merged-span rendering with opacity 0.7 desaturation on add/delete backgrounds
- Decomposed 667-line DiffPanel monolith into 5 focused diff/ components with view mode segmented control and two-column line number gutter
- 7 new unit tests for view mode toggle (segmented control, Full/Split stubs) and line number gutter (context/add/delete line rendering) with stateful store mock
- LazyStore preferences, CSS vars, three toolbar toggles (WS/invisibles/wrap), staging guard when whitespace ignored, word wrap toggle, and diff re-fetch callback wired end-to-end
- FullFileView continuous document renderer with invisible character rendering (middle dot/arrow) in both view modes, plus 17 new tests covering VIEW-04, WHSP-02, WHSP-03, DISP-02
- Fixed git2 whitespace API (git -w not -b), resolved async race conditions in view mode/whitespace toggle handlers, and eliminated toggle button flicker on mount
- Refactored ViewMode into ContentMode + LayoutMode with 2D dispatch, two-control toolbar with Lucide icons, legacy store migration, and phantom row CSS variable
- Side-by-side diff renderer with pairLines() row alignment, phantom spacers, synchronized vertical scrolling, resizable divider, and split+hunk/split+full mode support

---

## v0.11 Infrastructure (Shipped: 2026-03-27)

**Phases completed:** 6 phases, 16 plans, 34 tasks

**Key accomplishments:**

- GOOS-style test harness with TestContext, fluent builder (11 build steps), 11 assertion helpers, and 7 passing smoke tests
- 25 driver methods and 47 migrated integration tests for staging (13 fns), diff (4 fns), commit (3 fns), and stash (5 fns) commands using GOOS harness
- 18 driver methods wrapping branches/history/commit_actions/repo _inner functions, with 46 tests migrated to integration crate using builder fixtures and &mut self cache_map pattern
- 12 driver methods, 56 tests migrated across 6 modules, zero #[cfg(test)] modules remaining, make_test_repo removed
- Vitest jsdom+svelteTesting environment, shared factories/Tauri mock, and 32 new tests bringing total from 170 to 202
- 13 collocated component test files with 82 tests covering render, props, events, keyboard interactions, and conditional rendering using @testing-library/svelte
- 45 tests across 7 complex components covering rendering, interactions, and conditional UI with Tauri mock isolation
- 35 tests across 6 largest Svelte components (764-1826 lines each) with local Tauri mocks, class-based LazyStore, and jsdom polyfills for OffscreenCanvas/scrollTo
- 17 serde round-trip integration tests validating JSON serialization for all non-trivial IPC return types with 111 field-level shape assertions
- 14 integration tests validating multi-step git workflows (commit, merge, stash, cherry-pick, undo/redo, diff, search) and state transition chains (merge/rebase conflict resolution and abort) against real repos
- Generic watcher functions with `R: Runtime` parameter + 4 integration tests validating event emission, stop behavior, multi-repo independence, and debounce resilience using real notify events and tauri MockRuntime
- Rust coverage via cargo-llvm-cov and TypeScript coverage via @vitest/coverage-v8, with HTML artifact uploads and per-language PR comment summaries
- Criterion benchmarks for walk_commits at 100/1k/10k scales and 4 command inner functions (list_refs, diff_unstaged, get_status, stage_hunk) with OnceLock-cached git2 fixtures
- Benchmark CI workflow with regression detection via benchmark-action at 130% threshold, plus compile-check in existing CI pipeline
- WebdriverIO v9 test harness with tauri-driver lifecycle, git fixture builders, and data-testid attributes on 7 Svelte components
- 3 E2E test specs (10 tests total) covering commit history, staging workflow, and branch operations with Linux CI workflow and macOS manual checklist

---

## v0.10 CI/CD & Releases (Shipped: 2026-03-26)

**Phases completed:** 3 phases, 4 plans, 8 tasks

**Key accomplishments:**

- Fix 251 Rust fmt diffs, 29 clippy errors, 127 svelte-check errors, install Biome 2.4.9 with formatting/linting -- all 6 quality gates now pass locally
- GitHub Actions CI workflow with two-gate pipeline: 3 fast checks (biome, cargo-fmt, svelte-check) gating 3 heavy checks (clippy, cargo-test, vitest) with Rust caching and concurrency controls
- Tag-triggered GitHub Actions release workflow building Trunk for 4 platforms (macOS ARM/Intel, Linux, Windows) with tauri-action, portable .tar.gz archives, and artifact upload
- 3-job release pipeline (build -> publish -> update-tap) with auto-generated Homebrew cask formula pushed to joaofnds/homebrew-tap

---

## v0.9 Multi-tab & Tree View (Shipped: 2026-03-25)

**Phases completed:** 6 phases, 13 plans, 22 tasks

**Key accomplishments:**

- Factory functions replacing global singletons for per-tab remote/undo-redo state, TabInfo/PersistedTab type contracts, and LazyStore tab persistence helpers with 14 unit tests
- RepoView.svelte extracted with 563 lines of per-repo state, App.svelte rewritten as 321-line tab orchestrator with keep-alive rendering and Cmd+T/W/1-9 keyboard shortcuts
- Multi-tab TabBar.svelte with 144 lines: dirty indicator dots, close buttons, + new tab button, horizontal scroll, and repo-changed watcher-driven dirty detection in App.svelte
- Pure buildTree utility with trie-based algorithm, path compression, and directory-before-file sorting -- 19 TDD tests all green
- flattenTree utility with 12 passing tests, DirectoryRow component, FileRow tree-mode extensions, LazyStore persistence, and CSS focus token
- TreeFileList component with VS Code-style keyboard navigation wired into StagingPanel (4 sections), CommitDetail, and global toggle button with LazyStore persistence
- Native Tauri context menu on tabs (Close Others/Close All/Copy Path), middle-click graceful close, and duplicate repo detection with silent tab switching
- Directory count badges, hover stage/unstage buttons on directories, and Expand All / Collapse All header buttons for tree view
- SortableJS drag-and-drop tab reordering with auto-scroll, new-tab exclusion, and persisted order
- Right-click context menus on directory nodes for bulk stage/unstage/discard/resolve using native Tauri menus with file count display and discard confirmation

---

## v0.8 Conflict & Rebase (Shipped: 2026-03-23)

**Phases completed:** 7 phases, 19 plans, 36 tasks

**Key accomplishments:**

- Tauri IPC layer for merge/rebase operation detection with git2 repo.state() and 5 CLI action commands (continue/abort/skip)
- Conflict detection UI with collapsible conflicted files section, color-coded merge/rebase operation banners, and Continue/Skip/Abort action buttons
- diff_conflicted backend command using git2 diff_tree_to_workdir to show conflict markers when clicking conflicted files
- Two Tauri commands (get_merge_sides, save_merge_result) extracting conflict content from git2 index stages and persisting resolved merge output with staging
- Pure TypeScript merge parser with three-way conflict region detection, Set-based selection state, real-time output computation, and navigation helpers
- Three-panel MergeEditor.svelte with synchronized scroll, per-hunk/per-line toggle selection, editable output textarea, and Prev/Next conflict navigation
- MergeEditor routing in App.svelte for conflicted files and Take All Current/Incoming context menu in StagingPanel for quick resolution
- Wired output textarea into three-way scroll sync via panelRefs[2] binding and handleScroll(2) handler
- handleFileResolved queries get_status after resolution to auto-open next conflicted file or return to CommitGraph when none remain
- Fix manualEdit override in toggle/take handlers and wire StagingPanel context menu resolution to App handleFileResolved
- Merge context menu items wired to all 6 branch surfaces using Tauri native menus, with silent success and error-only toasts
- Rebase context menu items on all 6 branch surfaces (pills, overflow refs, sidebar) with toast-free success handling
- get_rebase_todo/get_fork_point backend commands, validateRebasePlan with 9 test cases, CSS rebase tokens, InputDialog configurable labels, LazyStore rebase column persistence
- RebaseEditor Svelte component with 5-column layout, native DnD reordering, P/S/R/D keyboard shortcuts, color-coded action dropdowns, inline validation errors, and LazyStore-persisted column widths/visibility
- Interactive rebase execution engine with GIT_SEQUENCE_EDITOR for custom todo and GIT_EDITOR shell script for file-based IPC message editing
- RebaseEditor wired into App center pane with context menu entry points in CommitGraph (commit, pill, overflow ref menus) and BranchSidebar, plus reword/squash message dialog via event listener
- Squash message pre-editing with combined messages, corrected column order (Message before SHA), and stable squash arrow positioning
- Skip Commit button added to StagingPanel inline rebase form with silent-skip behavior aligned across both StagingPanel and OperationBanner
- Removed orphaned diff_conflicted command/tests, fixed rebaseBaseName branch resolution via resolve_ref IPC, cleaned dead InputDialog import, narrowed diffKind type

---

## v0.7 Hunk Staging & Search (Shipped: 2026-03-19)

**Phases completed:** 5 phases, 8 plans, 0 tasks

**Key accomplishments:**

- (none recorded)

---

## v0.6 UI Polish & Core Ops (Shipped: 2026-03-16)

**Phases:** 6 (incl. 27.1) | **Plans:** 16 | **Commits:** ~129 | **Timeline:** 2 days
**Git range:** 9ff6c95 (feat(27-01)) → b1ef642 (fix: root commit branch tip + scroll)

**Delivered:** Lucide icon set replacing Unicode symbols across all components, toast notification system for operation feedback, discard/delete/rename/reset destructive operations with confirmation dialogs, three-way commit/amend/stash selector, graph polish (padding, column shrink, sticky dots), sidebar ref navigation, unified title bar, and two bug fixes from TODO.md.

**Key accomplishments:**

1. Icon system: @lucide/svelte replacing all Unicode symbols in Toolbar, FileRow, StagingPanel, CommitForm, BranchSidebar, TabBar, and SVG overlay pills
2. Toast notification system with Svelte 5 $state store, auto-dismiss, fly transition, and per-kind styling (error/success)
3. Destructive operations: discard file/all (git2 checkout + fs::remove_file), delete branch/tag, rename branch, reset — all with confirmation dialogs and toast feedback
4. Three-way commit/amend/stash selector replacing amend checkbox; stash mode auto-populates subject as stash name
5. Graph CSS polish: viewport padding, column overflow-hidden with fixed minimum, sidebar click scrolls to ref commit with resolve_ref backend command
6. Unified title bar: decorations:false + drag region + traffic light padding; right pane auto-opens on commit/ref click

---

## v0.5 Graph Overlay (Shipped: 2026-03-15)

**Phases:** 7 | **Plans:** 12 | **Commits:** 111 | **Timeline:** 2 days
**LOC:** ~6,038 Rust / ~4,417 Svelte / ~1,102 TypeScript / ~1,463 Tests
**Git range:** 1144693 (feat(20-01)) → 85af781 (test: complete UAT)

**Delivered:** Single SVG overlay architecture replacing per-row viewBox-clipped SVGs, with cubic bezier curve rendering, TypeScript active lanes transformation with edge coalescing, virtualized element filtering, Canvas-measured SVG ref pills with hover expansion, and full interaction preservation.

**Key accomplishments:**

1. Single SVG overlay spanning full graph height with native scroll sync and pointer-events passthrough — zero JS scroll synchronization
2. TypeScript Active Lanes transformation with edge coalescing reducing edge count from O(commits x lanes) to O(lanes + merge_edges)
3. Cubic bezier curve rendering with adaptive corner radius replacing Manhattan routing, three-layer z-ordered SVG (rails → edges → dots)
4. Virtualized SVG element filtering with O(1) viewport range-intersection via minRow/maxRow metadata
5. SVG ref pills with Canvas-based text measurement, capsule shapes, lane colors, connector lines, remote dimming, and overflow +N hover expansion
6. Clean integration: unified constants (16px lanes, 36px rows), ~1,000 lines dead code removed, all click/context-menu interactions preserved

---

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
