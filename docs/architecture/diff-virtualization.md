# Diff virtualization

All three diff views, full-file, hunk and split, render through one virtual list over
one row model. `RenderedDiff` (rendered markdown) does not, and keeps its own element
record for navigation.

## The pieces

| File | Holds |
|---|---|
| `src/lib/diff-rows.ts` | The row model. Pure, no DOM: `buildInlineRows` and `buildSplitRows` project a diff into a flat row list, and `rowHeights` gives each row an exact height. |
| `src/lib/row-metrics.ts` | Character width and line height, measured once from a probe element carrying the row's own font. |
| `src/lib/virtualized-diff.svelte.ts` | The plumbing all three views share, behind one factory: the font-metrics and comment-height probes, the pane ResizeObserver, the readiness gate, and the width arithmetic for both layouts (inline's px content width, split's per-side pan ceilings). Views read every output through the factory's getters. |
| `src/components/diff/ExactVirtualList.svelte` | The list. Takes exact heights, never measures a row, and publishes `--pan-x` from its scroll handler. |
| `src/lib/diff-nav.ts` | `DiffNav`, the handle a virtualized view publishes so the host can jump to a hunk or a line by row index. |

Two rules hold the design up, and breaking either reintroduces the correction loop the
design exists to remove:

- **Heights are computed, never measured.** A virtual list never has the widest row
  mounted, so measuring one makes the extent jump while scrolling. Column counts come
  from the row model and heights from character arithmetic.
- **A row whose height cannot be computed refuses.** `rowHeights` throws for a comment
  row the view has not probed yet, rather than substituting a plausible default. The
  view withholds the list until every input exists.

## Scrolling and painted coverage

The native scroll offset and the main thread's rendered rows advance independently.
A finite row window positioned in the tall document can therefore leave the visible
area before the next render arrives. Complete DOM rectangles also do not prove that
WebKit presented those pixels: native captures on macOS 27.2.1 showed missing paint
with complete row coverage, including in a standalone WKWebView with all rows mounted.

The list separates the logical scroll extent from the painted surface:

- The outer viewport scrolls natively over the extent `T`: the exact total row height
  plus the trailing space the view passes, which keeps the selection's Comment action
  whole where it hangs below the last line. A list with no rows has no trailing space.
- A `position: sticky; top: 0` surface inside that extent has height `min(H, T)`,
  where `H` is the viewport height. It stays at the viewport while scrolling inside
  the file bounds. Its height is part of the extent, not added to it.
- One rendered offset `r = clamp(scrollTop, 0, max(0, T - H))` selects the mounted
  rows and positions their container at `firstRowOffset - r` inside the surface.
  Each completed render therefore covers its own surface using one coordinate system.
- `overflow: clip` limits painting to that surface without introducing another scroll
  container. The rows' horizontal sticky pins still belong to the outer viewport.

Between main-thread updates, native scrolling cannot move the finite row window out
of the in-range viewport. Content can lag behind input if the main thread is busy;
this design trades independent content motion for coherent painted coverage. It is
not a guarantee against arbitrary WebKit or GPU paint failures. At either end, the
native scroller and sticky containing block retain the bounce. Clamping `r` prevents
the rows from applying that overscroll a second time.

Moving rows with `top` instead of a transform did not remove the failure. Neither
did retaining previously mounted rows or rendering the entire file. Full-file DOM
also made a 90,000-line experiment take seconds to become ready. The stationary
surface adds one element while keeping the row window bounded.

## Why split view pans the way it does

Split view shows two halves that must stay side by side while a wide line is panned
across. The mechanism is a native horizontal scroller on the list viewport, plus one
shared offset:

- Each `PairedRow` is **one row**, `position: sticky; left: 0; width: 100cqi`, so the
  compositor holds it against the pan with no per-frame JavaScript.
- Inside sit two cells of `50cqi` with `overflow: clip`, so a cell never becomes a scroll
  container and cannot steal a wheel.
- Each cell holds a pinned line-number gutter and, beside it, a **clipped window**. The
  window carries `overflow: clip` and no transform; the content **inside** the window
  carries `translateX(calc(-1 * min(var(--pan-x), max(0px, var(--max-l) - 50cqi))))`,
  with `--max-r` on the right.
