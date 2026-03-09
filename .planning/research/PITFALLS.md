# Domain Pitfalls: Commit Graph Lane Rendering

**Domain:** Per-row inline SVG commit graph with virtual scrolling (Tauri 2 + Svelte 5 + Rust)
**Researched:** 2026-03-09
**Context:** v0.1 shipped with lane rendering stripped out due to visual bugs. This milestone is the second attempt.

---

## Critical Pitfalls

Mistakes that cause visual breakage visible to every user, or that require architectural rework to fix.

---

### Pitfall 1: Sub-Pixel Gaps Between Adjacent Row SVGs

**What goes wrong:** Each commit row renders its own `<svg>` element with `height="26"`. Vertical lane lines must appear continuous across rows -- a line exiting the bottom of row N must seamlessly enter the top of row N+1. But browsers anti-alias the edges of SVG elements, and floating-point coordinate rounding creates hairline gaps (0.5-1px) of background color visible between rows. These gaps are especially noticeable on high-DPI displays and at non-100% zoom levels.

**Why it happens:** SVG elements are inline-replaced elements. Even when dimensions are integer pixels, the browser's compositing pipeline may position elements at fractional pixel boundaries due to: (a) the virtual list's `translateY()` positioning, (b) zoom-induced coordinate scaling, (c) font-size-based inline spacing inherited by SVGs. The `@humanspeak/svelte-virtual-list` positions items using `transform: translateY(Npx)` on a wrapper, and `Math.round()` is applied -- but zoom can still produce fractional effective positions at the individual row level.

**Consequences:**
- Horizontal dashed lines appear between every row, turning a smooth vertical rail into a dotted line
- Looks broken, especially at common zoom levels (110%, 125%)
- This was likely the primary visual bug that caused v0.1 lane rendering to be stripped

**Prevention:**
- **Overlap lines by 0.5-1px in each direction.** Draw vertical lane lines from `y=-0.5` to `y=rowHeight+0.5` (i.e., 27px tall in a 26px row). This ensures the anti-aliased top edge of row N overlaps with the anti-aliased bottom edge of row N-1. Set `overflow: visible` on the per-row SVG so the overflow pixels render.
- **Use `display: block`** on all SVG elements. Inline SVGs inherit descender spacing from the parent font, adding ~3px gaps. Alternatively, use `vertical-align: bottom` or ensure the parent uses flexbox (which the current `CommitRow.svelte` already does via `flex items-center`).
- **Use even stroke widths** (2px, not 1px) for lane lines. Odd stroke widths on integer coordinates produce half-pixel rendering that varies across browsers.
- **Test at 100%, 110%, 125%, 150%, 175%, 200% zoom.** Sub-pixel gaps often appear only at specific zoom levels.
- Do NOT use `shape-rendering: crispEdges` -- it kills anti-aliasing on bezier curves, making them jagged.

**Detection:**
- Visible dashed lines where there should be continuous vertical rails
- Gaps that appear or disappear as you scroll (rows at different translateY offsets hit different pixel boundaries)
- Gaps visible at 125% zoom but not at 100%

**Specific to this codebase:** The current `LaneSvg.svelte` sets `style="overflow: visible"` on the SVG -- good. But the `@humanspeak/svelte-virtual-list` has `overflow: hidden` on its outer container (`.virtual-list-outer`). SVG overflow-visible content will be clipped by this parent. The list wrapper's overflow must remain `hidden`/`scroll` for virtualization to work, so the overlap approach must be constrained to the 0.5px range -- enough to cover anti-aliasing seams but not so much that clipping cuts off visible content.

**Phase:** Address in the first rendering phase. This is the single most likely repeat failure from v0.1.

---

### Pitfall 2: Bezier Curves Misaligned at Row Boundaries

**What goes wrong:** A merge or fork edge must draw a curve from the commit dot's column to a different column. Because each row is an independent SVG, the curve must be split across two (or more) rows. Row N draws the top half of the curve; row N+1 draws the bottom half. If the control points are not mathematically mirrored, the two halves do not form a smooth continuous curve -- you get a visible kink, angle break, or offset at the row boundary.

**Why it happens:** Developers draw curves independently in each row using the edge data (from_column, to_column, edge_type) without coordinating the exact mathematical split point. A cubic bezier `C cx1,cy1 cx2,cy2 x,y` requires both halves to share the same tangent angle and position at the boundary point.

