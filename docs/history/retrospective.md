# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v0.1 — MVP

**Shipped:** 2026-03-09
**Phases:** 6 | **Plans:** 27 (26 complete) | **Commits:** 155 | **Timeline:** 7 days

### What Was Built
- Vite+Svelte SPA with Tailwind v4 dark theme and shared Rust/TypeScript primitives
- Visual commit graph with Rust lane algorithm, inline SVG, and virtual scrolling
- Branch sidebar with checkout, search, dirty-workdir error handling, and branch creation
- Working tree staging panel with filesystem watcher auto-refresh
- Commit creation/amendment with validation and immediate graph refresh
- Unified diff display for workdir/staged/commit diffs with commit metadata

### What Worked
- **TDD inner-fn pattern**: Separating Tauri state from pure git2 logic made all commands directly testable without the Tauri runtime
- **Phase execution speed**: 6 phases in 7 days — tight dependency chain kept each phase focused
- **safeInvoke wrapper**: Single IPC abstraction eliminated error handling boilerplate across all frontend components
- **Cache repopulate-before-emit**: Solved race conditions between mutation commands and graph remount elegantly
- **Gap closure plans**: When UAT revealed issues, adding targeted plans (02-07, 02-08, 02-09) was clean and traceable

### What Was Inefficient
- **Graph algorithm required 3 iterations**: Plans 02-07, 02-08, 02-09 were all gap closures for the lane algorithm — initial algorithm design underestimated edge cases (first-parent edges, column priority, pass-through edges)
- **GRAPH-04 never implemented**: Merge commit visual distinction was in the requirement and the Rust DTO but never wired in the Svelte template — slipped through because verification focused on algorithm correctness, not rendering completeness
- **Phase 06 VERIFICATION.md never created**: The diff feature was code-complete but formal verification was skipped
- **ROADMAP progress table got stale**: Phase 2 and Phase 4 showed incorrect completion counts in the progress table

