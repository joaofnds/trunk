---
phase: 26-svg-ref-pills
verified: 2026-03-14T17:23:00Z
status: human_needed
score: 15/15 must-haves verified
human_verification:
  - test: "Visual check: SVG ref pills render as capsule-shaped rects with lane-colored backgrounds"
    expected: "Capsule-shaped pills with rounded ends, colored to match branch lane colors, white text"
    why_human: "Visual rendering — SVG geometry and color correctness require visual inspection"
  - test: "Visual check: Connector lines from pill right edge to commit dot"
    expected: "Straight horizontal line in commit lane color, 1.5px thickness, connecting pill to dot"
    why_human: "Spatial relationship between SVG elements needs visual verification"
  - test: "Visual check: Remote-only pills dimmed at ~67% opacity"
    expected: "Remote-only branches noticeably dimmer; local branches with matching remotes NOT dimmed; HEAD at full brightness"
    why_human: "Opacity and brightness differences require visual comparison"
  - test: "Visual check: Overflow +N badge and hover expansion"
    expected: "Single pill + darkened +N badge; hover expands to show all refs with 180ms animation"
    why_human: "Animation timing and hover interaction need human testing"
  - test: "Visual check: Tag diamond icon and stash flag icon"
    expected: "Small diamond SVG path for tags, flag SVG path for stashes — no unicode prefixes"
    why_human: "SVG path icon shapes require visual inspection"
  - test: "Regression: scroll, click, context menu, column resize, column hide"
    expected: "All interactions work as before — no breakage from SVG pill migration"
    why_human: "Interactive behavior requires manual testing"
---

# Phase 26: SVG Ref Pills Verification Report

**Phase Goal:** Ref pills render as SVG elements with lane-colored backgrounds, connector lines, remote dimming, and overflow badges — replacing HTML ref pills in the graph column
**Verified:** 2026-03-14T17:23:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

#### Plan 01 (Data Pipeline)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | buildRefPillData() transforms OverlayNode[] + GraphCommit[] into OverlayRefPill[] with correct positions, sizes, and styling flags | ✓ VERIFIED | `src/lib/ref-pill-data.ts` lines 76-137: pure function with all 17 OverlayRefPill fields computed; 17 tests pass |
| 2 | Text truncation with ellipsis respects max width using Canvas measureText | ✓ VERIFIED | `src/lib/text-measure.ts` lines 47-71: progressive trimming with "…" suffix; 6 tests pass |
| 3 | HEAD branch gets first priority; refs sorted by type (local > tag > stash > remote) | ✓ VERIFIED | `src/lib/ref-pill-data.ts` lines 31-39: sortRefs with HEAD check + TYPE_ORDER map; tested in ref-pill-data.test.ts |
| 4 | Remote-only pills flagged with isRemoteOnly=true; non-HEAD pills flagged with isNonHead=true | ✓ VERIFIED | `src/lib/ref-pill-data.ts` lines 46-51 (isRemoteOnlyRef) + line 126-127 (flags); tests at lines 160-187 |
| 5 | Overflow count computed as refs.length - 1; allRefs array populated for hover expansion | ✓ VERIFIED | `src/lib/ref-pill-data.ts` line 94 (overflowCount) + line 128 (allRefs); tests at lines 134-158 |
| 6 | Connector coordinates computed from pill right edge to commit dot center | ✓ VERIFIED | `src/lib/ref-pill-data.ts` lines 129-131: dotCx=cx(node.x), dotCy=cy(node.y), commitColorIndex; test at lines 189-200 |
| 7 | getVisibleOverlayElements returns pills filtered by visible row range | ✓ VERIFIED | `src/lib/overlay-visible.ts` line 41: rowIndex filtering; 3 pill visibility tests pass |