**Consequences:**
- Merge/fork lines have visible kinks at every row boundary
- Curves look like zigzag steps instead of smooth arcs
- Gets worse with larger column distances (e.g., column 0 to column 5)

**Prevention:**
- **Define the curve as a single logical bezier spanning 2 rows, then clip to each row's portion.** The full curve goes from `(from_col * 12 + 6, 13)` [center of source row] to `(to_col * 12 + 6, 13)` [center of destination row, one row below = y offset 26+13=39 from source row top]. In the source row SVG, draw this full curve but it naturally clips at `y=26` (the row bottom). In the destination row SVG, draw the same curve but with y-coordinates offset by -26 (shifting the curve up by one row height), and it naturally clips at `y=0`. Both halves share identical geometry.
- **Use quadratic beziers (Q) instead of cubic (C) for single-row-span curves.** Quadratic beziers have one control point and are inherently symmetric, reducing the degrees of freedom that can go wrong.
- **Pre-compute curve segments in Rust** and include the exact SVG path string (or control point coordinates) in the edge data sent to the frontend. This ensures both row-halves use the same math, eliminating frontend rounding divergence.
- **Never draw a curve that spans more than 2 rows.** If a lane must shift columns across 3+ rows (rare but possible with octopus merges), break it into a vertical segment + a 2-row curve.

**Detection:**
- Visible kinks or "V" shapes at row boundaries on merge/fork edges
- Curves look fine with adjacent columns (column 0 to 1) but break with distant columns (column 0 to 4)
- Zooming in on row boundaries reveals the discontinuity

**Phase:** Address immediately after straight lines work. Curves are the hardest rendering problem in per-row SVG.

---

### Pitfall 3: Virtual Scroll Overflow Clipping Eats SVG Overflow

**What goes wrong:** Per-row SVGs use `overflow: visible` so that lane lines can extend slightly beyond the row boundary (the 0.5px overlap from Pitfall 1, plus curve segments that bulge outside the row). But the virtual list container has `overflow: hidden` on its outer wrapper and `overflow-y: scroll` on the viewport. Any SVG content that extends beyond the row's bounding box gets clipped by these parent containers.

**Why it happens:** Virtual scroll libraries must clip their container to create the scrolling viewport. This is fundamental to how virtual scrolling works. But it conflicts with the per-row SVG approach where visual continuity requires elements to bleed across row boundaries.

**Consequences:**
- The 0.5px overlap fix from Pitfall 1 gets clipped, restoring the gap
- Bezier curves that bulge beyond the row height get cut off
- The first and last visible rows have their top/bottom edges clipped

**Prevention:**
- **Keep overflow amounts tiny (0.5px max).** The virtual list clips at the viewport level, not at each item level. Items within the viewport are not individually clipped -- they are just absolutely positioned within a scrollable container. So SVG overflow from one row CAN overlap into an adjacent row's space, as long as both rows are in the DOM. The only clipping happens at the viewport edges (top/bottom of the scroll container).
- **Verify this with the actual `@humanspeak/svelte-virtual-list` DOM structure.** The library positions items using `translateY` on a wrapper div. Individual items are NOT `overflow: hidden` -- they flow naturally within the wrapper. This means inter-row SVG overlap WILL work for interior rows. Only the first and last visible rows risk clipping at the viewport boundary -- which is acceptable since those rows are partially off-screen anyway.
- **Do not add `overflow: hidden` to CommitRow or its parent div.** The current `CommitRow.svelte` does not have overflow hidden -- preserve this.
- **Test with buffer/overscan rows.** The virtual list renders extra rows above and below the viewport. These buffer rows ensure that SVG overlap from the first/last visible rows has adjacent rows to blend with.

**Detection:**
- Lane lines cut off sharply at the top/bottom of the visible scroll area
- Curves appear clipped on one side at the scroll boundary
- Interior rows look fine but edge rows have truncated lines

**Phase:** Validate early when integrating SVG rendering with the virtual list. A 5-minute DOM inspection saves hours of debugging.

---

### Pitfall 4: Lane Algorithm Produces Ghost Lanes After Branch Merge

**What goes wrong:** When a branch merges, its lane column should be freed for reuse by subsequent branches. If the lane algorithm does not properly clear the `active_lanes` slot after a merge, the column remains "occupied" indefinitely. Pass-through `Straight` edges continue to be emitted for rows below the merge, drawing a vertical line that extends below the merge commit into empty space -- a "ghost lane" that connects to nothing.