- `ExactVirtualList` publishes `--pan-x` from its scroll handler on the rows container.

Three traps, each of which shipped as a defect once and was caught only by rendering in a
real browser engine:

1. **Clip the window, not just the cell.** The gutter sits inside the cell's box, so a
   cell-only clip lets content translated left paint straight across the line numbers.
2. **Translate the content, not the window.** Transforming the clipping element moves its
   clip box with it, which slides the whole half out of the cell instead of panning
   within it.
3. **The panned content is `width: max-content` only when there is a pan.** Under word
   wrap it must be `width: 100%`, or a wrapped line runs past the window at a single
   line's height and the exact-height contract breaks.

A fourth is older and just as easy to re-derive: **never pin a column from a scroll
handler.** A scroll is composited before the handler runs, so a JavaScript-written pin is
one frame behind by construction and the pinned gutter visibly wobbles. The pin is CSS.

## Widths

Nothing reserves scrollbar width anywhere: `::-webkit-scrollbar` is `display: none`
app-wide and the themed thumb is a `position: fixed` overlay painted from `<body>`. So
`100cqi`, resolved against the container context on `DiffViewer.svelte`, is exactly the
width the reader sees, and a half is a plain `50cqi`. Do not reintroduce a measured
scrollbar-width correction; it compensates a reservation that no longer exists.

Each side's pan ceiling is that side's **full** width, `(sideGutterChars + columns[n]) *
charWidthPx + SPLIT_ROW_CHROME_PX`, where `sideGutterChars` is the line-number gutter
plus the thread-marker column (`markerChars`), because both are pinned outside the
translated window. A ceiling built from text columns alone stops short of the widest line's tail.
The list's content width is the widest side plus one half, since a half only ever shows
`50cqi` of it.

## What this cost, and what it bought

Opening an 89,999-line file in split view, full-content mode, measured in Chromium
against the real backend: the pre-virtualization render painted 179,998 row elements and
blocked the main thread for 5,258 ms at worst; the virtualized render mounts about 100
rows and blocks for 103 ms at worst.

A native WKWebView comparison on macOS 27.2.1 used the same 1,500-line fixture,
12,000px starting offset and eight-fling fast trace from
[`scripts/diff-scroll`](../../scripts/diff-scroll/README.md). The document-positioned
baseline had 7 missing-content frames among 415 captured frames; the stationary
surface had none among 409. Both mounted at most 118 rows. Animation-frame callback
gaps were 18ms versus 19ms at p95, and 32ms versus 29ms at maximum.

A separate paired 90,000-line opening measured 589ms versus 590ms to the ready DOM,
and 592ms versus 593ms to the next animation-frame callback. Both mounted 77 rows;
the candidate added one DOM element. These are single-run setup measurements,
not paint times or a statistical performance guarantee.

## Deliberate behaviour changes

- Line numbers are pinned in split view; they used to pan away with the code.
- The split hunk-header row takes a declared height, so its height no longer varies with
  which buttons the diff kind renders.
- One row per pair puts the two sides adjacent in DOM order, so a selection spanning
  several rows picks up both sides. It still carries no line numbers.

## Testing

jsdom reports zero for layout, so the component suites install a layout stub. Their
assertions can read rendered rows and inline dimensions, but do not resolve the CSS
that makes the surface sticky and clipped. Those properties need a browser check.

The component tests cover window bounds, variable heights, viewport-local offsets,
overscroll, short content and a shrinking model. They cannot establish native paint
correctness. Geometry checks in the running app cover wrapping, comment folding,
selection, navigation, resizing and horizontal pinning.

Use the opt-in native experiment in `scripts/diff-scroll` for pixel regressions.
It records window-bound wheel input and ScreenCaptureKit frames, correlates DOM
samples through visible frame markers, and rejects incomplete or mistimed captures.
Its pixel oracle covers the synthetic added-file fixture and gaps of at least 64px;
comments, other layouts and physical trackpad distributions need separate checks.
Keep a failing baseline beside the candidate results. A green DOM test or one green
recording alone does not establish that the reported defect is gone.
