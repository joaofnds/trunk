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

## Cross-Milestone Trends

### Process Evolution

| Milestone | Days | Phases | Plans | Key Change |
|-----------|------|--------|-------|------------|
| v0.1 | 7 | 6 | 27 | First milestone — established all patterns |
| v0.2 | 2 | 4 | 9 | Focused visual milestone — gap closure plans for UAT findings |

### Top Lessons (Verified Across Milestones)

1. **Gap closure plans are a recurring pattern**: Both milestones needed additional plans to address UAT findings — budget for 1-2 gap closure plans per phase
2. **ROADMAP checkboxes get stale**: Both milestones had plan checkboxes out of sync with reality — consider automating
3. **Test suite protects against regressions**: 50+ Rust tests caught zero regressions across both milestones — investment in TDD pays off