**Why it happens:** The current `graph.rs` algorithm tracks `active_lanes[col] = Some(oid)`. When a commit is processed, its slot is cleared (`active_lanes[col] = None`). But for first-parent continuation (`idx == 0`), the slot is immediately re-occupied with the parent OID. The bug occurs in merge scenarios: when the merge commit's first-parent is already claimed at a different column (the `existing_col` branch in the code), the current column should stay `None`. The current code has a comment "If different column, current col stays None (lane terminates here)" -- this is correct logic but fragile. If any code path accidentally re-occupies the slot, ghost lanes appear.

**Consequences:**
- Vertical lines extend below merge commits into empty space
- Lane columns accumulate over time, pushing the graph wider and wider
- Graph looks increasingly cluttered as you scroll down through history

**Prevention:**
- **Add a dedicated test: after a merge commit, verify that the merged branch's column has NO Straight edge in the next row.** The existing test `merge_commit_edges` checks that merge edges exist but does not verify that the merged lane terminates.
- **Add a "max active lanes" assertion in tests.** For a repo with 2 branches that merge, the max active lane count should decrease back to 1 after the merge.
- **Trace the `active_lanes` vector state in debug mode.** Add a `#[cfg(test)]` debug print that logs `active_lanes` after each commit is processed. Ghost lanes are immediately visible as `Some(oid)` entries that persist after the merge.

**Detection:**
- Vertical lines extending below merge commits that connect to nothing
- Graph width keeps growing as you scroll down even though branches are merging
- The lane count at the bottom of the graph (near the root commit) should be 1 for a typical repo -- if it is >1, ghost lanes exist

**Specific to this codebase:** The algorithm in `graph.rs` lines 94-97 clears the slot, and lines 103-126 handle first-parent continuation. The risk is specifically in the `if let Some(&existing_col) = pending_parents.get(&parent_oid)` branch at line 104 -- when `existing_col != col`, the current `col` slot stays None (correct). Verify this holds for all edge cases including when the same parent is referenced by multiple merge children.

**Phase:** Address in lane algorithm hardening phase, before frontend rendering begins. Ghost lanes are algorithm bugs, not rendering bugs.

---

### Pitfall 5: Octopus Merge Lane Explosion

**What goes wrong:** An octopus merge has 3+ parents. Each secondary parent needs its own lane column. If 5 branches merge simultaneously, the algorithm allocates 5 new columns for the inbound merge edges. These columns may not be reclaimed immediately because the parent commits below may also have their own branch structure. The graph suddenly becomes very wide at the octopus merge row and may never narrow again.

**Why it happens:** The current algorithm (line 141-157) assigns secondary parents to available columns without any awareness of how many parents exist. For an octopus merge with N parents, it allocates N-1 additional columns. The Linux kernel has octopus merges with 66 parents -- this would create a 66-column-wide graph.

**Consequences:**
- Graph becomes extremely wide, breaking the layout
- SVG width per row balloons (at 12px per lane, 66 lanes = 792px just for the graph pane)
- Lane colors wrap around the 8-color palette many times, making the graph unreadable

**Prevention:**
- **Cap displayed parent count** in octopus merges. For octopus merges with >4 parents, show only the first 3-4 merge edges and add a visual indicator (e.g., "+12 more branches merged"). The full parent list is still in the data; only the rendering is capped.
- **Aggressive lane reclamation.** After processing a merge commit, immediately scan `active_lanes` and release any column where the tracked OID is one of the merge's secondary parents AND that parent is also claimed at its own column. The secondary parent lane should terminate at the merge commit.
- **Track `max_column` per page.** The SVG width calculation (`(commit.column + 1) * laneWidth`) only considers the commit's own column, not passing-through lanes. The SVG must be wide enough to render ALL edges, not just the commit dot. Add a `max_column` field to GraphCommit that represents the rightmost column of any edge in that row.
- **Test with octopus merge fixtures.** Create a test repo with a 5-parent octopus merge and verify the graph narrows back after the merge.

**Detection:**
- Graph suddenly widens dramatically at certain commits
- Lane colors become meaningless (same color appears 3+ times in one row)
- Horizontal scroll required to see the full graph

**Specific to this codebase:** The `svgWidth` calculation in `LaneSvg.svelte` line 16 (`(commit.column + 1) * laneWidth`) does not account for edges that extend to columns beyond the commit's own column. A merge commit at column 0 with a merge edge to column 5 would have `svgWidth = 12`, cutting off the edge. This MUST be fixed to use the max column of all edges in the row.

