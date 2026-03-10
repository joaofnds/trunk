---
status: investigating
trigger: "Column resize dividers/handles are not consistently visible. They should ALWAYS show as subtle vertical lines (not just on hover). Also, the dividers need padding so text content doesn't rub against them."
created: 2026-03-09T22:00:00-03:00
updated: 2026-03-09T22:00:00-03:00
---

## Current Focus

hypothesis: The header has resize handles with visible divider lines (commit b53444c fix looks correct), but the DATA ROWS have NO dividers at all -- CommitRow.svelte has zero border-right/border-left/divider styles and zero padding on individual column cells.
test: Read CommitRow.svelte for any divider or padding styles on column cells
expecting: No dividers and no padding found in data rows (confirmed)
next_action: Document root causes and fix both issues

## Symptoms

expected: Column dividers visible at all times as subtle 1px lines; padding between divider and adjacent text content
actual: Dividers not consistently visible; text content rubs against column edges
errors: none (visual/CSS issue)
reproduction: Open the app and look at the commit list -- data rows have no vertical column separators
started: The b53444c fix only addressed the header resize handles, not the data row dividers

## Eliminated

- hypothesis: The linear-gradient fix on .col-resize-handle is broken or using an invisible color
  evidence: --color-border is #30363d (visible dark gray), and the CSS at lines 280-281 of CommitGraph.svelte correctly renders a 1px line via linear-gradient. The header handles ARE visible.
  timestamp: 2026-03-09T22:00:00-03:00

- hypothesis: The --color-border CSS variable is undefined or transparent
  evidence: Defined in app.css line 7 as #30363d, used throughout the app for borders successfully
  timestamp: 2026-03-09T22:00:00-03:00

## Evidence

- timestamp: 2026-03-09T22:00:00-03:00
  checked: CommitGraph.svelte .col-resize-handle CSS (lines 272-285)
  found: The header resize handles DO have the linear-gradient background from commit b53444c. The CSS is correct -- a 1px var(--color-border) line centered in a 4px-wide absolutely-positioned handle element.
  implication: The header dividers should be rendering correctly. The issue "not consistently visible" likely means the DATA rows lack dividers, creating a visual gap.

- timestamp: 2026-03-09T22:00:00-03:00
  checked: CommitGraph.svelte header markup (lines 167-192)
  found: Only 5 of 6 columns have resize handles. The "Message" column (flex-1, line 177-179) and the "SHA" column (last column, lines 190-192) have NO resize handle divs. This is intentional -- Message is flex-1 (takes remaining space) and SHA is the last column (no right edge needed). But it means there's no left-side divider on the Author column from the Message column's perspective.
  implication: Header dividers exist on ref, graph, author, date columns (right edge). This is correct.

- timestamp: 2026-03-09T22:00:00-03:00
  checked: CommitRow.svelte for any divider/border/padding styles on column cells
  found: ZERO border-right, border-left, divider, or col-resize references. The only padding is px-2 on the outer row container (line 32). Individual column cells have NO padding whatsoever -- the ref column (line 45), graph (line 50), message (lines 56/60), author (line 66), date (line 71), and sha (line 76) all lack any horizontal padding.
  implication: ROOT CAUSE 1 -- Data rows have no visual column dividers. ROOT CAUSE 2 -- Column cell text has no padding, causing text to "rub against" column edges.

- timestamp: 2026-03-09T22:00:00-03:00
  checked: CommitGraph.svelte header columns for padding
  found: Only two header columns have pl-1 padding: "Branch/Tag" (line 167) and "Message" (line 177). The other header columns (Graph, Author, Date, SHA) have no padding.
  implication: Even the header is inconsistent with padding. Data rows are worse -- only the outer row has px-2.

## Resolution

root_cause: |
  TWO DISTINCT ISSUES:

  1. NO DIVIDERS IN DATA ROWS: The commit b53444c fix only added the linear-gradient background to .col-resize-handle elements in the header row (CommitGraph.svelte <style> block, lines 272-285). CommitRow.svelte has ZERO divider styling -- no border-right, no pseudo-elements, nothing to visually separate columns. Users see dividers in the 24px header but then a seamless, unseparated grid of data below it.

  2. NO PADDING ON COLUMN CELLS: CommitRow.svelte column divs have no horizontal padding. The only padding is px-2 (8px) on the outer row container, which doesn't help individual column cells. Text content directly abuts the column width boundaries. Compare with the header where at least "Branch/Tag" and "Message" have pl-1.

  FILES:
  - src/components/CommitRow.svelte -- needs border-right on column cells (except last) and px-1 or similar padding on text-bearing cells
  - src/components/CommitGraph.svelte -- header column padding is inconsistent but less critical

fix:
verification:
files_changed: []
