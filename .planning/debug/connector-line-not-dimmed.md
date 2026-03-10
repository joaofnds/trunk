---
status: diagnosed
trigger: "Remote-only ref pills are correctly dimmed at 50% opacity, but the horizontal connector line from the pill to the commit dot is NOT dimmed"
created: 2026-03-09T00:00:00Z
updated: 2026-03-09T00:00:00Z
---

## Current Focus

hypothesis: The connector line is a separate div in CommitRow.svelte that has no access to the remote-only dimming logic which lives entirely inside RefPill.svelte
test: Read both components and trace where opacity is applied
expecting: Connector line div has no opacity/dimming logic; RefPill applies opacity only to its own span elements
next_action: Write findings - root cause confirmed

## Symptoms

expected: When a ref pill is dimmed (remote-only), the connector line from pill to commit dot should also be dimmed to 50% opacity
actual: The connector line stays at full opacity while the ref pill is correctly dimmed
errors: none (visual bug, not an error)
reproduction: Any commit with only remote branch refs (no local branch or tag) shows a dimmed pill but full-opacity connector line
started: Since connector line and dimming were implemented

## Eliminated

(none needed - root cause found on first hypothesis)

## Evidence

- timestamp: 2026-03-09T00:00:00Z
  checked: CommitRow.svelte lines 37-42 - connector line rendering
  found: |
    The connector line is an absolute-positioned div rendered at lines 38-41 of CommitRow.svelte.
    It is a sibling element that renders BEFORE the RefPill component in the DOM.
    It uses `background: var(--lane-{commit.color_index % 8})` for color.
    It has NO opacity property, NO conditional dimming, and NO awareness of ref types.
  implication: The connector line cannot dim itself because it has zero knowledge of whether refs are remote-only.

- timestamp: 2026-03-09T00:00:00Z
  checked: RefPill.svelte - dimming logic
  found: |
    The `isRemoteOnly()` function (line 27) checks if a ref is a RemoteBranch AND no sibling ref is a LocalBranch or Tag.
    The `pillStyle()` function (line 20) applies `opacity: 0.5` as an inline style on the individual `<span>` element.
    This opacity is applied ONLY to the pill's own span element - it is not exposed as a prop, event, or any other mechanism.
  implication: The dimming logic is fully encapsulated inside RefPill and never communicated to the parent CommitRow.

- timestamp: 2026-03-09T00:00:00Z
  checked: CommitRow.svelte line 46 - how RefPill is used
  found: |
    `<RefPill refs={commit.refs} />` - CommitRow passes refs in but gets nothing back.
    No bindable prop, no event dispatch, no callback for dimming state.
  implication: CommitRow has no way to know if RefPill decided to dim its pills.

- timestamp: 2026-03-09T00:00:00Z
  checked: The relationship between connector line div and RefPill in the DOM
  found: |
    The connector line (lines 38-41) is a direct child of the row div.
    The RefPill (line 46) is inside a wrapper div (line 45) that is also a direct child of the row div.
    They are siblings - the connector line cannot inherit opacity from RefPill.
  implication: Even if RefPill applied opacity to its container, the connector line would not be affected since they are separate DOM subtrees.

## Resolution

root_cause: |
  The connector line is rendered as a separate absolute-positioned div in CommitRow.svelte (lines 38-41)
  that is a sibling to the RefPill component. The remote-only dimming logic (`isRemoteOnly()` + `opacity: 0.5`)
  lives entirely inside RefPill.svelte and is applied only to the pill's own `<span>` elements via inline style.

  CommitRow has no mechanism to determine whether the displayed refs are remote-only, so it cannot apply
  matching opacity to the connector line. The `isRemoteOnly` check needs to either:
  (a) be duplicated/extracted so CommitRow can also evaluate it, or
  (b) RefPill needs to expose the dimming state back to CommitRow.

fix: |
  Suggested fix direction: Extract the `isRemoteOnly` logic (or a higher-level "allRefsAreDimmed" check) so that
  CommitRow.svelte can apply the same `opacity: 0.5` to the connector line div when all displayed refs are remote-only.

  The simplest approach: replicate the remote-only check inline in CommitRow.svelte for the connector line.
  Since `commit.refs` is already available in CommitRow, add a derived value like:

  ```ts
  const allRemoteOnly = $derived(
    commit.refs.length > 0 &&
    commit.refs.every(r => r.ref_type === 'RemoteBranch')
  );
  ```

  Then on the connector line div, add: `opacity: ${allRemoteOnly ? 0.5 : 1};`

verification: (not yet applied)
files_changed: []