**Phase:** Lane algorithm hardening phase. Add octopus merge test fixtures before implementing rendering.

---

### Pitfall 6: SVG Width Inconsistency Causes Jagged Left Edge on Commit Messages

**What goes wrong:** Each row's SVG is a different width because it is sized to `(commit.column + 1) * laneWidth`. Row 1 has a commit at column 3 (SVG width = 48px), row 2 has a commit at column 0 (SVG width = 12px). The commit message text following the SVG starts at a different horizontal position in each row, creating a jagged left edge for the message column. This makes the text unreadable and the whole graph look broken.

**Why it happens:** The SVG width is determined per-row by the commit's lane position. But a properly rendered graph needs the SVG pane to be a consistent width across all visible rows so that: (a) pass-through lanes at columns beyond the commit's own column are drawn, and (b) the text column starts at a uniform x-position.

**Consequences:**
- Commit messages are horizontally misaligned across rows
- Pass-through lanes at high columns are not drawn (SVG is too narrow)
- The layout looks broken even if the lane algorithm is perfect

**Prevention:**
- **Use a fixed graph pane width based on the maximum column across all visible rows (or the entire page).** The Rust algorithm should return `max_active_lanes: usize` alongside the commit list. The frontend sets graph SVG width to `max_active_lanes * laneWidth` for ALL rows.
- **Alternatively, use a `<div>` wrapper with a fixed width** around the SVG pane. The SVG inside can still have `overflow: visible`, and the fixed-width div ensures consistent text alignment.
- **Include `max_column` in the page metadata** returned from the Rust `get_commit_graph` command. This is a single integer added to the response, not per-commit.

**Detection:**
- Commit messages start at different horizontal positions in adjacent rows
- Visually obvious -- just look at the commit list

**Specific to this codebase:** The current `CommitRow.svelte` layout is `[RefPill 120px fixed] [LaneSvg flex-shrink-0] [Message flex-1]`. Because `LaneSvg` width varies per row, the message div's left edge varies. Fix by making the SVG wrapper a fixed width.

**Phase:** First rendering phase. Must be solved before the graph looks presentable.

---

## Moderate Pitfalls

---

### Pitfall 7: Color Index Drift -- Same Branch Gets Different Colors After Pagination

**What goes wrong:** The Rust lane algorithm assigns `color_index` based on column position (`color_index: other_col` for pass-through edges). When the user scrolls down and loads a new page of commits, the algorithm runs over ALL OIDs from the beginning (the current code does this correctly -- it iterates all `oids` then slices to `page_oids`). But if the algorithm changes (e.g., to an incremental approach for performance), the lane assignment for commits deep in history might differ between pages, causing the same branch to change color at the pagination boundary.

**Why it happens:** Lane colors are derived from column indices, and column assignment depends on the full topology above the current row. Any optimization that avoids processing the full history risks inconsistent column assignments.

**Consequences:**
- A branch changes color as you scroll past a pagination boundary
- The graph looks like two different branches where there is actually one

**Prevention:**
- **Keep the current full-walk approach.** The existing algorithm walks all OIDs for lane continuity (graph.rs line 59-185) then slices the page. This is correct and should not be "optimized" into incremental computation without careful thought.
- **If performance requires incremental computation**, serialize the `active_lanes` and `pending_parents` state at the end of page N and restore it at the start of page N+1. This is a state-machine checkpoint, not a re-computation.
- **Color should be tied to column index, not to any per-branch identifier.** The current approach (`color_index: other_col`) is correct for this. Columns are stable across pages because the full walk ensures consistency.
- **Test: load page 1 and page 2 of a repo with 3 branches. Verify that the color of each branch is the same at the page boundary.**

**Detection:**
- Branch color changes mid-graph when scrolling
- A branch at column 2 is blue in one section and green in another

**Phase:** Pagination integration testing phase.

---

### Pitfall 8: Re-render Storms from Reactive SVG Width Recalculation

**What goes wrong:** If the graph pane width is a Svelte `$derived` value based on `max_column` (which is correct per Pitfall 6), and `max_column` changes when new commits load (e.g., a deep branch appears in page 2 that pushes `max_column` from 3 to 7), ALL visible row SVGs re-render because their width prop changed. With 40 visible rows, each containing an SVG with potentially 5-10 path elements, this is 200-400 DOM mutations in a single frame.

