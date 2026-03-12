---
status: resolved
trigger: "Clicking the Stash button in the Toolbar does nothing"
created: 2026-03-12T00:00:00Z
updated: 2026-03-12T00:00:00Z
---

## Current Focus

hypothesis: stash_save Tauri command requires a `message` parameter that the frontend does not send
test: compare frontend invocation args with Rust command signature
expecting: parameter mismatch causes silent failure (error swallowed by catch block)
next_action: report root cause

## Symptoms

expected: Clicking Stash button should save a stash of the current working tree changes
actual: Clicking Stash does nothing — no visible effect, no error shown
errors: none visible (errors are swallowed by empty catch block)
reproduction: click Stash button in toolbar
started: unknown

## Eliminated

(none — root cause found on first hypothesis)

## Evidence

- timestamp: 2026-03-12T00:01:00Z
  checked: Toolbar.svelte handleStash function (line 39-45)
  found: calls `safeInvoke('stash_save', { path: repoPath })` — only sends `path`, no `message` param
  implication: missing required parameter

- timestamp: 2026-03-12T00:02:00Z
  checked: stash.rs stash_save Tauri command (line 136-155)
  found: signature is `stash_save(path: String, message: String, ...)` — requires both `path` AND `message`
  implication: Tauri will reject the invoke because `message` is missing from the args object

- timestamp: 2026-03-12T00:03:00Z
  checked: lib.rs invoke_handler registration (line 43)
  found: `commands::stash::stash_save` IS registered — command name is correct
  implication: the command exists and is reachable; the issue is parameter mismatch, not missing registration

- timestamp: 2026-03-12T00:04:00Z
  checked: Toolbar.svelte handleStash error handling (line 42-44)
  found: empty `catch {}` block swallows ALL errors silently
  implication: the Tauri invoke fails with a missing-argument error, but the UI shows nothing

- timestamp: 2026-03-12T00:05:00Z
  checked: stash_pop has the same pattern (line 47-53 in Toolbar.svelte vs line 158-177 in stash.rs)
  found: handlePop sends `{ path: repoPath }` but stash_pop requires `(path: String, index: usize, ...)` — missing `index` param
  implication: Pop button has the same class of bug — missing required parameter

## Resolution

root_cause: |
  The frontend `handleStash` function calls `safeInvoke('stash_save', { path: repoPath })`
  but the Rust `stash_save` command requires TWO parameters: `path: String` and `message: String`.
  The missing `message` parameter causes Tauri to reject the invocation at the IPC layer.
  The error is then silently swallowed by the empty `catch {}` block, making the button
  appear to "do nothing".

  Secondary issue: `handlePop` has the same bug — it omits the required `index: usize` parameter.

fix: (not applied — diagnosis only)
verification: (not applied — diagnosis only)
files_changed: []
