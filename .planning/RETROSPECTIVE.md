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

## Cross-Milestone Trends

### Process Evolution

| Milestone | Days | Phases | Plans | Key Change |
|-----------|------|--------|-------|------------|
| v0.1 | 7 | 6 | 27 | First milestone — established all patterns |
| v0.2 | 2 | 4 | 9 | Focused visual milestone — gap closure plans for UAT findings |
| v0.3 | 3 | 4 | 14 | Largest plan count — subprocess pattern for remote/cherry-pick/revert |

### Top Lessons (Verified Across Milestones)

1. **Gap closure plans are a recurring pattern**: All 3 milestones needed additional plans for UAT findings — budget 1-2 per phase
2. **ROADMAP checkboxes get stale**: All 3 milestones had this issue — should automate or remove
3. **Test suite protects against regressions**: Rust tests caught zero regressions across all milestones
4. **Visual rendering is the riskiest area**: v0.1 needed 3 graph iterations, v0.2 needed 3 gap closures for connectors, v0.3 had a full plan redo (11-02) — visual features need more upfront design or spike plans