**Why it happens:** Svelte 5's fine-grained reactivity means changing a prop on 40 components triggers 40 independent DOM updates. SVG width changes force browser relayout of the entire list.

**Consequences:**
- Visible jank/stutter when loading more commits (pagination)
- Scroll performance degrades as the graph gets wider

**Prevention:**
- **Set graph pane width via CSS custom property, not per-component prop.** Define `--graph-width` on the CommitGraph container. Each SVG reads `width: var(--graph-width)`. Changing the CSS variable triggers a single style recalculation, not 40 component updates.
- **Debounce max_column changes.** When loading a new page, compute the new max_column but only update the CSS variable after the new data is fully rendered. This prevents mid-render width thrashing.
- **Over-allocate width.** Start with `max_column` rounded up to the next multiple of 4. This reduces how often the width actually changes. Going from 3 to 4 lanes causes a width change, but going from 3 to 4 within an allocation of 4 does not.

**Detection:**
- Browser DevTools Performance tab shows "Recalculate Style" spike when new commits load
- Visible horizontal jump/shift when scrolling to load more commits
- `console.log` in LaneSvg shows all 40 instances re-rendering on page load

**Phase:** Performance optimization phase, after basic rendering works.

---

### Pitfall 9: Lane Collision -- Two Commits Assigned the Same Column

**What goes wrong:** The lane algorithm assigns two concurrent (both active, neither is an ancestor of the other) commits to the same column. Their vertical lane lines overlap, and merge/fork edges become ambiguous -- you cannot tell which line connects to which commit.

**Why it happens:** The algorithm reuses freed columns (`active_lanes.iter().position(|s| s.is_none())`). If the column was freed prematurely (ghost lane fix was too aggressive) or the algorithm does not correctly track that a parent is still pending on that column, a new branch tip can be assigned the same column as an existing active branch.

**Consequences:**
- Two branch lines overlap, appearing as one
- Merge/fork edges appear to connect to the wrong branch
- The graph is technically drawn but visually misleading

**Prevention:**
- **The column assignment for new chains (line 70-76) must check ALL occupied slots**, not just `active_lanes`. The `pending_parents` map also indicates columns that are "reserved" for future use. A column is only truly free if `active_lanes[col].is_none()` AND no entry in `pending_parents` maps to that column.
- **Add a collision detection assertion in tests:** for each row, verify that no two concurrent branches share the same column. "Concurrent" means: neither is an ancestor of the other.
- **Visualize active_lanes state in a test log** for complex topologies.

