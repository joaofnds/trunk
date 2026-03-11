# Pitfalls Research

**Domain:** Desktop Git GUI — adding remote ops, stash, and commit context menu to Tauri 2 + Svelte 5 + Rust
**Researched:** 2026-03-10
**Confidence:** HIGH (based on direct codebase inspection + git2/Tauri API knowledge)

---

## Critical Pitfalls

---

### Pitfall 1: SSH Credential Callback Blocks the Async Runtime

**What goes wrong:** When shelling out to the `git` CLI for push/pull/fetch, the child process inherits no terminal. If git needs an SSH passphrase or HTTPS credentials it cannot find via agent or `.netrc`, it tries to prompt interactively on stdin. With no tty, git hangs indefinitely waiting for input that never comes. Because the shell-out is running inside `spawn_blocking`, the Tokio thread pool thread is permanently blocked. If enough push/pull operations are triggered in parallel, the entire async runtime can stall.

**Why it happens:** `Command::new("git").arg("push")` inside `spawn_blocking` creates a child with inherited stdio. Git's SSH transport calls `ssh-askpass` or reads stdin. In a Tauri app there is no controlling terminal. The process blocks on `stdin.read()` forever. The `spawn_blocking` thread does not time out; it waits as long as the child is alive.

**How to avoid:**
- Pass `-o BatchMode=yes` via `GIT_SSH_COMMAND` or `core.sshCommand` config to force git to fail fast rather than prompt: `GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new`.
- Set `GIT_TERMINAL_PROMPT=0` in the child process environment so git does not attempt interactive HTTPS credential prompts.
- Set `GIT_ASKPASS=/bin/false` (or `GIT_ASKPASS=true` on macOS, which returns success without printing anything) so askpass helper fails silently.
- Wrap the `Command::spawn()` call with a `tokio::time::timeout` at the Tauri command boundary before entering `spawn_blocking`, or use `std::process::Child::wait_timeout` from the `wait-timeout` crate inside `spawn_blocking`.
- Pipe all of stdin, stdout, stderr explicitly (`Stdio::piped()`) so the child never inherits the terminal.

**Warning signs:**
- The push/pull command invoked from Svelte never resolves or rejects — the `safeInvoke` promise hangs.
- The app becomes unresponsive to other commands while a remote op is in flight (signals thread pool saturation).
- The git child process appears in `ps aux` with state `S+` (sleeping, waiting for input).

**Phase to address:** Remote ops implementation phase. This must be solved before any user testing of push/pull.

---

### Pitfall 2: Non-Fast-Forward Push Rejection Looks Like a Generic Error

**What goes wrong:** When a push is rejected because the remote has diverged (non-fast-forward), git exits with code 1 and writes the rejection reason to stderr, not stdout. The rejection message format varies: `! [rejected] main -> main (non-fast-forward)` or `error: failed to push some refs`. If the Rust command maps all non-zero exit codes to `TrunkError { code: "git_error", message: <stderr> }` and the Svelte UI shows only `err.message`, users see raw git stderr text instead of a clear, actionable message.

**Why it happens:** The `Command::output()` pattern captures stdout and stderr as raw `Vec<u8>`. A naive implementation returns `stderr` as the error message unconditionally. But stderr output for a non-fast-forward rejection contains ANSI color codes, `remote:` prefixed lines, and other noise that is not user-friendly.

**How to avoid:**
- Parse the stderr output for specific git rejection patterns. A non-fast-forward rejection always contains the string `"(non-fast-forward)"` or `"(fetch first)"`. Check for these before emitting a generic error.
- Return a structured error code: `TrunkError { code: "push_rejected_non_ff", message: "..." }` so the Svelte UI can show a specific dialog explaining that pull-then-push is needed.
- Strip ANSI escape codes from stderr before including it in error messages (use a simple regex `\x1b\[[0-9;]*m`).
- Keep a separate `push_output` field in the success response (for cases where git exits 0 but writes informational messages to stderr like `remote: Resolving deltas`).

**Warning signs:**
- The error display shows raw text like `! [rejected]   main -> main (non-fast-forward)` with no guidance.
- Users report "push failed" but cannot understand why.
- ANSI color codes appear as literal characters in the UI error message.