#### Plan 02 (SVG Rendering)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 8 | Ref pills render as SVG capsule-shaped rects with colored backgrounds inside the overlay | ✓ VERIFIED | `CommitGraph.svelte` lines 595-608: `<rect>` with `rx={PILL_HEIGHT / 2}`, `fill={laneColor(pill.colorIndex)}`, inside `<g class="overlay-pills">` |
| 9 | SVG text inside pills is truncated with ellipsis and vertically centered | ✓ VERIFIED | `CommitGraph.svelte` lines 631-649: `<foreignObject>` with `<span>` rendering `pill.truncatedLabel`, `line-height: {PILL_HEIGHT}px` for centering |
| 10 | Straight horizontal connector lines run from pill right edge to commit dot | ✓ VERIFIED | `CommitGraph.svelte` lines 582-592: `<line x1={pill.x + pill.width} y1={pill.y} x2={refOffset + pill.dotCx} y2={pill.dotCy}>` with commit lane color |
| 11 | Remote-only pills appear dimmed at ~67% opacity; non-HEAD pills have brightness(0.75) | ✓ VERIFIED | `CommitGraph.svelte` lines 589-590, 603-604: `opacity={pill.isRemoteOnly ? 0.67 : 1}` + `filter: brightness(0.75)` for isNonHead |
| 12 | Overflow +N badge renders next to pill when commit has multiple refs | ✓ VERIFIED | `CommitGraph.svelte` lines 652-687: badge `<rect>` + `<foreignObject>` with `+${pill.overflowCount}` text, brightness(0.65) |
| 13 | Hovering pill or +N badge shows overlay with all refs expanded (180ms animation) | ✓ VERIFIED | `CommitGraph.svelte` lines 692-741: two hover modes (overflow=vertical list, truncated=width expansion), `transition: opacity 180ms ease` |
| 14 | HTML ref pills, connector div, and +N badge removed from CommitRow | ✓ VERIFIED | `CommitRow.svelte` line 45: empty spacer `<div class="flex-shrink-0">` replaces old ref column; no RefPill import; no refHovered/allRemoteOnly state |
| 15 | SVG path icons render for tag and stash ref types | ✓ VERIFIED | `CommitGraph.svelte` lines 611-628: Tag diamond `<path d="M ... l 4 -4 l 4 4 l -4 4 z">` + Stash flag `<path d="M ... v -8 h 5 v 4 h -5">` |