### Patterns Established
- **inner-fn pattern**: `*_inner()` functions for pure git2 logic; thin Tauri wrappers handle state extraction and spawn_blocking
- **safeInvoke<T>**: All Tauri IPC goes through this wrapper; never raw `invoke()`
- **Sequence counter for async guards**: `loadSeq` pattern discards stale async responses
- **{#key graphKey} remount**: Forces full CommitGraph re-render after mutations; key resets on repo close
- **Cache repopulate before emit**: Any command that invalidates CommitCache must repopulate before emitting `repo-changed`
- **CSS flex truncation**: overflow:hidden on container + min-width:0 + flex:1 on text span

### Key Lessons
1. **Graph algorithms need more upfront design**: The lane algorithm went through 3 gap-closure iterations — investing more time in edge case analysis before implementation would have saved effort
2. **Verification must cover rendering, not just logic**: GRAPH-04 passed algorithm verification but the frontend rendering was never checked
3. **Keep progress tables in sync**: Stale ROADMAP progress counts cause confusion during milestone completion
4. **Svelte 5 runes require assignment for reactivity**: Mutating collections in place doesn't trigger updates — must use immutable patterns (new Set, spread)
5. **git2 API quirks need discovery**: `is_head_unborn()` missing in 0.19, `stash_foreach` requires `&mut Repository`, `peel_to_commit()` has lifetime conflicts — each required workaround discovery

---

## Milestone: v0.2 — Commit Graph

**Shipped:** 2026-03-10
**Phases:** 4 | **Plans:** 9 | **Commits:** 76 | **Timeline:** 2 days

### What Was Built
- Hardened Rust lane algorithm with ghost lane fix, octopus protection, max_columns, and branch color counter
- Three-layer SVG lane rendering (rails -> edges -> dots) with vivid 8-color palette
- Manhattan-routed merge/fork edges with 6px rounded corners
- Merge commits as hollow circles, WIP row in virtual list with dashed connector
- Lane-colored ref pills with remote dimming and connector lines
- 6-column resizable layout with LazyStore-persisted widths and column visibility toggles

### What Worked
- **Dedicated milestone for graph rendering**: Deferring lanes from v0.1 was the right call — focused effort produced a clean result in 2 days
- **GraphResult wrapper type**: Returning max_columns alongside commits eliminated SVG width inconsistency at the root
- **Three-layer SVG architecture**: Separating rails/edges/dots made it easy to add conditional rendering (hollow merge dots, dashed WIP) without conflicts
- **Gap closure as numbered plans**: Plans 10-03, 10-04, 10-05 cleanly addressed UAT findings without disrupting the main plan sequence
- **LazyStore pattern reuse**: ColumnWidths and ColumnVisibility both followed the same getter/setter/persistence pattern — second use was trivial

### What Was Inefficient
- **Phase 10 needed 5 plans for 2 requirements**: DIFF-01 and DIFF-02 spawned 3 gap-closure plans (10-03, 10-04, 10-05) — initial plans underestimated the visual integration complexity of connector lines spanning multiple columns
- **ROADMAP plan checkboxes got stale**: Plans 10-04 and 10-05 were marked `[ ]` even though SUMMARY files existed — same issue as v0.1
- **VIS-03 reinterpreted silently**: "Reduced opacity" became "hollow dot only" — the requirement text should have been updated to match the implementation decision

### Patterns Established
- **GraphResult wrapper**: walk_commits returns struct with commits + max_columns, not bare Vec
- **Branch color counter**: Monotonic counter, HEAD=0, freed columns remove entries
- **Sentinel oid pattern**: `'__wip__'` for synthetic items in GraphCommit array
- **displayItems derived**: Wrapping backend data with frontend-only synthetic items
- **LazyStore for UI state**: Column widths and visibility both use this pattern
- **Cross-column visual elements**: Absolute-positioned divs at row level, not within column SVGs
- **Native Tauri Menu API**: Preferred over custom Svelte context menus for native UX

### Key Lessons
1. **Visual integration is harder than rendering**: Drawing individual elements is straightforward; making them work together across column boundaries required 3 additional plans
2. **Keep ROADMAP checkboxes in sync**: This is the second milestone where plan checkboxes got stale — consider automating or removing them
3. **Update requirement text when reinterpreting**: When a design decision changes the meaning of a requirement, update REQUIREMENTS.md immediately
4. **52 tests, zero regressions**: The test suite from v0.1 protected against algorithm regressions effectively through all 4 phases

---

## Milestone: v0.3 — Actions

**Shipped:** 2026-03-12
**Phases:** 4 | **Plans:** 14 | **Commits:** 88 | **Timeline:** 3 days

### What Was Built
- Full stash management (create/pop/apply/drop) with graph-integrated stash rows and right-click context menu
- Commit context menu with copy, checkout, branch, tag, cherry-pick, revert (merge commits disabled)
- Remote fetch/pull/push via git CLI subprocess with per-line progress streaming
- Quick actions toolbar merged with tab bar into single top row
- Branch ahead/behind tracking computed inside list_refs
- Undo/redo last commit with race-condition guards

### What Worked
- **git CLI for remote ops**: Shelling out to git avoided libgit2 SSH/HTTPS auth issues entirely — clean subprocess pattern reused for cherry-pick/revert
- **Sentinel OID pattern extension**: `__stash_N__` reused the `__wip__` pattern for stash graph rows — zero new abstraction needed
- **$derived.by() for complex reactivity**: Cleaner than IIFE pattern for imperative splice logic in displayItems
- **Shared $state rune modules**: remote-state.svelte.ts provided clean cross-component communication without prop drilling
- **Ahead/behind in list_refs**: Computing inside existing map closure avoided extra IPC round-trip

### What Was Inefficient
- **Stash graph rendering failed and was redone**: Plan 11-02 was entirely removed during UAT and reimplemented as 11-05 — the initial approach had too many rendering bugs
- **ROADMAP plan checkboxes still getting stale**: Third milestone with this issue — plans 11-05, 11-06, 12-01, 12-02, 13-03, 14-03 all show `[ ]` despite being complete
- **Redo race condition**: clearRedoStack in repo-changed listener fired during undo/redo operations — required targeted gap closure plan (14-03)

### Patterns Established
- **git CLI subprocess pattern**: GIT_TERMINAL_PROMPT=0 + GIT_SSH_COMMAND for batch mode; PID stored in RunningOp for cancellation
- **$derived.by()**: Preferred over IIFE $derived for imperative reactive computations
- **Shared $state rune modules**: For cross-component state (remote-state.svelte.ts)
- **InputDialog $state dialogConfig**: Set config to show dialog, null to hide
- **Two-pass borrow pattern**: Collect into Vec first, then process — for git2 mutable borrow conflicts

### Key Lessons
1. **Plan for graph rendering failures**: Visual features that integrate with the virtual list need careful testing before merging — 11-02 was a complete redo
2. **Race conditions in event-driven architectures**: repo-changed events fire for both user actions and programmatic mutations — guards (isUndoing/isRedoing) are necessary
3. **Duplicating small helpers is OK**: open_repo/is_dirty duplicated in commit_actions.rs to avoid cross-module dependencies — pragmatic over DRY
4. **14 plans in 3 days**: Velocity increasing with established patterns — each plan averaged ~30 min

---

## Milestone: v0.4 — Graph Rework

**Shipped:** 2026-03-13
**Phases:** 3 | **Plans:** 5 | **Commits:** ~30 | **Timeline:** 1 day

### What Was Built
- GraphSvgData computing one SVG path per commit-to-commit edge with Manhattan routing
- ViewBox-clipped per-row rendering of full SVG paths (no per-row seams)
- Commit dot rendering as individual SVG elements (filled for regular, hollow for merges)
- WIP row with dashed connector and stash rows with square dots in new SVG model

### What Worked
- **Per-row viewBox approach**: Quick to implement, validated that continuous paths look better than per-row fragments
- **Clean phase scoping**: 3 focused phases (data engine, rendering, synthetic rows) with clear boundaries
- **Decision to carry phases forward**: Phases 18-19 (ref pills, interactions) correctly deferred to v0.5 rather than forcing into v0.4

### What Was Inefficient
- **Architecture replaced in next milestone**: Per-row viewBox clipping worked but was immediately superseded by the single SVG overlay in v0.5 — the intermediate step added code that was deleted 1 day later
- **Short-lived milestone**: v0.4 lasted 1 day before v0.5 planning began — could have been folded into v0.5

### Key Lessons
1. **Intermediate architectural steps can be wasteful**: v0.4's per-row approach was functional but immediately replaced — sometimes it's better to invest in the final architecture directly
2. **Decision gates are valuable**: Phase 20's decision gate in v0.5 validated the overlay approach before full investment — this should be standard for architectural changes

---

## Milestone: v0.5 — Graph Overlay

**Shipped:** 2026-03-15
**Phases:** 7 | **Plans:** 12 | **Commits:** 111 | **Timeline:** 2 days

### What Was Built
- Single SVG overlay spanning full graph height with native scroll sync (zero JS)
- TypeScript Active Lanes transformation with edge coalescing (O(commits x lanes) → O(lanes + merge_edges))
- Cubic bezier curve rendering with adaptive corner radius replacing Manhattan routing
- Three-layer z-ordered SVG (rails → edges → dots) with virtualized element filtering
- SVG ref pills with Canvas-based text measurement, connector lines, remote dimming, overflow +N hover expansion
- Clean integration: unified constants, ~1,000 lines dead code removed, all interactions preserved

### What Worked
- **Decision gate (Phase 20)**: Validating scroll sync and pointer-events passthrough before investing 5 more phases avoided a potential full rework
- **TDD throughout**: buildGraphData, buildOverlayPaths, getVisibleOverlayElements, buildRefPillData, measureTextWidth all built test-first — tests caught regressions during integration
- **Parallel phase design**: Phases 21+22 could execute in parallel (both depend only on Phase 20 types), and Phases 25+26 both depend on Phase 24 — well-structured dependency graph
- **Injectable measureFn**: OffscreenCanvas for production, mock function for tests — deterministic text measurement tests
- **Edge coalescing**: Reducing edge count made the overlay performant on large repos without explicit optimization
- **Gap closure plans scoped tightly**: 23-03 and 23-04 were small, targeted fixes (positioning, test constants) — resolved quickly

### What Was Inefficient
- **OVERLAY_ROW_HEIGHT confusion**: Initially set to 36px, then corrected to 26px (Phase 23-03), then 11 tests broke because they hardcoded 36 (Phase 23-04) — constants should have been settled before test-writing
- **Some ROADMAP plan checkboxes still unchecked**: Phases 22, 23, 25, 26 have `[ ]` in ROADMAP despite having SUMMARYs — persistent issue from v0.1
- **HTML hover overlay for ref pills**: SVG-only approach couldn't handle multi-ref expansion elegantly — needed a hybrid SVG+HTML solution, adding complexity

### Patterns Established
- **SVG overlay architecture**: Single SVG in scroll container with pointer-events:none, HTML handles interactions beneath
- **Pure transformation pipeline**: GraphCommit[] → buildGraphData → buildOverlayPaths → getVisibleOverlayElements → SVG rendering — each step is a pure function
- **Injectable dependencies for testing**: measureFn pattern for Canvas text measurement — can mock in tests
- **Range-intersection filtering**: minRow/maxRow metadata on paths enables O(1) visibility checks
- **translate-based multi-column SVG**: SVG spans ref+graph columns, existing graph groups offset via translate()

### Key Lessons
1. **Decision gates before architectural investment**: Phase 20's POC validation saved potentially wasted effort — make this standard for any architecture change
2. **Settle constants early**: OVERLAY_ROW_HEIGHT changing mid-milestone caused cascading test fixes — lock dimensions before writing tests
3. **Pure function pipelines are testable**: Every step in the overlay pipeline (data, paths, visibility, pills) was independently testable because they're pure functions with no side effects
4. **Edge coalescing is a performance multiplier**: Reducing O(commits x lanes) edges to O(lanes + merge_edges) made virtualization almost unnecessary — but having both is defense in depth
5. **12 plans in 2 days**: Fastest pace yet — established patterns from 4 prior milestones enabled rapid execution

---

## Milestone: v0.6 — UI Polish & Core Ops

**Shipped:** 2026-03-16
**Phases:** 6 (incl. 27.1) | **Plans:** 16 | **Commits:** ~129 | **Timeline:** 2 days

### What Was Built
- Lucide icon set replacing all Unicode symbols across Toolbar, FileRow, StagingPanel, CommitForm, BranchSidebar, TabBar, and SVG overlay pills
- Toast notification system: Svelte 5 $state store, auto-dismiss timer, fly transition, per-kind styling (error/success)
- Destructive operations: discard file/all (git2 checkout + fs::remove_file for untracked), delete branch/tag, rename branch, reset (soft/mixed/hard) — all with confirmation dialogs and toast feedback
- Three-way commit/amend/stash selector replacing amend checkbox; stash mode auto-populates subject as stash name
- Graph CSS polish: viewport padding, column overflow-hidden with fixed minimum, sidebar click scrolls to ref commit via resolve_ref backend command
- Unified title bar: decorations:false + drag region + macOS traffic light padding (78px); right pane auto-opens on commit/ref click
- Bug fixes from TODO.md: window rubber-band scroll (overflow:hidden on html/body), root commit downward branch tip (isBranchTip=true for root commits)

### What Worked
- **Established patterns enabled fast delivery**: All backend commands used the inner-fn pattern; all frontend IPC used safeInvoke — zero new architecture decisions needed
- **Wave 0 test scaffolds**: Writing failing tests before implementation (Phase 27-01) verified TDD discipline and caught the toast store import issue early
- **Phases 27-31 executed in 2 days**: Fastest multi-phase milestone yet — UI work is less risky than graph algorithm work
- **TODO.md as pre-archive checklist**: Reviewing TODO.md before closing found 2 real bugs (scroll gap, root commit tip) that were quick to fix and worth shipping in v0.6
- **Decimal phase (27.1) for urgent insertion**: Clean way to insert an urgent fix without renumbering subsequent phases

### What Was Inefficient
- **Phase 30 "Plans: TBD" in ROADMAP**: Phase 30 had `Plans: TBD` at roadmap creation time — should have been planned at the same time as other phases
- **STATE.md progress bar stale**: Progress bar in STATE.md showed `3/5 phases` even after all 5 completed — hand-maintained state drifted
- **REQUIREMENTS.md traceability stale**: GRAPH-01/02/03, LAYOUT-01/02 stayed "Pending" in the traceability table after phases 30/31 completed — not updated post-execution
- **gsd-tools couldn't find phase plans** (archived to v0.6-phases/ before CLI ran): CLI reported 0 phases/plans in MILESTONES.md — had to manually fill stats

### Patterns Established
- **`@lucide/svelte` not `lucide-svelte` for Svelte 5**: `lucide-svelte` causes SvelteComponent type errors; `@lucide/svelte` is the correct Svelte 5 package
- **`decorations: false` + drag region**: Native titlebar removal pattern; `data-tauri-drag-region` on non-interactive elements, `padding-left: 78px` for macOS traffic lights
- **`overflow: hidden` on html/body**: Required with `decorations: false` to prevent macOS rubber-band scroll from creating a window gap
- **`isBranchTip = true` for root commits**: Root commits have no parents but may have `active_lanes[col] = Some(...)` set by their child — must explicitly mark as tip
- **discard uses git2 checkout for tracked, fs::remove_file for untracked**: No git CLI subprocess needed; `discard` commands skip cache rebuild since FS watcher handles workdir detection
- **clearRedoStack guard for stash mode**: stash doesn't modify commit history so clearRedoStack must be skipped

### Key Lessons
1. **Archive phases before running milestone CLI**: gsd-tools `milestone complete` relies on finding phase files in `.planning/phases/` — archiving first causes 0-count MILESTONES.md entries
2. **TODO.md review before milestone close is high-value**: Found 2 bugs in 5 minutes that were straightforward to fix and improved the shipped quality
3. **UI polish milestones are faster than graph milestones**: 16 plans/2 days vs 12 plans/2 days for v0.5, with less uncertainty — established patterns do the heavy lifting
4. **Stale traceability tables are misleading**: Update requirement statuses immediately after phase completion, not at milestone close
5. **Root commit edge cases in graph algorithms**: The isBranchTip detection used `active_lanes[col].is_none()` but a child sets that slot before the root processes — always cross-check with `parent_count() == 0`

---

## Milestone: v0.7 — Hunk Staging & Search

**Shipped:** 2026-03-19
**Phases:** 5 | **Plans:** 8 | **Commits:** ~12 feat + docs | **Timeline:** 2 days

### What Was Built
- Hunk staging backend: stage/unstage/discard individual hunks via git2 apply API with hunk_callback counter
- Context-aware hunk toolbar in DiffPanel with binary file guards and keyboard [/] navigation
- Line-level staging: click/shift-click selection, partial patch construction from selected lines
- Search backend: TDD search_commits with SHA/message/ref/author matching over CommitCache
- Search UI: VS Code-style floating SearchBar with Cmd+F activation, two-tier match highlighting, keyboard navigation with auto-scroll, SVG overlay dimming

### What Worked
- **TDD for backend commands**: Hunk and search commands were built test-first — 18 staging tests and 14 search tests caught edge cases (stale indices, empty queries, no-newline-at-EOF) before any UI work started
- **Clean separation between backend and UI phases**: Phase 32 (hunk backend) → 33 (hunk UI) → 34 (line-level) and Phase 35 (search backend) → 36 (search UI) — each phase had well-defined inputs and outputs
- **Pure presentation SearchBar**: Keeping search state in CommitGraph and making SearchBar stateless simplified both components — SearchBar is just props + callbacks
- **Capture-phase Cmd+F handler**: `{ capture: true }` on window keydown intercepted before WebView native find — clean single-line fix for macOS WKWebView
- **Gap closure for shift+click text selection**: Phase 34.03 was a single-line `onmousedown` handler fix — targeted gap closure plans continue to work well

### What Was Inefficient
- **SUMMARY.md one-liner fields not populated**: All 8 SUMMARY.md files lacked one-liner fields — required manual extraction during milestone completion
- **ROADMAP plan checkboxes still stale**: Plans 32-01 through 36-02 all showed `[ ]` despite having SUMMARY.md files — seventh consecutive milestone with this issue
- **Nyquist validation incomplete**: 3 phases had draft VALIDATION.md (not compliant), 2 phases missing entirely — validation strategy step continues to be skipped during fast execution
- **REQUIREMENTS.md traceability table statuses not updated**: All 20 requirements stayed "Planned" even after phase completion — only checkboxes were updated

### Patterns Established
- **git2 apply API for hunk operations**: hunk_callback with counter for single-hunk targeting; reverse flag for unstage/discard
- **Partial patch text construction**: Build new diff text from selected lines, recalculate @@ header line counts, handle no-newline-at-EOF edge case
- **Capture-phase keyboard handler**: `{ capture: true }` on window event listeners to intercept before WebView native handlers
- **Search state owned by parent, presentation component stateless**: CommitGraph owns searchQuery/searchResults/searchCurrentIndex; SearchBar just renders and fires callbacks
- **SVG global dimming**: opacity on entire SVG overlay element rather than per-element tracking — simple and effective for non-segmentable elements (rails span multiple rows)

### Key Lessons
1. **Backend-first phases enable clean UI phases**: When the backend commands are complete and tested, the UI phase is purely about wiring and presentation — reduces risk
2. **Small milestones ship fast**: 5 phases / 8 plans in 2 days — well-scoped features with clear requirements execute quickly
3. **Nyquist validation needs enforcement**: 7 milestones in and validation strategies are still skipped — consider making it mandatory in execute-phase or dropping the requirement
4. **SUMMARY one-liners should be enforced**: Missing one-liners required manual accomplishment extraction during milestone completion — executor template should enforce this field
5. **20 requirements fully satisfied on first pass**: Zero gap-closure requirements — only one targeted fix (34-03 shift+click) was needed, and it was caught during UAT not verification

---

## Milestone: v0.8 — Conflict & Rebase

**Shipped:** 2026-03-23
**Phases:** 7 | **Plans:** 19 | **Commits:** 61 | **Timeline:** 4 days

### What Was Built
- Conflict detection with collapsible conflicted files section and color-coded merge/rebase operation banners
- Three-panel merge editor with synchronized scroll, per-hunk/per-line toggle selection, and editable output textarea
- Merge initiation via context menu on all 6 branch surfaces (sidebar, graph pill, overflow ref) with silent success
- Rebase initiation and mid-rebase conflict resolution with pause/continue/skip/abort flow
- Interactive rebase editor with Pick/Squash/Reword/Drop actions, drag-and-drop reordering, keyboard shortcuts
- File-based IPC engine: GIT_SEQUENCE_EDITOR for custom todo, GIT_EDITOR shell script for reword/squash message editing
- Gap closure: Skip button in inline rebase UI, tech debt cleanup (orphaned commands, dead imports, type fixes)

### What Worked
- **git2 repo.state() for operation detection**: Single API call replaces manual filesystem checks for .git/MERGE_HEAD, .git/rebase-merge/, etc.
- **Merge editor reuse across operations**: MergeEditor component serves merge, rebase, and interactive rebase conflict resolution — zero duplication
- **File-based IPC for GIT_EDITOR**: Shell script touches signal file, Rust polls, frontend writes response — avoids stdin piping complexity
- **Audit-driven gap closure**: v0.8 milestone audit identified REB-06 integration gap and 5 tech debt items — Phases 42 and 43 closed all gaps before milestone completion
- **Backend-first phase pattern continued**: Phase 37 (backend) → 38 (editor) → 39-40 (workflow) → 41 (interactive) — each phase built on tested foundations
- **Silent success pattern**: No toast on merge/rebase/skip — graph refresh via repo-changed event is sufficient, consistent across all operations

### What Was Inefficient
- **Phase 38 required 7 plans**: Initial 4 plans + 3 gap closures (scroll sync, auto-advance, manual edit fix) — merge editor complexity was underestimated
- **Phase 41 required extensive debugging**: Rebase message IPC needed 5+ debug sessions for signal file detection, state reset races, squash message timing
- **Milestone audit found gaps after 5 phases "complete"**: REB-06 marked complete in REQUIREMENTS.md but the integration path was broken — verification at phase level missed cross-phase integration issues
- **Nyquist validation still incomplete**: All 5 audited phases had draft VALIDATION.md (nyquist_compliant: false) — 8th consecutive milestone with this pattern

### Patterns Established
- **File-based IPC for external editors**: Shell script + signal file + Rust poll loop + frontend response — reusable for any git operation requiring editor interaction
- **Index::conflicts() iterator**: git2 0.19 pattern for extracting ours/theirs/base content from merge conflicts
- **Sequential scan for three-way merge parsing**: Simple sync-point search instead of full LCS/Myers diff — adequate for conflict region detection
- **Inline operation UI in StagingPanel**: Rebase replaces OperationBanner with custom inline UI (form, buttons, commit message) for richer UX
- **Static StdMutex for cross-command state**: REBASE_SESSION_DIR shared between start_interactive_rebase and submit_rebase_message commands

### Key Lessons
1. **Milestone audits catch integration gaps that phase verification misses**: Phase 40 passed component-level verification for REB-06, but the StagingPanel inline UI bypassed OperationBanner — milestone-level audit found it
2. **Merge editor complexity warrants spike/POC**: 7 plans for one component — the three-panel layout, scroll sync, selection state, and output computation each had unexpected edge cases
3. **File-based IPC is robust but hard to debug**: Signal file timing, poll intervals, state reset races required multiple iterations — document the protocol thoroughly
4. **Gap closure phases (42, 43) are a clean pattern**: Dedicated phases for audit-identified gaps keep the main phases clean and traceable
5. **19 plans in 4 days**: Largest plan count since v0.6 (16 plans/2 days) — conflict resolution and interactive rebase are the most complex features shipped so far

---

## Milestone: v0.9 — Multi-tab & Tree View

**Shipped:** 2026-03-25
**Phases:** 6 | **Plans:** 13 | **Commits:** 88 | **Timeline:** 3 days

### What Was Built
- Per-repo backend state scoping: HashMap-keyed RunningOp for independent remote operations across tabs
- Multi-tab frontend: factory-based per-tab state, keep-alive rendering, Cmd+T/W/1-9 shortcuts, dirty indicators, persisted tabs
- TabBar with context menu, middle-click close, duplicate detection, drag-and-drop reorder via SortableJS
- Trie-based flat-to-tree data layer with path compression, directory-before-file sorting, 19 TDD tests
- Tree view UI: DirectoryRow/FileRow components, VS Code-style keyboard navigation, LazyStore-persisted toggle
- Tree features: directory staging, file count badges, Expand All/Collapse All, directory right-click context menus

### What Worked
- **Factory function migration**: Per-tab state factories with backward-compat singleton aliases allowed incremental migration — consumers compiled without changes until Plan 02
- **Keep-alive rendering (display:contents/none)**: Zero-cost hidden tabs — no remount overhead when switching, Rust cache makes initial mount fast anyway
- **TDD for data layer**: buildTree (19 tests) and flattenTree (12 tests) were pure functions, perfect for TDD — caught path compression edge cases early
- **Parallel plan execution**: Plans 49-01 and 49-02 executed in parallel with worktree isolation — no conflicts on independent file sets
- **Existing patterns reuse**: SortableJS from RebaseEditor, dynamic Tauri menu imports from tab context menu, prefix-match directory staging — minimal new patterns needed

### What Was Inefficient
- **SortableJS {#key} bug**: Plan followed RebaseEditor's {#key items} pattern, but TabBar's `tabs` changes more frequently (dirty state), causing the Sortable to orphan. Required post-execution fix — the pattern wasn't wrong for RebaseEditor but was wrong for TabBar
- **Missing new-tab deduplication**: Cmd+T could open unlimited empty tabs — caught in manual testing after execution, not in planning
- **Missing copy-path in directory menus**: File context menus had copy path but directory menus didn't — inconsistency caught in manual testing

### Patterns Established
- **Per-tab state factory**: createRemoteState()/createUndoRedoState() returning $state objects — reusable for any per-instance state isolation
- **Keep-alive tab rendering**: display:contents for active, display:none for hidden — App.svelte as tab orchestrator, RepoView as per-repo island
- **Trie-based tree building**: O(n) flat-to-tree with path compression — generic utility, not coupled to any component
- **Signal counter for expand/collapse**: Increment counter, child detects change via $effect — avoids prop drilling callbacks

### Key Lessons
1. **Don't blindly copy patterns across contexts**: {#key items} worked in RebaseEditor because `items` only changed on reorder; TabBar's `tabs` changes for many reasons (dirty state, add/close) — same pattern, different failure mode
2. **Fastest milestone yet per plan**: 13 plans in 3 days — small focused phases with clear dependencies enabled rapid execution
3. **Manual testing catches UX gaps that automated checks miss**: Both the new-tab dedup and copy-path inconsistency were UX issues, not type/logic errors
4. **Parallel execution works well for independent file sets**: 49-01 (TabBar) and 49-02 (StagingPanel/TreeFileList/DirectoryRow) had zero overlap — worktree isolation unnecessary for file-disjoint plans

---

## Milestone: v0.10 — CI/CD & Releases

**Shipped:** 2026-03-26
**Phases:** 3 | **Plans:** 4 | **Timeline:** 2 days

### What Was Built
- Biome 2.4.9 installed with full codebase formatting; 251 Rust fmt diffs, 29 clippy errors, 127 svelte-check errors fixed
- GitHub Actions CI workflow with two-gate pipeline: biome/cargo-fmt/svelte-check gating clippy/cargo-test/vitest
- Tag-triggered cross-platform release workflow for macOS ARM/Intel, Linux, Windows with .dmg/.AppImage/.msi + portable .tar.gz
- 3-job release pipeline: build -> publish (auto-publish draft) -> update-tap (generate Homebrew cask with SHA256, push to homebrew-tap)

### What Worked
- **Smallest milestone yet**: 3 phases, 4 plans, 2 days — CI/CD work is well-scoped and deterministic compared to UI features
- **Research phase value**: Phase 52 research identified exact DMG naming patterns, tauri.conf.json version vs git tag version distinction, and the on_intel/on_arm cask pattern — avoided runtime surprises
- **Existing patterns reuse**: release.yml extended the CI workflow patterns (action versions, system deps, caching) established in Phase 50
- **Incremental pipeline verification**: Testing with prerelease tag first (v0.10.0-test1) confirmed build+publish, then production tag (v0.10.0) confirmed the full pipeline including tap update

### What Was Inefficient
- **Prerelease tag test was incomplete**: v0.10.0-test1 skipped the most critical new code (update-tap job) by design. Should have gone straight to a non-prerelease tag to test the full pipeline, or at minimum recognized the limitation before suggesting brew install
- **DIST-01 left unchecked in REQUIREMENTS.md**: Pipeline was verified working but the requirement wasn't marked complete — traceability gap

### Patterns Established
- **CI two-gate pipeline**: Fast format/lint checks gate heavy compilation/test jobs — established for all future CI work
- **Release pipeline chain**: build -> publish -> update-tap with job-level `needs:` dependencies
- **Heredoc cask template**: Shell-based template with sed placeholder replacement — simple, no extra tooling

### Key Lessons
1. **Test what you actually built**: Prerelease tags skip the tap update by design — testing with one only verifies 2/3 of the pipeline. Always test the critical path end-to-end
2. **CI/CD milestones are fast**: Deterministic file creation (workflow YAML) with clear APIs (GitHub Actions) makes for rapid execution — no UI ambiguity, no visual edge cases
3. **Cross-repo automation needs secrets upfront**: HOMEBREW_TAP_TOKEN had to be created manually before the pipeline could work — user setup tasks should be flagged early

---

## Milestone: v0.11 — Infrastructure

**Shipped:** 2026-03-27
**Phases:** 6 | **Plans:** 16 | **Timeline:** 2 days

### What Was Built
- GOOS-style Rust test harness with TestContext builder, 55 driver methods, 156 integration tests across 12 modules
- Frontend unit test suite: 364 vitest tests across 41 files covering all TypeScript utilities and 26 Svelte components
- Integration tests: 17 serde round-trip tests, 14 multi-step git workflow tests, 4 filesystem watcher tests with real notify events
- Test coverage reporting: cargo-llvm-cov (Rust) + @vitest/coverage-v8 (TS) with CI artifact uploads and PR comments
- Criterion benchmarks: 7 command functions at varying scales + IPC round-trip + startup sequence, with CI regression detection at 130% threshold
- WebdriverIO + tauri-driver E2E harness: 10 tests across 3 specs (history, staging, branches) with separate Linux CI workflow

### What Worked
- **Inner-fn pattern payoff**: The pattern established in v0.1 made every backend command directly testable — 156 integration tests without the Tauri runtime
- **Phase execution speed**: 16 plans in 2 days — testing/infrastructure work is deterministic compared to UI features
- **Test data builders**: Fluent TestContext builder with 11 build steps made test setup composable and readable
- **Component testing with @testing-library/svelte**: Tauri invoke mocking via vi.mock allowed testing real user interactions
- **OnceLock fixtures for benchmarks**: Cached git2 repos across iterations avoided setup overhead in hot loops
- **Separate E2E CI workflow**: e2e.yml runs independently of main CI — long-running E2E tests don't block fast checks

### What Was Inefficient
- **BENCH-03/BENCH-04 deferred then forgotten**: Phase 57 plan noted these as "deferred to Phase 58" but Phase 58 was E2E-focused — requirements slipped through until milestone completion
- **Code signing phase removed**: Phase 59 was planned but Apple Developer fee made it infeasible — could have been caught during initial requirements gathering
- **Phase naming mismatch**: Milestone was labeled "v1.0 Infrastructure" in planning but shipped as v0.11 — version naming should be decided upfront

### Patterns Established
- **TestContext builder pattern**: Fluent builder for test repos with commit, branch, merge, stash, conflict, unstaged change setup
- **vi.mock('@tauri-apps/api/core')**: Standard Tauri mock pattern for frontend component tests
- **Criterion + OnceLock**: Cached read-only fixtures for non-mutating benchmarks, BatchSize::SmallInput for mutating ops
- **data-testid attributes**: Standard pattern for E2E element selection without coupling to CSS/structure

### Key Lessons
1. **Requirements tracking needs a completeness check**: BENCH-03/BENCH-04 were noted as deferred but never picked back up — a "pending requirements" scan before milestone close would have caught this
2. **Scope decisions should happen before roadmap creation**: Dropping Phase 59 at discuss-time was the right call but the phase shouldn't have been planned without confirming Apple Developer account availability
3. **Testing infrastructure milestones are fast**: 16 plans in 2 days — deterministic work with clear pass/fail criteria executes quickly
4. **Frontend test mocking is fragile**: Several components required custom mocks for LazyStore, OffscreenCanvas, scrollTo — each mock is a maintenance burden but necessary for jsdom environment

---

## Milestone: v0.12 — Better Diffs

**Shipped:** 2026-03-30
**Phases:** 6 | **Plans:** 14 | **Timeline:** 3 days (2026-03-28 → 2026-03-30)

### What Was Built
- Configurable diff options: context lines, whitespace ignore, full file view — wired through all 3 diff commands
- Word-level (intra-line) diff highlighting via similar crate with performance guards
- Syntax highlighting via syntect with base16-ocean.dark theme, auto language detection, JS fallback for TS/Svelte
- DiffPanel decomposed into 5 focused components: DiffToolbar, DiffViewer, HunkView, FullFileView, SplitView
- Full file view: continuous document renderer with invisible character display
- Split (side-by-side) view: single-flow flex rows, phantom spacers, staging support
- Display options: word wrap, show invisibles, whitespace ignore — all persisted via LazyStore
- ContentMode/LayoutMode orthogonal toggles with icon buttons

### What Worked
- **Sweep-line boundary merge algorithm**: MergedSpan approach produces zero-gap coverage, single unified field for frontend — eliminated complexity of separate word_spans and syntax_tokens
- **Iterative visual verification**: Phase 64 checkpoint caught alignment issues, segmented control overdesign, and divider bloat — user feedback loops within execution are high-value
- **Single-flow flex rows**: Switching from two independent scroll panels to a single container with flex rows solved alignment perfectly — simpler architecture, no scroll sync needed
- **Icon toggles over segmented controls**: User-driven simplification saved horizontal toolbar space while improving consistency

### What Was Inefficient
- **syntect defaults lack TypeScript/Svelte**: Discovered at runtime that the most-used languages in the project weren't highlighted — should have tested all target extensions during Phase 61
- **ViewMode type redesign in Phase 64**: The 3-way ViewMode from Phase 62 had to be fully refactored into ContentMode + LayoutMode — Phase 62 could have anticipated 2D dispatch
- **Split view resizable divider was overengineered**: Built full drag-to-resize divider (Plan 02) then removed it (visual verification) — user said "we don't need the divider" immediately

### Patterns Established
- **fallback_extension() for syntect**: Map unsupported extensions (ts, tsx, svelte, vue, jsx) to supported ones (js) — extensible pattern for future languages
- **pairLines() utility**: Transforms flat DiffLine arrays into PairedRow arrays for split view — clean data transformation before rendering
- **Icon toggle pattern**: Single button with icon swap (no active highlight) for binary mode toggles — UnfoldVertical/FoldVertical, Columns2/Rows2

### Key Lessons
1. **Test all target file extensions for syntax highlighting**: Build a quick test covering every extension the project uses before shipping syntax support
2. **Visual verification checkpoints are essential for UI phases**: Caught 4 issues in Phase 64 that automated tests couldn't — alignment, toolbar UX, divider, gap spacing
3. **User feedback drives better UX than design specs**: UI-SPEC specified segmented controls and resizable divider; user immediately improved both to simpler toggle buttons and fixed 50/50 split
4. **2D mode dispatch should be designed upfront**: When two independent dimensions exist (content mode, layout mode), model them as orthogonal types from the start

---

## Milestone: v0.13 — Code Review Mode

**Shipped:** 2026-05-27
**Phases:** 10 | **Plans:** 37 | **Commits:** 290 | **Timeline:** 3 days (2026-05-25 → 2026-05-27)

### What Was Built
- Per-repo review session with atomic disk persistence (FNV-1a-keyed file, corrupt quarantine, newer-version refusal), canonical-path keying, schema v2 with stable uuid comment ids
- Commit selection: revwalk range seeding + graph hand-pick, mutex-serialized RMW across four commands
- Two anchor surfaces: diff line range with side discriminator (Phase 67) + full-file blob line range (Phase 68), both via pure capture-time adapters
- Comment management: list / inline edit / delete-with-confirm / jump-to-anchor with side-aware orphan classification (CommitGone / FileGone / LineOutOfRange)
- Pure Rust markdown renderer: per-source fencing, collision-safe fence length, trailing unresolvable section, never panics
- One-click Copy with awaited clipboard write and ✓ Copied affordance (no fire-and-forget)
- Toolbar Review toggle with active state, single-pane swap (panel ↔ jumped-to diff) in the center pane
- Cold-boot resume on ReviewPanel open + two-step inline End-review button
- Phase 74 tech-debt close: 66/WR-01..04, 70/CR-01, biome noNonNullAssertion ×3

### What Worked
- **Frozen keystone schema (Phase 65)**: Defining the anchor schema first — Rust DTOs + TS mirror with serde-shape test — eliminated migration cost across the next four phases. Schema v2 (Phase 69) bumped cleanly without breaking the gate
- **Pure capture-time adapters (Phase 67/68)**: TDD-built `buildDiffAnchor` and `buildFullFileAnchor` isolated coordinate translation from Tauri state — both tested without a Svelte runtime, both reusable through the shared `add_comment` writer
- **Shared dumb-writer commands**: `add_comment`/`save_draft_comment` over `mutate_session_rmw` let Phase 68 wire FullFile anchors with zero new IPC surface
- **Auto-start session at the comment chokepoint (Phase 67)**: Sidestepped the entire "no_session" UX problem by lazily starting at the only point that needed it
- **Pure git2 renderer with goldens (Phase 70)**: Renderer logic isolated from IPC made the multi-hunk overlap bug catchable by an isolated reproducer in Phase 74
- **Two-step inline End-review over confirm dialog (Phase 73)**: "Click again to confirm" reads faster than plugin-dialog ask, stays in the comments view, six TDD tests, zero backend changes
- **Wave-based parallel execution**: Phases 67 and 68 ran independently sharing the same writer contract
- **Carry-forward bundling (Phase 73)**: Bundling Bug 3 (cold-boot resume) with the End-review affordance into one phase produced both lifecycle endpoints together — addressed the advisor concern that auto-resume without End makes permanence worse

### What Was Inefficient
- **REQUIREMENTS.md OUT-01 stale checkbox**: The traceability checkbox was never flipped after Phase 71 — drove a "stale paperwork" finding in the audit and required a fix at close. Pattern: when a phase ships its last requirement, update the checkbox in the same commit
- **SUMMARY one_liner field hygiene**: Phase 72-04/74-01/74-04/74-05/74-06 SUMMARYs had review-process leakage in the `one_liner` field (e.g., "1. [Rule 3 - Blocking] Mock identity collision...") instead of an actual deliverable summary. `gsd-sdk milestone.complete` propagated these into MILESTONES.md verbatim, requiring manual cleanup
- **CR-01 multi-hunk leak shipped to audit**: `slice_diff` opposing-side filter was missing a per-hunk overlap check; tests covered single-hunk only. Caught by audit, closed in Phase 74. Better: hunk-positional tests should have shipped with Phase 70
- **6 phases shipped with `wave_0_complete: false` Nyquist**: Validation pipeline didn't finish on phases 65, 66, 68, 70, 71, 73 — these accumulated rather than getting closed in-phase
- **20+ human UAT items deferred**: The decision to defer the cross-repo session-changed isolation UAT (Phase 73) was correct, but the broader pattern of deferring UAT bundles to "needs a running app" left the verification paper trail systematically incomplete
- **Phase 74 directory not committed**: PLAN/RESEARCH/VALIDATION files for Phase 74 were untracked until milestone close — the safety commit caught it, but the phase should have committed its own working artifacts

### Patterns Established
- **Atomic per-repo JSON via tmp+sync_all+rename**: New persistence primitive for v0.13; FNV-1a filename hash mitigates path-traversal; corrupt file quarantines to `.corrupt` sidecar
- **Stable uuid comment id (schema v2)**: Multi-tab-safe edit/delete by id, not by list position
- **Side-aware orphan classifier**: `resolve_all` distinguishes CommitGone / FileGone / LineOutOfRange; Side::New reads the commit's own tree, Side::Old reads the parent's
- **Pure capture-time adapter**: TS function `(selection, context) → {anchor, cachedExcerpt}` decouples UI selection state from persistence schema
- **Shared dumb-writer commands**: `add_comment`/`save_draft_comment` accept arbitrary anchors; thin commands stay testable, fat logic lives in `mutate_session_rmw`
- **`session-changed` Tauri event with canonical-path filter**: Multi-tab coordination via broadcast; per-listener canonicalPath filter (added in Phase 74) prevents cross-repo reload storms
- **Pure git2-backed renderer with TDD goldens**: Markdown generation as a `fn render(session, repo) → String` with snapshot tests
- **`emit_session_changed` helper**: Replaces `let _ = app.emit(...)` patterns with logged-on-failure emit (Phase 74 cleanup) — pattern generalizable to other backend emits
- **Two-step inline destructive affordance**: Single button with "Click again to confirm" frozen label, success collapses via event round-trip, failure reverts + showToast — cheaper than plugin-dialog ask for in-view destructives
- **Three-way empty-state branching**: Specificity-first dispatch (cold → warm-no-commits → warm-with-commits-zero-comments) consumes session state rune; no new state shapes needed

### Key Lessons
1. **Lock the schema before the surface area expands**: Phase 65's keystone schema decision prevented a Phase 67/68/69/70 migration nightmare. When N+ later phases will read/write a shape, freezing it first pays back N-fold
2. **Audit retroactively catches what verification misses**: `/gsd:audit-milestone` produced the CR-01 finding that single-hunk tests never would have; build the audit into the milestone close flow, not optional
3. **SUMMARY one_liner is a published artifact**: It propagates into MILESTONES.md verbatim. Treat it as a milestone-facing deliverable, not a phase-local scratch field — review for leakage before close
4. **Update requirement checkboxes in the implementing commit**: Don't let traceability paperwork drift from code state — flip `[ ]`→`[x]` and update the traceability row Status in the same commit that closes the requirement
5. **Per-event canonical-path filtering is the v0.9 multi-tab tax**: Any new Tauri event that broadcasts per-repo state must filter by canonical path on the listener side — `session-changed` (Phase 65), `repo-changed` (v0.9) both had to learn this
6. **Capture excerpt at attach-time as canonical body**: Survives `repo-changed` re-fetch, `repoPath` change, and lets orphan rendering fall back cleanly. Re-resolve at render with cached fallback, never re-resolve at attach
7. **Two lifecycle endpoints, not one**: Auto-resume without explicit End makes permanence worse, not better. If a feature has implicit creation, it needs explicit destruction in the same surface
8. **Drop scope when the surface area exceeds the value**: OUT-02 (save-to-file) was dropped during Phase 71 context-gathering — preserved design ground in 71-CONTEXT.md if it ever comes back. Better to drop loudly than build resentfully

### Cost Observations
- Model mix: Predominantly Opus (planning/research) + Sonnet (execution); Haiku for trivial probes
- Sessions: ~30 across 3 days
- Notable: Phase 67/68 ran in parallel waves — independent capture surfaces over a shared writer contract is the cleanest parallelization pattern this project has produced

---

## Milestone: v0.14 — Commit Message UX

**Shipped:** 2026-05-29
**Phases:** 2 | **Plans:** 6 | **Timeline:** 2 days (2026-05-28 → 2026-05-29)

### What Was Built
- Host-owned Svelte 5 `MessageEditor` modal: `open(default) → Promise<string|null>`, uniform null-resolve on Esc/Cancel/backdrop/empty (Phase 75)
- Two-step backend pattern (D-01, direct — `editor.rs` GIT_EDITOR script built in 75 but intentionally unused): `merge_branch_begin` (`git merge --ff-only` probe → `--no-commit` → `MergeBeginResult` tagged enum) and `revert_commit_begin` (`git revert --no-commit`), each returning git's verbatim `.git/MERGE_MSG` default and emitting `repo-changed` on every outcome
- `--cleanup=strip` finishes that clear `MERGE_HEAD`/`REVERT_HEAD` and drop the `# Conflicts:` block; new `revert_abort` recovery command (MSG-06 was unsatisfiable for revert without it)
- Single RepoView-hosted modal with reactive per-op title threaded to every trigger site; StagingPanel inline form replaced; OperationBanner gained Revert Continue/Abort
- All three `GIT_EDITOR=true`/`--no-edit` bypasses removed

### What Worked
- **Research scoped to the open questions with the mechanism locked**: the phase-researcher was fenced to OQ-1..4 with D-01 declared final, so it spent its budget on scratch-repo verification instead of re-litigating the decided approach — and surfaced 5 load-bearing CONTEXT corrections (missing `revert_abort`, `--cleanup=strip`, dead trigger site, emit-on-begin, ff-probe) *before* any code was written
- **Sequential single-plan waves on the main tree**: the strict 76-01→04 dependency chain had zero parallelism to gain, so skipping worktree isolation avoided the entire merge/cleanup machinery for no cost
- **In-app UAT caught what tests structurally cannot**: the modal-centering bug (Tailwind v4 preflight wiping `dialog:modal { margin: auto }`) passed 584 vitest tests and still rendered under the window controls — only a real screenshot found it

### What Was Inefficient
- **A UI component shipped visually broken behind green tests**: the Phase 75 modal was never rendered in the app (no live trigger until Phase 76), so its centering bug sat latent through a "complete" phase. jsdom has no layout engine — tests-green ≠ looks-right
- **SUMMARY one_liner leakage recurred** (v0.13 Key Lesson 3, not internalized): a `1. [Rule 3 - Blocking] …` review-deviation note landed in the 76-03 SUMMARY one_liner and propagated verbatim into MILESTONES.md again, requiring the same manual cleanup as last milestone
- **The commit helper auto-created a `phase-76-plan` branch despite `branching_strategy: none`**: surprise branch detected via reflog mid-session; harmless (clean ff back to main) but unexpected
- **The open-artifact audit flagged 22 items, all noise**: 20 stale quick-task `status` markers (the quick workflow writes `done`/nothing but `audit-open` only treats `complete` as closed) + 1 resolved-but-stale CONTEXT heading + 1 carried-forward debug deferral — none real v0.14 gaps

### Patterns Established
- **Two-step begin/finish IPC with emit-on-every-outcome**: when a "begin" mutates the repo before a modal opens, its wrapper must emit `repo-changed` on *every* arm (incl. cancel) or it leaves an invisible in-progress trap
- **Reactive-title single modal host**: one `<MessageEditor bind:this>` in the parent, `$state` title set before `await open()`, callback threaded to N trigger sites (mirrors `onopenrebaseeditor`) — avoids N modal instances
- **`--cleanup=strip` for git-faithful commit bodies**: matches the terminal editor's stripping of `#`-comment lines from `.git/MERGE_MSG`

### Key Lessons
1. **A "frozen"/"done" UI primitive still needs one real visual render before it's trusted** — add an in-app screenshot to the verify loop for any user-visible component; green unit tests don't cover layout
2. **Reconcile status-marker conventions, don't just re-defer them**: the quick-task audit noise had accumulated across milestones because the marker (`done`) never matched the audit's predicate (`complete`); fixing the *data* (truthful `status: complete`) cleared it — the durable tool fix lives in vendored, gitignored code and isn't ours to fork
3. **Research before planning when CONTEXT predates research**: a confident-but-pre-research CONTEXT under-scoped the phase in 5 ways; the cheap fix was fencing the researcher to the open questions, not trusting the CONTEXT
4. **SUMMARY one_liner is still a published artifact** (third milestone this has bitten): treat the field as milestone-facing copy and scrub review-process leakage before close

### Cost Observations
- Model mix: Opus for plan/research/execute orchestration + executors, Sonnet for plan-checking
- Notable: a full plan→execute→verify→milestone-close cycle run end-to-end in one session; the biggest single time sink was the latent UI bug that automated gates couldn't see

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Days | Phases | Plans | Key Change |
|-----------|------|--------|-------|------------|
| v0.1 | 7 | 6 | 27 | First milestone — established all patterns |
| v0.2 | 2 | 4 | 9 | Focused visual milestone — gap closure plans for UAT findings |
| v0.3 | 3 | 4 | 14 | Largest plan count — subprocess pattern for remote/cherry-pick/revert |
| v0.4 | 1 | 3 | 5 | Intermediate architecture — per-row viewBox SVG (superseded by v0.5) |
| v0.5 | 2 | 7 | 12 | Pure function pipeline — decision gate, TDD, SVG overlay architecture |
| v0.6 | 2 | 6 | 16 | UI polish milestone — established patterns enabled fastest per-plan pace yet |
| v0.7 | 2 | 5 | 8 | Feature milestone — TDD backend + clean UI separation, zero gap-closure requirements |
| v0.8 | 4 | 7 | 19 | Most complex milestone — merge editor, interactive rebase, file-based IPC, audit-driven gap closure |
| v0.9 | 3 | 6 | 13 | Fastest per-plan pace — multi-tab + tree view, parallel execution, zero gap closures needed |
| v0.10 | 2 | 3 | 4 | Smallest milestone — CI/CD infrastructure, zero gap closures, deterministic YAML work |
| v0.11 | 2 | 6 | 16 | Testing infrastructure — GOOS harness, 520+ tests, benchmarks, E2E, coverage reporting |
| v0.12 | 3 | 6 | 14 | Diff overhaul — syntax highlighting, word diff, split view, display options, iterative UI refinement |
| v0.13 | 3 | 10 | 37 | Largest plan count to date — keystone schema first, then 4 parallelizable feature phases (66/67/68/69), then render + clipboard + UX integration + lifecycle endpoints; Phase 74 tech-debt close |

### Top Lessons (Verified Across Milestones)

1. **Gap closure plans are a recurring pattern**: All 8 milestones needed additional plans for UAT findings — budget 1-2 per phase
2. **ROADMAP checkboxes get stale**: All 8 milestones had this issue — should automate or remove
3. **Test suite protects against regressions**: Tests caught zero regressions across all milestones — TDD investment pays dividends
4. **Visual rendering is the riskiest area**: v0.1 needed 3 graph iterations, v0.2 needed 3 gap closures for connectors, v0.3 had a full plan redo (11-02), v0.5 had constant confusion, v0.8 merge editor needed 7 plans — visual features need more upfront design or spike plans
5. **Decision gates prevent wasted work**: v0.4's architecture was superseded in 1 day; v0.5's Phase 20 decision gate validated the approach before committing — gates should be standard for architecture changes
6. **Pure function pipelines scale**: v0.5's pipeline (data → paths → visibility → rendering) was independently testable and composable — prefer this over stateful approaches
7. **TODO.md review before milestone close is high-value**: v0.6 found 2 real bugs in pre-archive review — make this a standard step
8. **Backend-first phases enable clean UI phases**: v0.7 and v0.8 both demonstrated clean backend→UI phase separation — established pattern across all feature milestones
9. **Milestone audits catch integration gaps**: v0.8 audit found REB-06 cross-phase integration gap that phase-level verification missed — audits should be standard before milestone close
10. **Nyquist validation consistently skipped**: 8 milestones and all phases have draft-only VALIDATION.md — either enforce it or remove the requirement
