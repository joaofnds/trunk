---
status: diagnosed
trigger: "Connector line from ref pills to commit dot overshoots to end of pane; overflow count (+2) is plain text"
created: 2026-03-09T00:00:00Z
updated: 2026-03-09T00:00:00Z
---

## Current Focus

hypothesis: Connector line starts at left:0 (absolute) and spans the full ref column width, instead of starting from the right edge of the last pill. Overflow count is a plain span with no pill styling.
test: Read code to confirm width calculation and overflow rendering
expecting: Confirm the two root causes match the observed behavior
next_action: Report findings

## Symptoms

expected: |
  1. Connector line should start from the right edge of the last pill (or overflow count) and extend to the commit dot.
  2. The overflow count ("+2") should be rendered as a small pill element.
actual: |
  1. Connector line starts at left:0 and extends the full ref column width + graph offset, overshooting far past the pills.
  2. The overflow count is plain muted text, hard to read against the connector line background.
errors: none (visual issue)
reproduction: Any commit with refs - the horizontal line overshoots visually
started: Current implementation

## Eliminated

(none - root causes found on first investigation)

## Evidence

- timestamp: 2026-03-09T00:00:00Z
  checked: CommitRow.svelte lines 36-42 (connector line div)
  found: |
    The connector line is an absolutely positioned div:
      class="absolute left-0 pointer-events-none"
      style="width: {columnWidths.ref + commit.column * 12 + 6 + 8}px; ..."

    It starts at left:0 (the very left edge of the row) and its width spans:
      - columnWidths.ref (full ref column, default 120px)
      - commit.column * 12 (lane offset within graph column)
      - 6 (half laneWidth = center of commit dot)
      - 8 (px-2 left padding of the row)

    This means the line covers the ENTIRE ref column from left edge to the commit dot.
    The pills only occupy a small portion of the ref column, so the line visually
    overshoots far to the right of the last pill before reaching the dot.
  implication: |
    ROOT CAUSE 1: The connector line is drawn from left:0 across the full ref column.
    It should instead start from the right edge of the last pill/overflow count and
    extend only from there to the commit dot.

- timestamp: 2026-03-09T00:00:00Z
  checked: RefPill.svelte lines 43-49 (overflow count rendering)
  found: |
    The overflow count is rendered as:
      <span class="text-[11px] text-[var(--color-text-muted)] ml-1 cursor-default"
            title={refs.slice(1).map((r) => r.short_name).join(', ')}>
        +{refs.length - 1}
      </span>

    It's a plain <span> with only muted text color. No background, no border-radius,
    no padding styled as a pill. Compare to the actual ref pill on line 42:
      <span class={pillClasses(refs[0])} style={pillStyle(refs[0])}>
    which includes: rounded-full, px-1.5, py-0, text-[11px], leading-5, background color, white text.
  implication: |
    ROOT CAUSE 2: The overflow count is unstyled plain text. It needs pill-like styling
    (background, border-radius, padding) to be readable against the connector line.

- timestamp: 2026-03-09T00:00:00Z
  checked: CommitRow.svelte line 45 (ref column container)
  found: |
    The ref column container has overflow-hidden and a fixed width:
      <div class="relative z-[1] flex items-center overflow-hidden flex-shrink-0"
           style="width: {columnWidths.ref}px;">

    The pills sit inside this container with z-[1], so they render above the connector
    line (z-index: 0). But the connector line extends the full column width behind them.
  implication: |
    The z-index layering is correct (pills above line), but the line's left position and
    width are wrong - it should not start at left:0.

- timestamp: 2026-03-09T00:00:00Z
  checked: LaneSvg.svelte (entire file)
  found: |
    LaneSvg.svelte handles only the SVG graph column (vertical rails, merge/fork paths,
    commit dots). It does NOT draw any horizontal connector line to the ref pills.
    The connector line is entirely in CommitRow.svelte.
  implication: No changes needed in LaneSvg.svelte for this issue.

## Resolution

root_cause: |
  TWO ROOT CAUSES:

  1. CONNECTOR LINE OVERSHOOT (CommitRow.svelte lines 38-41):
     The connector line is absolutely positioned at left:0 with a width that spans
     the full ref column + graph offset. This means it extends from the very left edge
     of the row all the way to the commit dot. The intent is for the line to connect
     the pills to the dot, but since the pills are typically much narrower than the
     ref column, the line visually overshoots far to the right of the last pill.

     The fix requires knowing the actual rendered width of the pill content, then
     positioning the line to start at that point. This can be done by:
     (a) Using a bind:clientWidth on the pill container to measure actual pill width,
         then setting the connector's left to that value + padding offset.
     (b) Or restructuring so the connector line is inside the ref column container,
         starting after the pills using flex layout (e.g., a flex-1 div after the pills).

     Approach (b) is simpler and more robust: place the connector line element AFTER
     the RefPill inside the ref column's flex container, let it fill remaining space
     with flex-1, then extend it into the graph column to reach the commit dot.

     Approach (a) with bind:clientWidth is more Svelte-idiomatic: measure the pill
     container's actual width, compute connector left = 8 (px-2 padding) + pillWidth,
     and connector width = (columnWidths.ref - pillWidth) + commit.column * 12 + 6.

  2. OVERFLOW COUNT NOT STYLED AS PILL (RefPill.svelte lines 43-49):
     The "+N" overflow count is a plain <span> with only muted text color. It needs
     pill styling similar to the ref pills: a background color, border-radius (rounded-full),
     padding, and contrasting text color. It should be smaller/subtler than the main pills
     (e.g., slightly transparent background, or a neutral/muted background color).

fix: not yet applied
verification: not yet verified
files_changed: []