**Score:** 15/15 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/lib/types.ts` | OverlayRefPill interface | ✓ VERIFIED | 17-field interface at lines 166-184, exports `OverlayRefPill` |
| `src/lib/graph-constants.ts` | Pill-specific constants | ✓ VERIFIED | PILL_HEIGHT, PILL_PADDING_X, PILL_FONT, PILL_FONT_BOLD, PILL_GAP, PILL_MARGIN_LEFT, BADGE_HEIGHT, BADGE_FONT_SIZE, ICON_WIDTH (lines 8-17) |
| `src/lib/text-measure.ts` | Canvas measureText utility with caching and truncation | ✓ VERIFIED | 77 lines: measureTextWidth (cached), truncateWithEllipsis (progressive), resetCache; OffscreenCanvas + injectable rawMeasureFn |
| `src/lib/ref-pill-data.ts` | Pure pill data computation | ✓ VERIFIED | 137 lines: sortRefs, isRemoteOnlyRef, buildRefPillData; imports OverlayRefPill + pill constants + truncateWithEllipsis |
| `src/lib/overlay-visible.ts` | Extended visibility filtering including pills | ✓ VERIFIED | pills field in VisibleOverlayElements, optional pills param with default `[]`, rowIndex filtering |
| `src/components/CommitGraph.svelte` | Fourth overlay-pills layer with SVG rendering + hover overlay | ✓ VERIFIED | 819 lines: imports, $derived pillData, hoveredPill state, expanded SVG width, translate-offset graph groups, overlay-pills `<g>`, HTML hover overlay |
| `src/components/CommitRow.svelte` | Cleaned up row — HTML ref pills removed | ✓ VERIFIED | 85 lines: no RefPill import, no refHovered/allRemoteOnly, ref column is empty spacer div |
| `src/lib/text-measure.test.ts` | Text measurement tests | ✓ VERIFIED | 58 lines: 6 tests covering cache, truncation, edge cases |
| `src/lib/ref-pill-data.test.ts` | Pill data computation tests | ✓ VERIFIED | 240 lines: 17 tests covering sorting, positions, overflow, remote detection, truncation, icons |
| `src/lib/overlay-visible.test.ts` | Visibility tests with pills | ✓ VERIFIED | 224 lines: 3 pill-specific tests + existing tests unbroken |

### Key Link Verification

#### Plan 01 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `ref-pill-data.ts` | `types.ts` | `import OverlayRefPill, OverlayNode, GraphCommit, RefLabel` | ✓ WIRED | Line 1: `import type { GraphCommit, OverlayNode, OverlayRefPill, RefLabel } from './types.js'` |
| `ref-pill-data.ts` | `graph-constants.ts` | `import PILL_HEIGHT + other constants` | ✓ WIRED | Lines 2-13: imports PILL_HEIGHT, PILL_PADDING_X, PILL_FONT, PILL_FONT_BOLD, PILL_GAP, PILL_MARGIN_LEFT, ICON_WIDTH, LANE_WIDTH, ROW_HEIGHT, BADGE_FONT_SIZE |
| `overlay-visible.ts` | `types.ts` | `import OverlayRefPill` | ✓ WIRED | Line 1: `import type { OverlayNode, OverlayPath, OverlayRefPill } from './types.js'` |

#### Plan 02 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `CommitGraph.svelte` | `ref-pill-data.ts` | `$derived calling buildRefPillData()` | ✓ WIRED | Line 12 (import) + Line 351 (`$derived.by(() => buildRefPillData(...))`) |
| `CommitGraph.svelte` | `overlay-visible.ts` | `getVisibleOverlayElements with pills parameter` | ✓ WIRED | Line 526: `getVisibleOverlayElements(paths, graphData.nodes, visibleStart, visibleEnd, pillData)` |
| `CommitGraph.svelte` | `text-measure.ts` | `measureTextWidth passed to buildRefPillData` | ✓ WIRED | Line 13 (import) + Line 351 (passed as 4th arg to buildRefPillData) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| PILL-01 | 26-01, 26-02 | Ref pills render as SVG `<rect>` + `<text>` elements with lane-colored backgrounds | ✓ SATISFIED | Capsule `<rect>` with rx/ry, `<foreignObject>` text, `fill={laneColor(pill.colorIndex)}` in overlay-pills group |
| PILL-02 | 26-01, 26-02 | SVG connector lines render from ref pill to commit dot | ✓ SATISFIED | `<line>` element from pill right edge to refOffset+dotCx, using commitColorIndex lane color, EDGE_STROKE width |
| PILL-03 | 26-01, 26-02 | Remote branch pills appear visually dimmed compared to local branch pills | ✓ SATISFIED | isRemoteOnly → opacity 0.67; isNonHead → brightness(0.75); HEAD → full brightness + bold text |
| PILL-04 | 26-01, 26-02 | Overflow "+N" badge appears when refs exceed available space | ✓ SATISFIED | overflowCount computation, badge rect+text, hover expansion with allRefs, 180ms transition |

No orphaned requirements found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | No anti-patterns found |

No TODO/FIXME/PLACEHOLDER markers in any modified files. No empty implementations. No console.log stubs. RefPill.svelte preserved as dead code per plan (deliberate decision, not accidental orphan).

### Human Verification Required

### 1. SVG Capsule Pills with Lane Colors (PILL-01)

**Test:** Run `cargo tauri dev`, open a repo with branches/tags. Inspect ref pills in the graph.
**Expected:** Capsule-shaped (rounded ends) colored rectangles with white text; colors match branch lane colors; HEAD pill has bold text.
**Why human:** SVG geometry, color rendering, and font weight require visual inspection.

### 2. Connector Lines (PILL-02)

**Test:** Observe the line from each pill's right edge to its commit dot.
**Expected:** Straight horizontal line in commit's lane color, ~1.5px thickness, connecting pill to corresponding dot.
**Why human:** Spatial alignment between SVG elements across the ref/graph column boundary needs visual check.

### 3. Remote Dimming and Non-HEAD Darkening (PILL-03)

**Test:** Find remote-only branches and local branches in the graph.
**Expected:** Remote-only branches noticeably dimmer (~67% opacity); non-HEAD local branches slightly darkened (brightness 0.75); HEAD pill full brightness.
**Why human:** Opacity/brightness differences require visual comparison side-by-side.

### 4. Overflow Badge and Hover Expansion (PILL-04)

**Test:** Find a commit with multiple refs (e.g., HEAD with local + remote + tag). Hover over the pill and +N badge.
**Expected:** Single pill + darkened "+N" badge; hover expands to show all ref names with smooth ~180ms animation.
**Why human:** Animation timing, hover behavior, and overlay positioning need interactive testing.

### 5. SVG Icons for Tag/Stash

**Test:** Find tag and stash entries in the graph.
**Expected:** Small diamond icon for tags, flag icon for stashes (not unicode ◆/⚑ prefixes).
**Why human:** SVG path icon shapes require visual inspection.

### 6. Regression Testing

**Test:** Scroll the graph, click commit rows, right-click for context menu, resize ref column, hide ref column via header context menu.
**Expected:** All interactions work as before. No visual glitches, no broken selection, no context menu issues.
**Why human:** Interactive behavior across multiple features requires manual end-to-end testing.

### Test Suite

All 121 tests pass (6 test files), including 26 new tests added in this phase:
- 6 text-measure tests (caching, truncation, edge cases)
- 17 ref-pill-data tests (sorting, positioning, overflow, remote detection, icons)
- 3 overlay-visible pill filtering tests

### Gaps Summary

No automated gaps found. All 15 truths verified at all three levels (exists, substantive, wired). All 4 PILL requirements have full implementation evidence. Test suite green. HTML pills fully removed from CommitRow.

Phase requires human visual verification to confirm SVG rendering fidelity, animation behavior, and interaction regressions. All code-level checks pass.

---

_Verified: 2026-03-14T17:23:00Z_
_Verifier: Claude (gsd-verifier)_
