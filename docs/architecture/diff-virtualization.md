# Diff virtualization

All three diff views — full-file, hunk and split — render through one virtual list over
one row model. `RenderedDiff` (rendered markdown) does not, and keeps its own element
record for navigation.

## The pieces

| File | Holds |
|---|---|
| `src/lib/diff-rows.ts` | The row model. Pure, no DOM: `buildInlineRows` and `buildSplitRows` project a diff into a flat row list, and `rowHeights` gives each row an exact height. |
| `src/lib/row-metrics.ts` | Character width and line height, measured once from a probe element carrying the row's own font. |
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
- `ExactVirtualList` publishes `--pan-x` from the scroll handler it already runs, inside
  the same reactive style string that carries `translateY`.

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

Each side's pan ceiling is that side's **full** width — `(gutterChars + columns[n]) *
charWidthPx + SPLIT_ROW_CHROME_PX` — because the gutter is pinned outside the translated
window. A ceiling built from text columns alone stops short of the widest line's tail.
The list's content width is the widest side plus one half, since a half only ever shows
`50cqi` of it.

## What this cost, and what it bought

Opening an 89,999-line file in split view, full-content mode, measured in Chromium
against the real backend: the pre-virtualization render painted 179,998 row elements and
blocked the main thread for 5,258 ms at worst; the virtualized render mounts about 100
rows and blocks for 103 ms at worst.

## Deliberate behaviour changes

- Line numbers are pinned in split view; they used to pan away with the code.
- The split hunk-header row takes a declared height, so its height no longer varies with
  which buttons the diff kind renders.
- One row per pair puts the two sides adjacent in DOM order, so a selection spanning
  several rows picks up both sides. It still carries no line numbers.

## Testing

jsdom reports zero for layout, so a virtualized render there is silently empty: the
suites install a layout stub. jsdom also ignores Svelte's scoped CSS, which is why every
load-bearing declaration above is written inline on the element — a contract asserted in
a unit test has to be readable from the style attribute.

Neither of those catches a geometry defect. All three traps above passed the unit suites
and were found by rendering the real app through `just measure` and reading the boxes
back. Settle a pixel question there, never from the source.
