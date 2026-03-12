---
status: resolved
trigger: "Cancel button (X) in StatusBar is positioned far right, should be adjacent to progress text"
created: 2026-03-12T00:00:00Z
updated: 2026-03-12T00:00:00Z
---

## Current Focus

hypothesis: .status-text has flex:1 which pushes cancel button to far right
test: inspect CSS on .status-text
expecting: flex:1 causes it to expand and fill all available space
next_action: report diagnosis

## Symptoms

expected: Cancel button (X) appears right after the spinner + progress text
actual: Cancel button is pushed to the far-right edge of the status bar
errors: none (visual/layout issue)
reproduction: trigger any remote operation so remoteState.isRunning is true
started: since implementation

## Eliminated

(none needed — root cause found on first inspection)

## Evidence

- timestamp: 2026-03-12
  checked: StatusBar.svelte layout and CSS
  found: .status-text has `flex: 1` (line 139), causing it to consume all remaining horizontal space in the flex row. The cancel button sits after .status-text in DOM order, so it gets pushed to the far right edge.
  implication: This is the sole cause. The text span expands to fill the bar, relegating the button to the end.

## Resolution

root_cause: `.status-text` has `flex: 1` (line 139 of StatusBar.svelte), which makes it grow to fill all available horizontal space in the `.status-bar` flex container. Since the cancel button comes after `.status-text` in DOM order, it gets shoved to the far-right edge of the bar.
fix: Remove `flex: 1` from `.status-text` (or change it to `flex: none`/`flex: 0 1 auto`). The text will then only take its natural content width, and the cancel button will sit immediately adjacent to it. The `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` properties on `.status-text` should be paired with a `max-width` or kept as-is — the text will just not stretch the full width anymore.
verification: (not applied — diagnose only)
files_changed: []
