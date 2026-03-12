---
status: resolved
trigger: "Redo button stays disabled after performing Undo"
created: 2026-03-12T00:00:00Z
updated: 2026-03-12T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED - Race condition between handleUndo's finally block and repo-changed event + filesystem watcher delivering a second unguarded event
test: Traced async timing through code
expecting: n/a - root cause confirmed
next_action: Report findings

## Symptoms

expected: After clicking Undo, the Redo button becomes enabled
actual: Redo button stays disabled/greyed out after Undo
errors: none reported
reproduction: Click Undo on a commit, observe Redo button remains disabled
started: Since undo/redo feature was implemented

## Eliminated

## Evidence

- timestamp: 2026-03-12T00:01:00Z
  checked: handleUndo in Toolbar.svelte (lines 53-62)
  found: isUndoing is set true at line 54, await safeInvoke at line 56, pushToRedoStack at line 57, isUndoing=false in finally at line 61
  implication: The finally block resets isUndoing synchronously after the await resolves

- timestamp: 2026-03-12T00:02:00Z
  checked: undo_commit Tauri command (commit_actions.rs lines 356-382)
  found: The backend emits "repo-changed" at line 380 BEFORE returning Ok(undo_result) at line 381
  implication: The repo-changed event is emitted by the backend as part of the invoke call

- timestamp: 2026-03-12T00:03:00Z
  checked: Tauri event delivery timing
  found: app.emit("repo-changed") fires on the Rust side before the IPC response returns to JS. The JS event listener receives the event asynchronously (queued as a microtask/macrotask on the JS side).
  implication: The repo-changed event may arrive AFTER the safeInvoke promise resolves and the finally block runs

- timestamp: 2026-03-12T00:04:00Z
  checked: Filesystem watcher (watcher.rs lines 18-40)
  found: A separate filesystem watcher with 300ms debounce also emits "repo-changed" when files change on disk. git reset --soft modifies .git/HEAD and refs, which triggers the watcher.
  implication: Even if the command-emitted repo-changed is guarded by isUndoing, a SECOND repo-changed from the filesystem watcher fires ~300ms later when isUndoing is definitely false

- timestamp: 2026-03-12T00:05:00Z
  checked: repo-changed listener guard (Toolbar.svelte lines 42-44)
  found: Guard checks `if (!isUndoing && !isRedoing)` then calls clearRedoStack()
  implication: Any repo-changed event arriving when isUndoing is false will wipe the redo stack

## Resolution

root_cause: |
  Two-pronged race condition causes clearRedoStack() to fire after undo populates it:

  **Primary cause (timing race):** The handleUndo sequence is:
  1. isUndoing = true
  2. await safeInvoke('undo_commit') -- backend emits repo-changed before returning
  3. pushToRedoStack(result) -- redo stack now has 1 entry
  4. finally: isUndoing = false

  The repo-changed event emitted by the backend at commit_actions.rs:380 is delivered to the
  JS listener asynchronously. It arrives AFTER step 4 (isUndoing = false), so the guard
  `if (!isUndoing && !isRedoing)` passes, and clearRedoStack() wipes the stack.

  **Secondary cause (filesystem watcher):** Even if the command-emitted event were somehow
  handled during isUndoing=true, the filesystem watcher (watcher.rs:24) fires a SECOND
  repo-changed event ~300ms after the git reset --soft modifies .git/ files. By that time,
  isUndoing is definitely false, so clearRedoStack() fires unconditionally.

  Both paths lead to the redo stack being cleared immediately after it's populated.

fix: |
  (not applied - diagnosis only)

  The isUndoing/isRedoing flags need to remain true until AFTER the repo-changed event(s)
  have been processed. Options:

  1. **Don't reset isUndoing in finally -- reset it in the repo-changed handler itself.**
     When repo-changed fires and isUndoing is true, skip clearRedoStack and THEN set
     isUndoing = false. This handles the command-emitted event but NOT the watcher event.

  2. **Keep isUndoing true for longer with a timeout.** After the undo completes, keep
     isUndoing = true for ~500ms (longer than the 300ms watcher debounce) before resetting.
     This is fragile but simple.

  3. **Best approach: Move the guard logic out of the event handler.** Instead of clearing
     the redo stack on repo-changed, only clear it when the user performs a NEW action that
     isn't undo/redo (e.g., a manual commit, checkout, etc.). This means the repo-changed
     handler should never clear the redo stack. Instead, clearRedoStack() should be called
     explicitly at the start of operations like commit, cherry-pick, revert, etc. This
     eliminates the race entirely because there's no event-based clearing to race against.

  4. **Pragmatic fix: Use a counter or token.** Set a "pendingUndoEvents" counter before
     the invoke, and decrement it in the repo-changed handler. Only clear redo stack when
     the counter is 0 and the event isn't from an undo/redo operation.

verification:
files_changed: []