**Specific to this codebase:** The current algorithm at line 64-77 checks `pending_parents` first (for pre-reserved columns), then falls back to finding a free slot in `active_lanes`. The `pending_parents.insert` on line 131 reserves the column. This is mostly correct, but the secondary parent path (line 145) searches `active_lanes` for a free slot WITHOUT checking if that slot is pending for another parent. A collision can occur if parent A is in `pending_parents` at column 3 but `active_lanes[3]` is `None` (because A hasn't been processed yet) -- secondary parent B could be assigned column 3.

**Detection:**
- Two branch lines visually merge into one at some point in the graph
- Graph has fewer visible branches than expected

**Phase:** Lane algorithm hardening. Add collision detection test before rendering work begins.

---

### Pitfall 10: Straight Pass-Through Edges Not Drawn for All Active Lanes

**What goes wrong:** Each row must draw vertical pass-through lines for every active lane that passes through that row, not just the lane belonging to the current commit. If the SVG only draws the commit dot and its own edges (merge/fork), other active branches appear to have gaps at this row -- their continuous vertical lines are interrupted.

**Why it happens:** The Rust algorithm emits `Straight` edges for pass-through lanes (graph.rs lines 80-92), which is correct. But the frontend SVG renderer might only draw edges where `from_column != to_column` (thinking only merge/fork edges matter), or might skip drawing a straight line when it sees an edge with `from_column == to_column` because it thinks "the dot already handles that column."

**Consequences:**
- Vertical lane lines have holes at every commit row that belongs to a different branch
- The graph looks correct only where commits are dense (every lane has its own commit) and broken where commits are sparse

**Prevention:**
- **The SVG renderer must draw EVERY edge returned by the Rust algorithm**, including Straight edges where `from_column == to_column` and `from_column != commit.column`. These are the pass-through lanes.
- **Draw pass-through lanes BEFORE the commit dot** (lower z-order). The dot should be on top of any lines.
- **Verify in tests:** for a repo with 2 active branches (main at column 0, feature at column 1), when processing a commit on main (column 0), there should be a Straight edge at column 1 (the feature branch passing through). The existing test suite checks for edges on merge commits but not for pass-through edges on non-merge commits.

**Detection:**
- Vertical lane lines have gaps/holes where commits on other branches are positioned
- Only the commit dot's own column has a continuous line

**Specific to this codebase:** The algorithm at lines 80-92 emits these correctly. The risk is purely in the frontend renderer not drawing them. The current `LaneSvg.svelte` only draws a commit dot -- it does not draw any edges at all. This is by design (v0.1 stripped lanes), but it means ALL edge rendering is new code that must handle this case.

**Phase:** First rendering phase. This is the most fundamental rendering requirement.

---

### Pitfall 11: Bezier Curves Jagged at Low Stroke Widths

**What goes wrong:** SVG bezier curves rendered with `stroke-width: 1` or `stroke-width: 1.5` appear jagged or blurry on standard (non-Retina) displays. The anti-aliasing makes thin curves appear fuzzy. On Retina displays they look fine because there are enough physical pixels to render the anti-aliased edge cleanly. This creates "works on my machine" situations for developers with Retina MacBooks.

**Why it happens:** SVG anti-aliasing works by blending the stroke color with the background at sub-pixel boundaries. With a 1px stroke, the blend zone is a significant proportion of the total stroke width, making the line appear semi-transparent or fuzzy.

**Consequences:**
- Curves look blurry or "soft" on non-Retina displays
- Lines look different thicknesses at different angles (optical illusion from anti-aliasing)
- Developers with Retina screens do not notice the problem

**Prevention:**
- **Use `stroke-width: 2` as the minimum for all lane lines and curves.** 2px strokes look sharp on both Retina and standard displays because the anti-aliased edge is a smaller proportion of the total width.
- **Use `stroke-linecap: round`** for path endpoints to avoid flat cut-off edges that look rough.
- **Do NOT use `shape-rendering: crispEdges`** on curves -- it disables anti-aliasing entirely, making curves visibly stepped/pixelated. Only use `crispEdges` on purely horizontal or vertical lines.
- **Test on a standard 1080p display**, not just a Retina MacBook. Use browser DevTools device emulation to simulate lower DPI if no physical display is available.

**Detection:**
- Curves look blurry or "glowing" on standard displays
- Straight vertical lines look crisp but curves look soft
- Side-by-side comparison between 1px and 2px strokes shows dramatic difference

**Phase:** Visual polish phase, but should be decided during initial rendering to avoid rework.

---

### Pitfall 12: Lane Color Palette Not Accessible / Clashes with Background

**What goes wrong:** The 8 lane colors (`--lane-0` through `--lane-7`) were chosen for aesthetics but not tested for: (a) contrast against the dark background (`#0d1117`), (b) distinguishability from each other for colorblind users, (c) readability when used as a 2px line on a dark background. Specifically, `--lane-7: #58595b` is nearly invisible against the `#0d1117` background (contrast ratio ~2.4:1, well below WCAG AA minimum of 3:1 for large text / graphical elements).

**Why it happens:** Colors were picked from a generic chart palette (similar to Chart.js defaults) without testing against the specific dark background and the specific rendering context (2px lines, not filled areas).

**Consequences:**
- Some branch lanes are nearly invisible
- Colorblind users cannot distinguish certain lane pairs (e.g., red/green, blue/purple)
- Users complain about "missing" branches that are actually just invisible

**Prevention:**
- **Test every lane color as a 2px line on `#0d1117`.** Minimum contrast ratio 4.5:1.
- **Replace `--lane-7: #58595b`** (dark gray) with a higher-contrast alternative. Consider `#a8a8a8` or `#c0c0c0`.
- **Use a colorblind-safe palette.** Tools like ColorBrewer or the Oklab color space can generate palettes that are distinguishable under all forms of color vision deficiency.
- **Test with browser extensions** that simulate color blindness (e.g., Chrome DevTools Rendering > Emulate vision deficiencies).
- **Add lane color labels on hover** (branch name tooltip) so users are not solely dependent on color to identify lanes.

**Detection:**
- A lane appears to "disappear" in certain sections of the graph
- Two adjacent lanes appear identical in color

**Phase:** Visual polish phase. Quick to fix but must be done before release.

---

## Minor Pitfalls

---

### Pitfall 13: Commit Dot Rendered Behind Pass-Through Lines

**What goes wrong:** The SVG renderer draws pass-through lane lines and then the commit dot. Because SVG elements render in document order (later = on top), this is correct. But if the rendering order is edges-then-dot, and a pass-through line happens to cross through the commit dot's center (which occurs when the commit is on a column that a pass-through edge also uses -- shouldn't happen, but edge cases exist), the line obscures the dot.