**Phase to address:** Remote ops implementation phase. Define the error taxonomy before writing command handlers.

---

### Pitfall 3: SSH Key Discovery Fails on macOS Without ssh-agent Running

**What goes wrong:** `git push` over SSH works in the terminal because the user's ssh-agent has their key loaded. But when Tauri launches the app (especially via `open -a Trunk.app` from Finder), the process does not inherit the user's login shell environment. `SSH_AUTH_SOCK` is not set in the Tauri child process environment, so the ssh-agent socket is not found. Git SSH falls back to looking for keys at `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc. — but on macOS, keys with passphrases are in the keychain, not agent-loadable without the running agent. The push fails with `Permission denied (publickey)`.

**Why it happens:** macOS GUI apps launched from Finder (or via `open`) inherit only a minimal environment from `launchd`, not the interactive shell environment. The `SSH_AUTH_SOCK` socket path is only set for processes descended from the user's login shell. The `tauri::async_runtime::spawn_blocking` inherits Tauri's process environment, not the shell environment.

**How to avoid:**
- Before spawning the git subprocess, read `SSH_AUTH_SOCK` from the running shell: execute `launchctl getenv SSH_AUTH_SOCK` (macOS) to find the socket even when not set in the process environment. Inject the result into the child process env if found.
- Alternatively, set `GIT_SSH_COMMAND` to a wrapper that explicitly passes `-i ~/.ssh/id_ed25519` as a fallback if `SSH_AUTH_SOCK` is absent.
- For the v0.3 milestone, document this as a known limitation and tell users to launch from the terminal (`open /Applications/Trunk.app`) so SSH_AUTH_SOCK is inherited. This is acceptable for a personal tool.
- On macOS, `~/.ssh/config` with `AddKeysToAgent yes` and `UseKeychain yes` can mitigate this by loading keys into agent on first use; but only if the user has configured this.

**Warning signs:**
- Push works when the user runs Trunk from the terminal but fails when launched from Finder/Dock.
- `Permission denied (publickey)` in the git stderr output.
- `SSH_AUTH_SOCK` is not set in the Rust process: check with `std::env::var("SSH_AUTH_SOCK")`.

**Phase to address:** Remote ops implementation phase. Must be verified on macOS with app launched via Finder (not cargo tauri dev).

---

### Pitfall 4: Remote Tracking Branches Not Updated in `CommitCache` After Fetch

**What goes wrong:** After a successful `git fetch`, the remote tracking refs (e.g., `refs/remotes/origin/main`) have moved to new commits. But the `CommitCache` in Tauri state still holds the pre-fetch `GraphResult`. The Svelte UI reads from cache and sees remote branch pills still pointing at old commits. The `BranchSidebar` still shows old remote branch positions. The user has to manually close and reopen the repo to see the updated state.

**Why it happens:** The existing mutation pattern (cache-repopulate-before-emit, established in `commit.rs`) is correct but must be applied to remote ops too. A fetch command that shells out to git CLI performs no git2 mutations — so there is no obvious code path that triggers cache repopulation. It is easy to forget that fetch changes remote ref positions, which the cache must reflect.

**How to avoid:**
- After the `git fetch` subprocess exits with code 0, immediately call `graph::walk_commits` to rebuild the `CommitCache`, then emit `repo-changed` — exactly the same pattern as `create_commit_inner` + `refresh_commit_cache`.
- Also re-call `list_refs_inner` or emit `repo-changed` so the `BranchSidebar` refreshes. The existing `repo-changed` event listener in `App.svelte` calls `handleRefresh()` which increments `refreshSignal`, which triggers `CommitGraph.refresh()`. This should cover the graph. But `BranchSidebar` must also observe `refreshSignal` (or its own event listener) to re-fetch refs.
- Verify that `BranchSidebar.svelte` reacts to `repo-changed` events, not just its own mount lifecycle.

**Warning signs:**
- After fetch, the commit graph shows the correct new commits but remote branch pills still show the old position.
- `git log --oneline origin/main` in the terminal shows new commits that are absent in the Trunk graph.

**Phase to address:** Remote ops implementation phase, specifically fetch handling.

---

### Pitfall 5: `stash_save` vs `stash_push` API Confusion — Staged Changes Behavior

**What goes wrong:** The git2 Rust crate exposes `Repository::stash_save` which is the legacy stash API. It stashes both staged and unstaged changes by default, losing the staged/unstaged distinction (the index is collapsed into the stash). If the user has carefully staged a subset of their changes, stashing with the legacy API discards that staging state. When they pop the stash, everything appears as unstaged modifications.

The `git stash push --keep-index` behavior (which preserves the index) is not directly exposed by `stash_save`. The user might expect Git-like behavior where staged changes can optionally be preserved.

**Why it happens:** `Repository::stash_save` maps to `git stash save`, which is deprecated in favor of `git stash push`. In libgit2, the stash flags `GIT_STASH_KEEP_INDEX` (value `1`) can be passed, but the git2 Rust bindings expose this through `StashFlags::KEEP_INDEX`, which may not be obvious.

**How to avoid:**
- Use `repo.stash_save2(&sig, "WIP", Some(StashFlags::DEFAULT))` for the initial implementation. Explicitly document in code and UI that stashing clears the index.
- Do NOT attempt to implement `--keep-index` in v0.3 unless specifically needed. The complexity is not worth it for an MVP stash feature.
- In the UI: show a clear warning "Stashing will unstage all changes" so users are not surprised.
- Check `git2::StashFlags` in the current `0.19` version of the crate to confirm exact API.

**Warning signs:**
- After stash pop, files that were staged appear as unstaged.
- Users report that stashing "loses" their carefully staged changes.

**Phase to address:** Stash implementation phase.

---

### Pitfall 6: Stash Index Instability — `stash@{0}` Shifts on Every Stash Operation

**What goes wrong:** Git stash uses a LIFO stack. `stash@{0}` always refers to the most recently created stash. When the user creates a new stash, what was `stash@{0}` becomes `stash@{1}`. When the user pops `stash@{0}`, what was `stash@{1}` becomes `stash@{0}`. If the Svelte UI stores a stash by its `stash@{N}` index (which is what the current `RefLabel.short_name` stores), and the user creates or pops a stash between loading the sidebar and triggering a pop action, the pop operation applies to the wrong stash.

**Why it happens:** The `branches.rs` `stash_foreach` callback uses `stash@{idx}` as the `short_name`. This string is display-only, but if any Tauri command takes a stash index as an integer argument and operates on `refs/stash^{N}` by position, the position can shift between the time the list was fetched and the time the command runs.

**How to avoid:**
- The git2 API for stash pop takes an index (`usize`). When the user triggers "Pop stash" on `stash@{0}`, immediately re-fetch the stash list before executing the pop, and verify the OID at that index still matches the OID the user was looking at. If not, abort with an error.
- Alternatively, store the stash OID (not index) in the UI and look it up positionally on the Rust side by scanning the stash list for a matching OID before popping.
- For v0.3 single-stash-slot simplicity: only support creating one stash and always operating on `stash@{0}`. Make this explicit in the UI.

**Warning signs:**
- Users pop the wrong stash after creating a new one.
- The stash list in the sidebar becomes desynchronized with the actual stash stack.

**Phase to address:** Stash implementation phase.

---

### Pitfall 7: Stash Apply vs Pop — Dirty Workdir After Pop Without Drop

**What goes wrong:** `git2` exposes both `stash_apply` (apply without removing from stack) and `stash_pop` (apply and remove). If the pop fails (e.g., merge conflict), git2 may partially apply changes and leave the stash entry still on the stack, or it may have already removed it. The error message from git2 on conflict is `GIT_ECONFLICT`, but this is not guaranteed to mean "the stash was not consumed."

Additionally, if `stash_apply` is used incorrectly instead of `stash_pop`, the stash entry remains after apply. Users who do not notice this accumulate duplicate stash entries.

**How to avoid:**
- Always use `stash_pop` (not `stash_apply`) for the "pop stash" action. This is semantically correct.
- Handle `git2::ErrorCode::MergeConflict` (returned by `stash_pop` when conflicts exist): return error code `stash_conflict` to the frontend. Display a clear message that stash pop had conflicts and the working tree has been partially restored.
- Check whether the stash entry was consumed on conflict: call `stash_foreach` immediately after a failed pop and compare the count before and after. Emit the appropriate state.
- After any stash pop (success or failure), rebuild cache and emit `repo-changed`.

**Warning signs:**
- After a failed pop, the stash list still shows the entry but the working tree has some changes applied.
- After a successful pop, the stash list still shows the entry (stash_apply was used instead of stash_pop).

**Phase to address:** Stash implementation phase.

---

### Pitfall 8: Tauri Native Menu `popup()` Positions at Wrong Coordinates When Window Is Scaled

**What goes wrong:** The existing `showHeaderContextMenu` in `CommitGraph.svelte` calls `menu.popup()` with no position argument, which positions the menu at the current cursor position. This works correctly. However, for a commit row right-click context menu, if the developer passes an explicit `{ x, y }` position from the mouse event, the coordinates must be in physical pixels, not CSS logical pixels. When `document.documentElement.style.zoom` is set (the app uses zoom for scaling), `e.clientX/e.clientY` are in CSS pixels, not physical pixels. On a Retina display at zoom 1.25, physical pixels = CSS pixels × devicePixelRatio × zoom, and passing CSS coordinates causes the menu to appear at the wrong position.

**Why it happens:** Tauri's `menu.popup({ position: { x, y } })` expects physical pixel coordinates. The browser's `MouseEvent.clientX` reports CSS logical pixels. The mismatch is compounded by the app-level `document.documentElement.style.zoom` used for accessibility scaling.

**How to avoid:**
- Use `menu.popup()` with no position argument. Tauri reads the OS cursor position directly, bypassing CSS coordinate transforms entirely. This is already the pattern used in the working header context menu.
- Never pass explicit `x, y` from `e.clientX/e.clientY` to `popup()`. The no-argument form is always correct.
- If an explicit position is ever needed, transform: `physicalX = e.clientX * window.devicePixelRatio * currentZoomLevel`.

**Warning signs:**
- Context menu appears far from where the user right-clicked.
- Offset is proportional to zoom level (larger zoom = larger offset).
- Works correctly at zoom = 1.0 but breaks at other zoom levels.

**Phase to address:** Context menu implementation phase.

---

### Pitfall 9: Context Menu Action on Stale Commit Data (Race Between Menu Open and Repo Change)

**What goes wrong:** The user right-clicks a commit row. While the menu is open (menu.popup() is async), an external git operation changes the repo (e.g., a filesystem watcher fires, `repo-changed` is emitted, the graph refreshes, and the commit at the right-clicked OID is now gone — e.g., after a rebase). The user clicks "Cherry-pick" in the menu. The Tauri command runs with the OID from the now-stale commit, which may no longer exist or may resolve to a different commit.

**Why it happens:** `menu.popup()` is awaited, which means Svelte's reactive updates can fire during the await. If `commits` state is replaced (as it is in `CommitGraph.refresh()`), the `commit` variable captured in the menu action closure may point to a commit object that is no longer in the rendered list.

**How to avoid:**
- Capture the commit OID in a local variable before calling `menu.popup()`. The OID is a string (immutable). Even if the `commits` array is replaced, the OID string captured in the closure is stable.
- In the Rust command handler, validate the OID with `repo.find_commit(oid)` before performing any mutation. If not found, return `TrunkError { code: "commit_not_found", ... }`.
- The existing `safeInvoke` + error code pattern handles this gracefully — the UI just needs to show an appropriate message.

**Warning signs:**
- "Commit not found" errors occurring intermittently on cherry-pick/revert/create-tag.
- Errors more frequent on repos with active file watchers (live coding projects).

**Phase to address:** Context menu implementation phase.

---

### Pitfall 10: Cherry-pick on a Merge Commit — No Clear Error

**What goes wrong:** Cherry-picking a merge commit requires specifying the `-m` (mainline) parent number. Without `-m`, `git cherry-pick` (and libgit2's cherry-pick) fails with an error about merge commits requiring mainline specification. If the context menu does not disable "Cherry-pick" for merge commits, users click it and get a confusing error from git2 that says "Commit is a merge commit" or similar, with no guidance about what `-m` means or how to proceed.

**Why it happens:** git2's `Repository::cherrypick` has a `cherrypick_opts` parameter including `mainline: u32`. A value of 0 means "not specified" and will fail for merge commits. Developers implementing cherry-pick often test only on regular commits and miss the merge commit case.

**How to avoid:**
- Disable the "Cherry-pick" menu item when `commit.is_merge` is true. The `GraphCommit` struct already includes `is_merge: bool`. Use `MenuItem::new({ enabled: !commit.is_merge, ... })` for the cherry-pick item.
- Display a tooltip or use a separator label like "Cherry-pick (not available for merge commits)" rather than silently disabling.
- If cherry-pick of merge commits is desired in the future, add a separate "Cherry-pick (with mainline)" action.

**Warning signs:**
- Users report "cherry-pick fails on some commits."
- Errors come from the Rust side with git2 error code `GIT_EINVALIDSPEC` or similar.

**Phase to address:** Context menu implementation phase (menu item state management).

---

### Pitfall 11: Revert on a Merge Commit — Same `mainline` Issue

**What goes wrong:** Same as cherry-pick. `Repository::revert` (and `git revert`) on a merge commit requires `-m mainline`. Without it, git2 returns an error. The context menu should disable or handle revert on merge commits the same way as cherry-pick.

**How to avoid:**
- Disable "Revert" for `commit.is_merge === true` in the same way as cherry-pick.
- Both cherry-pick and revert share this constraint — implement the disabled state check once in a shared helper.

**Phase to address:** Context menu implementation phase.

---

### Pitfall 12: Async Tauri Command Triggered From Menu Item — No Loading State

**What goes wrong:** Menu item actions in Tauri (`@tauri-apps/api/menu` item callbacks) are synchronous callback functions. When an async Tauri command is triggered from a menu item (e.g., cherry-pick, revert, create branch from commit), the callback fires and returns immediately. The async IPC call runs in the background. There is no loading indicator, and if the user clicks the same menu item again or performs another operation before the first completes, a race condition occurs.

Additionally, cherry-pick and revert are slow operations on large repos (they run a full merge computation). The user may think the app is frozen.

**How to avoid:**
- Use the existing `sequence counter` pattern from the codebase (incremented before the IPC call, checked on completion). If the sequence counter has advanced when the response arrives, discard the result.
- Set a `loading` state in the Svelte component before the `safeInvoke` call. Disable the commit row right-click (or show a spinner overlay) while loading.
- Use a `pendingOperation = $state<string | null>(null)` variable: set it to `"cherry-pick"` before the call, null after. The menu can check this to disable itself.
- The menu is already dismissed after the user clicks an item, so the second-click problem is limited to rapid successive right-clicks. The sequence counter guards against this.

**Warning signs:**
- Clicking cherry-pick twice on the same commit creates two cherry-pick commits.
- App appears frozen during revert/cherry-pick with no feedback.

**Phase to address:** Context menu implementation phase.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Shell out to `git` CLI for push/pull without timeout | Simpler implementation | Hung threads block the runtime | Never — always set `GIT_TERMINAL_PROMPT=0` and a timeout |
| Return raw git stderr as error message | Zero parsing needed | Raw ANSI text shown to users | Never — at minimum strip ANSI codes and detect common patterns |
| Use stash index (integer) as stable identifier | Simple API call | Pop wrong stash after concurrent modification | Acceptable for v0.3 if single-stash workflow is documented |
| Disable cherry-pick/revert for merge commits rather than supporting `-m` | Avoids complex mainline selection UI | Feature gap | Acceptable for v0.3 — add proper support in v0.4 |
| `menu.popup()` with no position (cursor-relative) | Correct positioning without coordinate math | Cannot pin menu to specific UI element | Acceptable — OS cursor position is always correct |
| Emit `repo-changed` once for all mutations | Simplicity | Over-refreshes (graph + refs) on fetch | Acceptable — refresh is fast; optimization can come later |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| git CLI subprocess | Inherit parent stdio, no timeout | `Stdio::piped()` on all streams + `wait_timeout` |
| git CLI subprocess | Trust exit code 0 means clean success | Also check stderr for `remote:` warnings and `!` rejection lines |
| git2 stash_save | Pass `StashFlags::DEFAULT` only | Check if `KEEP_INDEX` flag is needed; document behavior in UI |
| git2 stash_pop | Ignore error on merge conflict | Check `git2::ErrorCode::MergeConflict`, report conflict state, rebuild cache |
| Tauri Menu API | Pass `e.clientX/Y` to `popup({ position })` | Use `popup()` with no arguments — reads OS cursor directly |
| Tauri Menu API | Build menu synchronously, show stale state | Build menu items with current `commit.is_merge` state fresh on each right-click |
| Cache after remote ops | Forget to repopulate `CommitCache` after fetch | Always run `walk_commits` + `cache.insert` + emit `repo-changed` after any mutation |
| BranchInfo `ahead`/`behind` | Leave as `0` (already zero in current code) | For v0.3 scope, this is intentional — add actual ahead/behind counts in v0.4 |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Blocking main thread on `git push` | UI freezes during push | Always use `spawn_blocking` — this is already the pattern | Immediately if done on async thread |
| Rebuilding `CommitCache` on every fetch even with no new commits | Unnecessary work on `git fetch --dry-run` equivalent | Check if fetch returned new objects before rebuilding; or just always rebuild (fast enough for typical repos) | Not a real problem until repo has 100k+ commits |
| Menu item `Promise.all` for building all menu items | Slow menu open on repos with many refs | Build static menu items first; dynamic items (branch list) can be a submenu built lazily | Breaks at 100+ refs if building one MenuItem per ref |
| `stash_foreach` inside a command that already holds the Mutex | Deadlock | Use the inner-fn pattern — lock once, pass data; never re-lock | Any time a command calls list_refs_inner which calls stash_foreach while the outer lock is held |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Pass arbitrary repo-provided remote URL to `git push` without validation | SSRF via `git://evil.internal` if user opens a malicious repo | Validate that the remote URL is in an allowed scheme list (`https://`, `git@`, `ssh://`) before shelling out; display the remote URL in confirmation dialog |
| Log or display SSH private key paths in error messages | Key path exposure in crash logs | Sanitize any error that contains `~/.ssh/` paths in user-visible output |
| Pass user-entered branch name to `git push` shell argument without quoting | Shell injection if branch name contains spaces or special chars | Use `Command::arg()` with separate arguments (not shell string), which avoids injection entirely since exec replaces the process |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No progress feedback during push/pull | Users think the app is frozen during slow network operations | Show an inline status indicator ("Pushing...") in the toolbar or a toast; emit intermediate `push_progress` events from Rust if possible |
| "Push rejected" with no actionable guidance | Users do not know they need to pull first | Detect non-fast-forward code and show "Pull first, then push" with a button to trigger pull |
| Stash creates without confirmation when workdir is clean | Creates an empty stash entry | Check `is_dirty` before stashing; if clean, show "Nothing to stash" rather than creating an empty stash |
| Context menu appears on WIP row | WIP row is synthetic (`oid === '__wip__'`); cherry-pick/revert/create-tag on WIP makes no sense | Exclude WIP row from right-click context menu entirely, or show a read-only "Uncommitted changes" label |
| "Create branch from commit" always checks out the new branch | Unexpected HEAD change if user just wanted to mark the commit | Ask or provide option: "Create only" vs "Create and checkout" |
| Fetch vs Pull confusion | Users think fetch updates their branch but it only updates remote tracking refs | Clear labels: "Fetch" = "Download remote changes (no merge)"; "Pull" = "Fetch + merge into current branch" |

