---
status: resolved
trigger: "CSS bug: long branch names in Remote section wrap instead of truncating with ellipsis"
created: 2026-03-04T00:00:00Z
updated: 2026-03-04T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — text truncation fails at two layers: BranchRow text node has no overflow containment, and RemoteGroup's indent wrapper has no min-width:0 to let flex truncation propagate
test: full component tree trace from aside down to text node
expecting: identified every missing CSS property at every level
next_action: return diagnosis

## Symptoms

expected: long branch names (e.g. "dependabot/github_actions/actions/...") should be clipped with "..." at the sidebar edge
actual: long names wrap to a second line, pushing the row taller
errors: none (visual bug only)
reproduction: open Remote section with any dependabot or long-path branch
started: always (no truncation CSS was ever applied)

## Eliminated

- hypothesis: BranchSection container is missing overflow:hidden
  evidence: BranchSection outer <div> has no width/overflow but is a plain block — not the cause; the sidebar <aside> already has overflow:hidden and a fixed 220px width. The block children naturally fit; the problem is inside the flex row.
  timestamp: 2026-03-04

- hypothesis: BranchSidebar overflow:hidden is missing
  evidence: BranchSidebar <aside> has both `overflow: hidden` and `width: 220px; min-width: 220px;` — this part is correct.
  timestamp: 2026-03-04

## Evidence

- timestamp: 2026-03-04
  checked: BranchSidebar.svelte lines 125-133
  found: aside has `width:220px; min-width:220px; overflow:hidden; display:flex; flex-direction:column`
  implication: outer container is correctly constrained; the 220px boundary exists

- timestamp: 2026-03-04
  checked: BranchSidebar.svelte line 155
  found: scrollable wrapper `<div style="flex:1; overflow-y:auto;">` — this is a block container, not flex, so its children are block-level and naturally fill width
  implication: this level is fine

- timestamp: 2026-03-04
  checked: BranchSection.svelte — outer <div> is a plain block with no overflow or width constraint
  found: no overflow, no min-width — but as a block child it fills to parent width; not the primary cause
  implication: not a blocker by itself

- timestamp: 2026-03-04
  checked: RemoteGroup.svelte line 38 — indent wrapper around each BranchRow
  found: `<div style="padding-left: 12px;">` — this is a plain block div, no overflow constraint
  implication: as a block it fills width, so the 12px padding eats into the available space but does NOT prevent overflow from children

- timestamp: 2026-03-04
  checked: BranchRow.svelte lines 23-44
  found: outer <div> is a plain block (no style). Inner role="button" div has `display:flex; align-items:center` but NO: overflow:hidden, white-space:nowrap, text-overflow:ellipsis. The text node on line 43 is a direct flex child with no width constraint.
  implication: THIS is the primary failure site. The flex row will grow to accommodate the text instead of clipping it.

- timestamp: 2026-03-04
  checked: BranchRow.svelte line 43 — text node `{name}{isLoading ? ' …' : ''}`
  found: text is a bare text node inside the flex container — it is NOT wrapped in a <span> with truncation styles
  implication: without whitespace:nowrap + overflow:hidden + text-overflow:ellipsis on a containing element, the browser wraps the text freely

- timestamp: 2026-03-04
  checked: flex child min-width behaviour (CSS spec)
  found: flex children have implicit min-width:auto, which means they size to their content. Without min-width:0 on the flex child, the text node forces the row to expand beyond the container.
  implication: even if overflow:hidden were on the outer div, the flex child's min-width:auto would prevent truncation from kicking in

## Resolution

root_cause: |
  Three missing CSS properties together cause the wrapping:

  1. PRIMARY — BranchRow.svelte: the text node on line 43 is a bare text node inside a display:flex row. The flex row has no overflow:hidden, no white-space:nowrap, and no text-overflow:ellipsis. Because none of these are set, the browser simply wraps the text.

  2. COMPOUNDING — BranchRow.svelte: the flex container (inner role="button" div, lines 24-44) does not set overflow:hidden, so even if child elements tried to clip, the parent would still expand.

  3. COMPOUNDING — RemoteGroup.svelte line 38: the indent wrapper `<div style="padding-left: 12px;">` adds 12px padding but has no overflow:hidden or min-width:0. As a block this is mostly fine, but when BranchRow renders a flex layout inside it, the cascading min-width:auto issue means the flex child never collapses.

fix: (diagnosis only — no changes made)
verification: (diagnosis only)
files_changed: []