**Prevention:**
- **Always render in order: (1) pass-through straight lines, (2) merge/fork curves, (3) commit dots.** The dot must be last in SVG document order.
- **Add a small opaque background circle behind the commit dot** (same color as `--color-bg`) to create a "knockout" that separates the dot from crossing lines.

**Phase:** Rendering implementation. A simple z-order discipline.

---

### Pitfall 14: Edge Data Does Not Include Enough Information for Multi-Row Curves

**What goes wrong:** The current `GraphEdge` struct has `from_column`, `to_column`, `edge_type`, and `color_index`. For a merge or fork edge, this tells the renderer "draw a curve from column X to column Y" -- but it does not say whether the curve should span to the row above or below, or how many rows it spans. For standard merges/forks that span exactly one row, this is implied. But for edges where the parent is multiple rows below (due to interleaved commits on other branches), a single edge entry in the current row is insufficient -- the renderer does not know how many rows of straight line to draw before the curve.

**Why it happens:** The algorithm emits edges per-row, and each edge describes only the local geometry at that row. For a merge edge, row N says "MergeRight from column 0 to column 3" -- but the actual parent commit is at row N+5. Rows N+1 through N+4 need straight edges at column 3 for the merged branch's continuation. The algorithm handles this via pass-through Straight edges -- but the color_index for those pass-through edges must match the merge edge's color for visual continuity.

**Prevention:**
- **Verify that pass-through Straight edges emitted between a child and its parent carry the correct `color_index`.** The current code uses `color_index: other_col` for pass-through edges, which ties color to column position. This is correct as long as the column does not change between the child and parent.
- **For curves, the edge_type tells the renderer which direction to curve, and the curve always spans exactly one row boundary.** Document this contract explicitly: MergeLeft/MergeRight/ForkLeft/ForkRight edges always describe a curve that starts at the center of the current row and ends at the center of the adjacent row (above for merge, below for fork). The straight continuation above/below is handled by separate Straight edges.

**Phase:** Algorithm-renderer contract definition phase.

---

### Pitfall 15: Branch That Only Exists in Reflog Has No Ref but Occupies a Lane

**What goes wrong:** Deleted branches whose commits are still reachable (via other branches or reflog) appear in the revwalk output. The algorithm assigns them lanes, but they have no ref label. Users see unnamed branch lanes in the graph that do not correspond to any known branch.

**Prevention:**
- **This is correct behavior** -- the commits exist and their topology should be shown. Do not filter them out.
- **Add a visual distinction** for commits with no refs (dimmed lane color, or thinner line) to indicate they are reachable but not pointed-to by any branch.
- **The reflog itself is not walked by the current algorithm** (only `refs/heads`, `refs/remotes`, `refs/tags` are pushed to the revwalk). Deleted branches without other reachability will not appear.

**Phase:** Visual polish. Not a blocking issue.

---

### Pitfall 16: WIP Row Does Not Participate in Lane Rendering

**What goes wrong:** The WIP row in `CommitGraph.svelte` (lines 122-141) is rendered OUTSIDE the virtual list, above it. It has a hardcoded hollow circle at column 0 with a fixed SVG width of 12px. When lane rendering is added, the WIP row must connect to the HEAD commit's lane. If HEAD is not at column 0 (e.g., HEAD is on a feature branch at column 2), the WIP dot is at the wrong column and has no connecting line to HEAD.

**Prevention:**
- **The WIP row must participate in the lane algorithm.** Either include a synthetic "WIP" node in the Rust graph walk (preferred -- simplest to implement), or compute the WIP row's column and edges in the frontend based on the HEAD commit's lane data.
- **The WIP row should have a straight edge from its column to the HEAD commit's column below it.** If they are in the same column, it is a straight line. If different (unlikely but possible if HEAD is not on the primary branch), it is a fork edge.