---

## "Looks Done But Isn't" Checklist

- [ ] **Remote fetch:** Verify remote tracking branch pills in commit graph move to new positions after fetch, not just the sidebar branch list.
- [ ] **Remote push:** Verify that the local branch's upstream tracking info is updated after push (the `ahead/behind` count resets to 0/0).
- [ ] **Stash create:** Verify working tree is clean after stash (all tracked modifications gone), not just that the stash list entry appears.
- [ ] **Stash pop:** Verify the stash entry is removed from the stash list AND the working tree changes are restored.
- [ ] **Stash on unborn HEAD:** Test what happens if user tries to stash in a repo with no commits — git2's `stash_save` requires at least one commit. Return a clear error.
- [ ] **Cherry-pick:** Verify the new commit appears at HEAD and the graph refreshes — commit cache repopulation must happen.
- [ ] **Revert:** Same as cherry-pick — verify a new revert commit appears (revert does not undo the history, it adds a new commit).
- [ ] **Context menu on merge commit:** Verify cherry-pick and revert items are disabled (grayed out), not hidden — hidden items are confusing.
- [ ] **Context menu on WIP row:** Verify no context menu appears (or a WIP-specific one with only relevant actions).
- [ ] **SSH push from Finder-launched app:** Test push from a freshly launched .app bundle, not from `cargo tauri dev` (different environment).
- [ ] **HTTPS push:** Test with a repo using HTTPS remote — must fail gracefully with `GIT_TERMINAL_PROMPT=0` rather than hanging.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Hung push/pull thread (Pitfall 1) | HIGH | Kill the app; the child git process may need manual `kill`; add timeout before shipping |
| Wrong stash popped (Pitfall 6) | MEDIUM | Use `git stash list` + `git stash apply stash@{N}` in terminal to recover; educate users about stash indexing |
| Cache not refreshed after fetch (Pitfall 4) | LOW | Close and reopen the repo; no data loss |
| Cherry-pick/revert conflict on stash pop | MEDIUM | User resolves in terminal; Trunk shows conflict state in staging panel |
| Menu shows at wrong position (Pitfall 8) | LOW | Switch from explicit position to `popup()` with no arguments |
| Merge commit cherry-pick error (Pitfall 10) | LOW | Add `enabled: !commit.is_merge` guard; no data consequences |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| SSH blocking stdin (P1) | Remote ops: subprocess wrapper | Test with no SSH agent; verify command resolves within 5 seconds |
| Non-FF push UX (P2) | Remote ops: error taxonomy | Push to a repo with diverged history; verify actionable error appears |
| SSH key discovery (P3) | Remote ops: environment setup | Test by launching .app from Finder on macOS with SSH remote |
| Cache stale after fetch (P4) | Remote ops: fetch command | Verify graph updates remote ref pill positions immediately after fetch |
| stash_save staged behavior (P5) | Stash: create implementation | Stage a file, stash, pop — verify file returns to staged state (or document limitation) |
| Stash index instability (P6) | Stash: pop implementation | Create 2 stashes, pop stash@{1} — verify correct stash is removed |
| stash_pop on conflict (P7) | Stash: pop error handling | Introduce a conflict before popping; verify error code and working tree state |
| Menu position with zoom (P8) | Context menu: positioning | Test at zoom 1.5 — menu must appear at cursor |
| Stale commit on menu action (P9) | Context menu: OID capture | Trigger repo-changed between right-click and action; verify correct OID used |
| Cherry-pick on merge commit (P10) | Context menu: item state | Right-click a merge commit; verify cherry-pick is disabled |
| Revert on merge commit (P11) | Context menu: item state | Same as cherry-pick — same test |
| Async menu action no loading state (P12) | Context menu: feedback | Trigger slow operation (large revert); verify UI shows loading state |

