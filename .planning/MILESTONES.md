# Milestones

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

