# Phase 7: Lane Algorithm Hardening - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

The Rust lane algorithm produces correct, complete data for every graph topology -- no ghost lanes, no column explosions, consistent widths. This phase hardens the existing algorithm in `src-tauri/src/git/graph.rs` to satisfy ALGO-01, ALGO-02, ALGO-03, and LANE-05. No rendering changes -- only algorithm correctness and data completeness.

</domain>

<decisions>
## Implementation Decisions

### Lane Packing Strategy
- Leftmost available column reuse -- always grab the first free slot (most compact, GitKraken behavior)
- Immediate reuse -- freed columns available on the very next row, no gap/delay
- Column 0 reserved for HEAD's first-parent chain (existing behavior, keep it)
- Octopus merges: each parent gets its own column, no collapsing -- graph widens temporarily then narrows as freed lanes are reclaimed

### Graph Width Consistency
- Global max across entire repo -- compute max active lanes across ALL commits, every row SVG uses that width
- Algorithm outputs `max_columns` as a top-level field alongside commit rows (single source of truth for frontend)
- No hard cap on maximum columns -- let graph grow as wide as needed
- All active lanes emit pass-through edges on every row (Phase 8 needs this for continuous vertical rails)

### Color Data Model
- Add `color_index` per branch in this phase (not deferred to Phase 8) -- monotonically increasing counter, HEAD gets 0
- Each `GraphEdge` includes `color_index` of its source branch
- Merge edges use the source (merged-in) branch color
- Fork edges use the new (forking) branch color
- Pass-through edges use their own branch's color_index
- Deterministic: same repo always produces same color assignments

### Claude's Discretion
- Internal data structures for lane tracking (active_lanes, pending_parents redesign)
- Test fixture design for complex topologies (octopus merges, criss-cross merges, long-running branches)
- Algorithm optimization approach (single-pass vs multi-pass)
- Edge case handling for orphan commits, shallow clones, grafts

</decisions>

<specifics>
## Specific Ideas

- GitKraken is the visual reference -- compact packing, HEAD leftmost, immediate lane reuse
- Merge edge colored as the incoming branch, fork edge colored as the outgoing branch (symmetric model)
- `max_columns` field eliminates frontend scanning -- backend is the single source of truth for graph width

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `graph.rs::walk_commits()`: Existing single-pass algorithm with `active_lanes: Vec<Option<Oid>>` and `pending_parents: HashMap<Oid, usize>` -- needs hardening, not rewrite
- `types.rs::GraphEdge`: Already has `from_column`, `to_column`, `edge_type`, `color_index` fields
- `types.rs::GraphCommit`: Has `column`, `edges`, `is_merge` -- needs `color_index` field added
- 7 existing unit tests in `graph.rs` covering linear, merge, fork, and pagination topologies
- `make_test_repo()` and `make_large_test_repo()` fixtures using `tempfile::TempDir`

### Established Patterns
- Inner-fn pattern: `walk_commits()` is the testable pure function, called by Tauri command wrapper
- HEAD chain pre-computation: `head_chain: HashSet<Oid>` computed upfront, column 0 reserved via `pending_parents`
- Pass-through edges: already emitted for all active lanes on each row

### Integration Points
- `commands/repo.rs`: Calls `walk_commits()` on repo open, caches result in `CommitCache`
- `commands/history.rs`: Slices cached graph for paginated delivery -- needs to also return `max_columns`
- `state.rs::CommitCache`: Stores `Vec<GraphCommit>` per repo -- may need to store `max_columns` alongside
- `LaneSvg.svelte`: Currently derives width from `(commit.column + 1) * laneWidth` -- will use `max_columns * laneWidth`
- `lib/types.ts`: TypeScript mirrors need `color_index` on `GraphCommit` and updated `GraphEdge`

</code_context>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope

</deferred>

---

*Phase: 07-lane-algorithm-hardening*
*Context gathered: 2026-03-09*