---

## Sources

- Codebase inspection of `branches.rs`, `commit.rs`, `error.rs`, `state.rs`, `App.svelte`, `CommitGraph.svelte`, `types.ts`, `invoke.ts`, `Cargo.toml` (HIGH confidence — direct source analysis)
- git2 Rust crate documentation — `stash_save`, `stash_pop`, `StashFlags`, `cherrypick`, `revert` (HIGH confidence — official API)
- Tauri 2 `@tauri-apps/api/menu` — `Menu.new`, `MenuItem.new`, `menu.popup()` position behavior (HIGH confidence — existing working usage in codebase at `CommitGraph.svelte` line 98-99)
- git subprocess credential handling — `GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`, `GIT_SSH_COMMAND`, `BatchMode` SSH option (HIGH confidence — git documentation)
- macOS SSH agent environment inheritance — `launchctl getenv SSH_AUTH_SOCK` pattern (MEDIUM confidence — macOS-specific, known pattern in Electron/Tauri apps)
- git non-fast-forward rejection stderr format — `! [rejected]` pattern (HIGH confidence — git behavior documented and stable)

---

*Pitfalls research for: v0.3 Actions — remote ops, stash, commit context menu on Tauri 2 + Svelte 5 + git2*
*Researched: 2026-03-10*
