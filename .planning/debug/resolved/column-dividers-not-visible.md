---
status: resolved
trigger: "Column dividers not visible without hovering"
created: 2026-03-09T00:00:00Z
updated: 2026-03-10T00:00:00Z
---

## Current Focus

hypothesis: col-resize-handle has no default visual indicator - only shows color on :hover
test: read CSS for .col-resize-handle in CommitGraph.svelte
expecting: no background/border in default state, only on :hover
next_action: return diagnosis with CSS recommendations

## Symptoms

expected: Visible dividers between columns at all times so users know where resize boundaries are
actual: Resize handles are invisible (transparent) by default, only showing a blue highlight on hover
errors: none (visual design issue, not a bug)
reproduction: Look at the column header row - no vertical dividers visible between columns
started: Since phase 10-02 implementation

## Eliminated

(none - root cause identified on first hypothesis)

## Evidence

- timestamp: 2026-03-09
  checked: CommitGraph.svelte .col-resize-handle CSS (lines 272-283)
  found: Default state has NO background, NO border - only `position: absolute; right: 0; top: 0; bottom: 0; width: 4px; cursor: col-resize; user-select: none;`. The :hover state sets `background: var(--color-accent)` (#388bfd blue).
  implication: Handles are completely invisible until hovered.

- timestamp: 2026-03-09
  checked: App.svelte .pane-divider CSS (lines 285-295) for comparison
  found: Pane dividers use `background: linear-gradient(...)` with `var(--color-border)` in default state, providing a visible 1px line. On hover, they widen the accent line.
  implication: The pane dividers already solve this problem correctly - column handles should follow the same pattern.

- timestamp: 2026-03-09
  checked: CommitRow.svelte for row-level dividers
  found: No border-right or divider styling on any column div in CommitRow. Columns are plain divs with width and overflow-hidden.
  implication: There are no dividers in the data rows either - adding header dividers alone may look inconsistent without also adding subtle row dividers.

- timestamp: 2026-03-09
  checked: app.css color tokens
  found: `--color-border: #30363d` (subtle dark gray), `--color-accent: #388bfd` (bright blue)
  implication: --color-border is the correct token for subtle always-visible dividers

## Resolution

root_cause: The `.col-resize-handle` CSS in CommitGraph.svelte has no default background or border - it is completely transparent. Only the `:hover` pseudo-class applies a visible background (`var(--color-accent)`). Users have no visual cue that columns are separated or where to drag.
fix: (research only - not applied)
verification: (research only)
files_changed: []