**Phase:** WIP row integration, after the lane rendering is working for committed rows.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Severity | Mitigation |
|-------------|---------------|----------|------------|
| Lane algorithm hardening | Ghost lanes after merge (#4) | Critical | Add termination assertions in tests |
| Lane algorithm hardening | Lane collision (#9) | Critical | Add collision detection test with pending_parents check |
| Lane algorithm hardening | Octopus merge explosion (#5) | Moderate | Cap display at 4 parents; test with 5+ parent fixture |
| SVG rendering foundation | Sub-pixel gaps between rows (#1) | Critical | 0.5px line overlap + even stroke widths + zoom testing |
| SVG rendering foundation | Inconsistent SVG width (#6) | Critical | Fixed graph pane width from max_active_lanes metadata |
| SVG rendering foundation | Pass-through edges not drawn (#10) | Critical | Draw ALL edges from algorithm, not just merge/fork |
| Bezier curve rendering | Row boundary misalignment (#2) | Critical | Single logical curve split by row, not two independent curves |
| Bezier curve rendering | Jagged curves at low stroke (#11) | Moderate | Stroke-width 2 minimum, round linecaps |
| Virtual scroll integration | Overflow clipping (#3) | Moderate | Verify DOM structure; only viewport-edge clipping occurs |
| Virtual scroll integration | Re-render storms (#8) | Moderate | CSS variable for graph width, not per-component prop |
| Pagination continuity | Color drift across pages (#7) | Moderate | Keep full-walk algorithm; do not optimize to incremental |
| Visual quality | Color accessibility (#12) | Moderate | Test contrast ratios; replace --lane-7 |
| Visual quality | Dot z-order (#13) | Minor | SVG render order: lines, curves, dots |
| Edge data contract | Multi-row curve data (#14) | Minor | Document: merge/fork edges span exactly one row boundary |
| WIP row | WIP not in lane graph (#16) | Moderate | Synthetic WIP node in Rust graph or frontend column calc |

---

## Summary: Likely v0.1 Failure Modes

Based on the codebase evidence, the v0.1 lane rendering likely failed due to a combination of:

1. **Sub-pixel gaps (#1)** -- The most common failure mode for per-row SVG graphs. Without the 0.5px overlap technique, gaps between rows are nearly inevitable at certain zoom levels.
2. **Inconsistent SVG width (#6)** -- The current `svgWidth` calculation is per-commit-column, not per-row-max-column. This would cause message text misalignment and missing pass-through lanes.
3. **Missing pass-through edges (#10)** -- The current LaneSvg only renders a dot. If v0.1's implementation also failed to render pass-through Straight edges, the graph would have gaps in every lane at every commit that belongs to a different branch.

These three issues together would produce a graph with dashed vertical lines, misaligned text, and missing branches -- enough visual breakage to justify stripping it out.

---

## Sources

- [Commit Graph Drawing Algorithms](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html) -- Lane assignment, column packing, topological ordering, performance benchmarks (MEDIUM confidence -- 2019, but algorithmic principles are timeless)
- [Drawing a Commit Graph (DoltHub)](https://www.dolthub.com/blog/2024-08-07-drawing-a-commit-graph/) -- Lane packing, bezier curve implementation, color rendering (MEDIUM confidence)
- [Mastering SVG Seams: 5 Pro Fixes](https://junkangworld.com/blog/mastering-svg-seams-5-pro-fixes-for-flawless-shapes-2025) -- Anti-aliasing gap fixes, overlap technique (HIGH confidence -- browser behavior)
- [SVG shape-rendering MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/shape-rendering) -- crispEdges behavior (HIGH confidence -- MDN)
- [Fix for gap between inline SVG elements](https://codepen.io/elliz/pen/dOOrxO) -- display:block fix for inline SVG gaps (HIGH confidence)
- [WebKit Bug 96163: SVG overflow:visible](https://bugs.webkit.org/show_bug.cgi?id=96163) -- overflow:visible clipping in WebKit (HIGH confidence)
- [vscode-git-graph color/position mapping](https://github.com/mhutchie/vscode-git-graph/issues/194) -- Why deterministic branch coloring is infeasible in single-pass algorithms (HIGH confidence -- maintainer explanation)
- [Microsoft git PR #167: Octopus merge bug](https://github.com/microsoft/git/pull/167) -- Off-by-one in octopus merge handling (HIGH confidence)
- [Improving SVG Runtime Performance](https://codepen.io/tigt/post/improving-svg-rendering-performance) -- SVG DOM overhead (MEDIUM confidence)
- Codebase inspection of `graph.rs`, `LaneSvg.svelte`, `CommitRow.svelte`, `CommitGraph.svelte`, `@humanspeak/svelte-virtual-list` (HIGH confidence -- direct source analysis)
