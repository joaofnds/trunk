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

## Cross-Milestone Trends

### Process Evolution

| Milestone | Days | Phases | Plans | Key Change |
|-----------|------|--------|-------|------------|
| v0.1 | 7 | 6 | 27 | First milestone — established all patterns |

### Top Lessons (Verified Across Milestones)

1. (Single milestone so far — will populate after v0.2)
