# Domain Pitfalls

**Domain:** Tauri 2 + Rust + git2 desktop Git GUI
**Researched:** 2026-03-03
**Confidence note:** Web search unavailable during this research session. All findings are from training knowledge (cutoff August 2025). Confidence levels reflect source quality within that constraint. Critical claims are flagged where independent verification is recommended.

---

## Critical Pitfalls

Mistakes that cause rewrites, deadlocks, or fundamental architectural breakage.

---

### Pitfall 1: `Repository` Is Not `Sync` — Mutex Contention and Deadlocks

**What goes wrong:** `git2::Repository` is `Send` but NOT `Sync`. It cannot be shared between threads concurrently. The natural instinct is to wrap it in `Arc<Mutex<Repository>>` inside Tauri managed state. This works — but every Tauri command handler that touches the repository locks the mutex for the entire duration of the operation. Long-running operations (walking 10k commits, computing a large diff) block all other commands for that repo.

**Why it happens:** Developers model the repository as a simple shared resource and don't account for Tauri's async command handlers running on a thread pool. A slow `repo.revwalk()` iteration holds the lock while the UI is trying to refresh status from a filesystem event — UI freezes.

**Consequences:**
- UI hangs while large history loads
- Filesystem watcher events queue up behind a locked mutex
- Status refreshes, diff loads, and history loads serialize entirely — destroying perceived responsiveness
- Deadlock if a command accidentally acquires two different Mutex guards in different order

**Prevention:**
- Perform heavy git2 operations (revwalk, large diffs) by cloning or re-opening the Repository per operation rather than holding a single shared handle. `Repository::open()` is fast (microseconds); clone is expensive. Re-open per heavy operation on a spawn_blocking thread.
- Keep the shared `Mutex<Repository>` only for quick mutation operations (stage/unstage, commit). Use `Repository::open()` fresh for read-heavy scans.
- Or: structure managed state as `Mutex<Option<PathBuf>>` (just the path) and open a fresh `Repository` inside each command's `spawn_blocking` call.
- Never hold a `MutexGuard` across an `.await` point (Rust will catch this at compile time with async mutexes, but Tauri's `Mutex` is `std::sync::Mutex` — a blocking lock inside an async handler is valid Rust but bad practice).

**Detection:**
- UI becomes sluggish when loading repos with >5k commits
- Commands that should be instant (get status) feel slow when history is loading
- Any `tauri::async_runtime::spawn_blocking` call that takes >50ms

**Phase:** Address in Phase 1 (repository open + history loading). Wrong architecture here forces a rewrite of all command handlers.

---

### Pitfall 2: Sending git2 Types Across the Tauri IPC Boundary — Lifetime and Serialization Traps

**What goes wrong:** `git2` types like `Commit<'repo>`, `Diff<'repo>`, `Tree<'repo>` all carry a lifetime tied to the `Repository` they came from. You cannot store them, return them from functions that outlive the repo borrow, or send them across threads. New Rust developers try to build a `struct CommitGraph { commits: Vec<Commit<'repo>> }` and immediately hit lifetime errors that feel unsolvable.

**Why it happens:** The git2 API is designed for short-lived access patterns ("borrow the repo, get the commit, extract what you need, drop"). It is not designed for caching git objects.

**Consequences:**
- Hours of fighting borrow checker with unsolvable lifetime errors
- Attempted workaround with `unsafe` transmute of lifetimes — undefined behavior
- Architecture pivot mid-implementation

**Prevention:**
- Immediately convert git2 types to owned, serializable Rust structs at the point of access. Never store `Commit<'repo>` — store `CommitInfo { oid: String, summary: String, author: String, timestamp: i64 }`.
- Define your DTO layer (Rust structs that implement `serde::Serialize`) in a separate module early. All git2 access goes through a translation function: `fn commit_to_dto(c: &Commit) -> CommitInfo`.
- Use `Oid::to_string()` immediately; never store `Oid` in a long-lived struct if it came from a temporary borrow.

**Detection:**
- Compiler error: "lifetime 'repo does not live long enough" when trying to store git2 objects
- Any `struct` that tries to hold a `git2::*<'_>` field

**Phase:** Establish the DTO pattern in Phase 1 before writing any git2 code. One wrong struct definition propagates everywhere.

---

### Pitfall 3: Virtual Scrolling Scroll Position Desynchronization

**What goes wrong:** In a virtual scroll implementation, the true list height is faked with a spacer element (`height: total_rows * ROW_HEIGHT`). The scroll handler calculates `startIndex = Math.floor(scrollTop / ROW_HEIGHT)`. This works until: (1) CSS resets `box-sizing`, (2) the row height isn't exactly an integer pixel, (3) browser zoom changes the effective pixel density, or (4) the spacer height hits browser limits (~33 million pixels — about 330k commits at 100px rows).

**Why it happens:** Row height seems like a constant but is actually a CSS-computed value. `getComputedStyle` is needed to get the true value, which changes with zoom, font scaling, and screen DPI.

**Consequences:**
- Scrolling to a specific commit (e.g., HEAD) lands on the wrong row
- Graph lanes and commit rows fall out of vertical alignment
- Browser tab crashes or silent height clamping with huge repos (>330k commits)

**Prevention:**
- Define `ROW_HEIGHT` as a CSS custom property (`--row-height: 28px`) AND as a matching JS/Svelte constant. Never compute row height dynamically in the scroll math — keep it fixed.
- Use integer pixel values only (28px, 32px, not 28.5px).
- For repos that could have >300k commits, use a two-level virtual scroll or page the history rather than one giant virtual list.
- Always use `overscanCount` of 5-10 rows above and below the viewport to avoid flash-of-empty during fast scrolling.
- Test at 110%, 125%, 150% browser zoom.

**Detection:**
- Clicking a commit in the list graph highlights the wrong commit row
- `scrollTop / ROW_HEIGHT` produces a fractional index that requires `Math.floor` but loses precision
- Any test at non-100% zoom shows misalignment

**Phase:** Address in the commit history display phase. The scroll math must be validated before SVG lane rendering is layered on top.

---

### Pitfall 4: SVG Lane Graph Coordinate Mismatch with Virtual Scroll

**What goes wrong:** With inline SVG per row (one `<svg>` element per commit row), the SVG for row N needs to know which lane column each commit occupies AND it needs to draw connector lines that span to the SVG of row N+1 and N-1. When virtual scrolling recycles DOM nodes, the SVG in slot 0 of the DOM might be rendering commit #47 one moment and commit #52 the next. If graph data is indexed by DOM position rather than by commit index, lane lines connect to the wrong commits.

**Why it happens:** Developers index graph data by DOM position (the rendered slot index) instead of by absolute commit index. When the user scrolls and the virtual window shifts, the mapping breaks.

**Consequences:**
- Branch connector lines visually "jump" or point to wrong commits during scrolling
- Graph is only correct at the top of the list (where DOM index == commit index)
- Hard to debug — looks fine in small repos, breaks at scroll position 50+

**Prevention:**
- The Rust lane algorithm must emit lane assignments indexed by absolute commit position (0 = oldest rendered commit, not 0 = top of DOM). Each `CommitInfo` row carries its own `lane_index`, `connections_in: Vec<LaneConn>`, `connections_out: Vec<LaneConn>`.
- In Svelte, bind SVG rendering to `commit.absolute_index`, not to the DOM slot index.
- The Svelte virtual scroll component must pass the absolute commit index (not the rendered position) to each SVG row component.
- Draw vertical connectors as SVG elements that extend slightly beyond the row bounds (e.g., top and bottom by half a row height), so they visually connect across row boundaries even though they are in separate SVG elements.

**Detection:**
- Lane lines jump when scrolling past the first viewport of commits
- Graph correct when `startIndex == 0`, broken when `startIndex > 0`
- SVG connector lines do not meet at row boundaries after scrolling

**Phase:** Address in the commit graph lane rendering phase. The absolute-index requirement must be in the Rust lane algorithm from the start.

---

### Pitfall 5: `notify` Watcher Firing on its Own Write Operations

**What goes wrong:** When Tauri's Rust backend writes to the git repository (staging a file updates `.git/index`, creating a commit updates `.git/HEAD` and `.git/refs/`), the `notify` filesystem watcher fires events for those writes. The event handler then triggers a status refresh, which reads the repo, which may trigger another event — an event loop.

**Why it happens:** The watcher watches the repo root including `.git/`. Every git operation writes to `.git/`. Without filtering, every `stage file` command causes: write index → watcher fires → status refresh IPC → UI re-renders → (no loop here, but expensive).

**Consequences:**
- Status refreshes fire after every command, even when the UI already knows the new state (it just caused it)
- With debounce set too low (50ms), status refreshes can fire mid-command while the index is in an inconsistent state
- On macOS, FSEvents batches events — you get one event covering the whole git operation. On Linux (inotify), you get one event per file write, so a single commit can fire 10+ events.

**Prevention:**
- Watch only the working tree directory, NOT `.git/` internals. If you must watch `.git/` (for branch changes from external git commands), filter out `.git/index` and `.git/COMMIT_EDITMSG` from event paths.
- Alternatively: watch `.git/HEAD`, `.git/refs/`, and the working tree separately with different handlers.
- Always debounce at 300ms minimum (per PROJECT.md decision — correct). After any command that the Rust backend itself initiates, suppress the next N watcher events for 500ms using a flag or timestamp.
- The debouncer-mini crate chosen (notify-debouncer-mini 0.5) correctly coalesces events — but the debounce window must be larger than the longest git write operation (a large commit can take 100-200ms).

**Detection:**
- Status panel flickers after staging a file (multiple re-renders)
- Console shows duplicate "status refreshed" events after a single user action
- On Linux, status refresh fires 5-10 times after a single stage operation

**Phase:** Address in filesystem watching phase. This cannot be "fixed later" — the event loop causes visible UI churn from day one.

---

## Moderate Pitfalls

### Pitfall 6: Tauri Command Error Types Not Serializable

**What goes wrong:** Tauri `#[tauri::command]` functions must return `Result<T, E>` where both `T` and `E` implement `serde::Serialize`. `git2::Error` does NOT implement `Serialize`. Returning `Result<T, git2::Error>` from a Tauri command causes a compile error that is confusing to diagnose if you don't know the constraint.

**Prevention:**
- Define a project-wide `AppError` enum that implements `serde::Serialize` and `thiserror::Error`. All Tauri commands return `Result<T, AppError>`. Map `git2::Error` to `AppError` with `?` and `From<git2::Error> for AppError`.
- Include an error `code` field (snake_case string) alongside the message so the frontend can branch on error type without string matching. Per PROJECT.md: `dirty_workdir` is the example pattern — extend this to all errors.
- Example: `AppError::DirtyWorkdir`, `AppError::NotARepo`, `AppError::DetachedHead`, `AppError::BranchNotFound`.

**Detection:**
- Compile error: "the trait `serde::Serialize` is not implemented for `git2::Error`" on a Tauri command return type

**Phase:** Phase 1 — define `AppError` before the first command is written.

---

### Pitfall 7: Svelte 5 Runes — Reactive State with Object Mutation

**What goes wrong:** In Svelte 5, `$state()` tracks assignments, not mutations. If you have `let commits = $state([])` and then do `commits.push(newCommit)`, Svelte 5 WILL detect this (arrays are deeply reactive via Proxy). But if you have `let repo = $state({ status: [] })` and you do `repo.status = fetchedStatus` followed immediately by `repo.otherProp = x` in the same synchronous block, you get two reactive updates. More subtly: if you store a plain object returned from Tauri invoke (not a class instance), nested mutations work. If you wrap that object in a class, mutations to the class's properties may not be tracked.

**Why it happens:** Svelte 5's reactivity model is explicit: `$state` wraps objects in a Proxy. Developers coming from Svelte 4 expect `$: reactive` statement semantics and are surprised that `$derived` requires a function, not a reactive variable reference.

**Consequences:**
- UI does not update after data changes (under-reactivity)
- Double renders when multiple state updates happen synchronously (batching is automatic in Svelte 5 but can be surprising)
- `$derived` values not updating when they should — usually because the dependency is accessed inside a conditional that short-circuits

**Prevention:**
- Keep Tauri invoke results as plain objects — do not wrap in classes.
- For the commit list: use `let commits = $state<CommitInfo[]>([])` and replace the whole array (`commits = newCommits`) rather than mutating. This is clearer and more predictable.
- Use `$derived.by(() => ...)` for derived values with complex dependencies.
- Test reactive chains with Svelte's built-in `tick()` in unit tests.

**Detection:**
- Clicking a branch does not update the commit list even though the Tauri invoke completed
- Adding console.log shows data arrived but UI didn't re-render
- `$derived` value is stale after state update

**Phase:** Phase 1 UI setup. Establish reactive patterns before building complex state.

---

### Pitfall 8: Tauri `invoke` Error Handling — Frontend Swallows Errors

**What goes wrong:** `await invoke('command')` rejects with a string (the serialized `AppError`) if the Rust command returns `Err(...)`. Frontend developers often write `const result = await invoke(...)` without a try/catch, or catch only `Error` objects (not strings). Tauri rejects with a string, not an `Error` instance, so `catch(e) { e.message }` returns `undefined`.

**Why it happens:** Tauri's IPC serializes errors as strings by default. Developers expect rejected Promises to carry `Error` objects.

**Consequences:**
- Errors from git2 silently disappear
- Checkout failure (dirty workdir) shows no UI feedback
- Hard to debug because `console.error(e)` logs the string correctly but `e.message` is undefined

**Prevention:**
- Create a typed `invoke` wrapper that parses the error string and returns a typed error object:
  ```typescript
  async function gitInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await invoke<T>(cmd, args);
    } catch (e: unknown) {
      // e is a string from Tauri — parse it or wrap it
      throw new GitError(typeof e === 'string' ? e : JSON.stringify(e));
    }
  }
  ```
- Define `GitError` with a `code` field so frontend can `switch (e.code)` for contextual UI.
- If `AppError` serializes as `{ code: string, message: string }`, parse with `JSON.parse(e as string)`.

**Detection:**
- git operations fail silently in UI
- `catch(e) { console.log(e.message) }` logs `undefined`

**Phase:** Phase 1 — create the invoke wrapper before any commands are wired up.

---

### Pitfall 9: git2 Revwalk Sorting and Topological Ordering

**What goes wrong:** `repo.revwalk()` with `SORT_TOPOLOGICAL` is essential for correct lane graph rendering — commits must appear after all their descendants. Developers who use only `SORT_TIME` get a chronologically correct list but one where a merge commit can appear before some of its parents, breaking the lane algorithm's assumption that parents always appear later in the list.

**Why it happens:** `SORT_TIME` feels natural (most recent first) and is what most users expect visually. But pure time sorting breaks graph topology with clock skew and rebased branches.

**Consequences:**
- Lane algorithm produces incorrect branch lines
- Merge commits appear orphaned (no visible parent connections)
- Clock-skewed repos (common in CI systems, cross-timezone teams) produce completely wrong graphs

**Prevention:**
- Always use `SORT_TOPOLOGICAL | SORT_TIME` in combination. This gives topological correctness while breaking ties by timestamp.
- Document this in the revwalk setup code as a comment explaining why both flags are needed.
- Test with repos that have clock-skewed commits (create test fixtures with force-set author dates).

**Detection:**
- Graph looks correct on linear repos, breaks on repos with merges
- A commit appears in the list before one of its direct parents

**Phase:** Phase 1 — commit history loading. Enforce from the first revwalk implementation.

---

### Pitfall 10: Cross-Platform Path Handling — Windows Path Separators

**What goes wrong:** `git2` returns paths with forward slashes on all platforms (POSIX paths internally). The Rust backend constructs `PathBuf` from these, which is correct. But when paths are serialized as strings across the Tauri IPC to JavaScript, and then the JS frontend constructs a path for display or for sending back to Rust, Windows users may encounter backslash vs forward-slash mismatches. Additionally, `Repository::open()` on Windows with a UNC path (`\\server\share\repo`) may fail.

**Prevention:**
- In Rust: always use `PathBuf` and `Path` — never string concatenation for paths.
- When serializing paths to the frontend, use `.to_string_lossy()` or `.display().to_string()`. On Windows, `PathBuf::display()` uses backslashes. If the frontend needs to send a path back to Rust, accept it as a string and re-parse with `PathBuf::from()`.
- Do not compare path strings across the IPC boundary (e.g., `selectedFile === diff.path`) — normalize to forward slashes in JS: `path.replace(/\\/g, '/')`.
- Test on Windows with paths containing spaces and non-ASCII characters.

**Detection:**
- File status shows files as modified when they aren't (path comparison mismatch)
- `diff.path` from Rust doesn't match `status.path` — one has backslashes, one has forward slashes

**Phase:** Phase 1 — file status display. Path mismatch bugs are invisible on macOS/Linux.

---

### Pitfall 11: Large Diff Payloads Blocking the IPC

**What goes wrong:** A single file diff for a large generated file (e.g., `package-lock.json`, a minified bundle, a large SQL migration) can be hundreds of kilobytes or megabytes of text. Tauri's IPC serializes this as a JSON string, which must be allocated in Rust, serialized to JSON, sent through the webview IPC bridge, deserialized in JavaScript, and then diffed line-by-line in the UI. At 1MB+, this visibly blocks the UI.

**Prevention:**
- Cap diff output at a configurable line count (e.g., 2000 lines) with a "diff too large — show anyway?" prompt.
- Use git2's `DiffOptions` to set `max_size` to cap the diff for any single file.
- The diff Tauri command should accept `{ truncate_at: number }` and return `{ lines: DiffLine[], truncated: boolean }`.
- For the initial MVP, apply a hard limit (5000 lines, 500KB) — large diff viewing can be a v0.2 feature.

**Detection:**
- Clicking a commit on `package-lock.json` changes freezes the UI for 1-2 seconds
- IPC payload size >500KB in devtools

**Phase:** Phase with diff display. Add limits before the feature ships, not after user reports.

---

### Pitfall 12: `notify` Watcher Not Working in macOS Sandboxed App

**What goes wrong:** Tauri 2 on macOS uses App Sandbox by default in production (required for App Store distribution, optional for direct distribution). The `notify` crate uses FSEvents on macOS, which requires the app to have entitlements to watch paths outside its container. Watching `/Users/alice/projects/my-repo` from a sandboxed app requires the user to explicitly grant access, and even then FSEvents may not fire for paths the app didn't open through the OS file picker.

**Why it happens:** macOS sandbox restricts filesystem access. The file dialog grants a security-scoped bookmark, but filesystem event subscription is a separate permission.

**Consequences:**
- Auto-refresh works perfectly in `tauri dev` (unsandboxed), breaks in production build
- No errors in logs — watcher silently receives no events
- Hard to reproduce in development

**Prevention:**
- For v0.1: distribute without App Store sandboxing (`"bundle" > "macOS" > "entitlements"` without strict sandbox). This is standard for developer tools (GitKraken, Fork, Tower all do this).
- Add `com.apple.security.files.user-selected.read-write` and `com.apple.security.files.bookmarks.document-scope` to entitlements.
- If sandboxing is required later, use security-scoped bookmarks from the open-folder dialog and pass the bookmark's URL to the notify watcher.
- Test the production `.app` build specifically for watcher functionality — `tauri dev` and `tauri build` behave differently.

**Detection:**
- Auto-refresh works in `npm run tauri dev`, stops working in `npm run tauri build`
- macOS Console.app shows no FSEvents for the watched path from the built app

**Phase:** Filesystem watching phase. Must test production build, not just dev.

---

### Pitfall 13: `git2` `Signature` Requires Name + Email — No Fallback to Global Git Config by Default

**What goes wrong:** `git2::Signature::now(name, email)` requires explicit name and email. It does NOT automatically fall back to the user's global `~/.gitconfig`. When creating a commit, you must explicitly call `repo.signature()` (which reads `.git/config` then `~/.gitconfig`) rather than hardcoding or prompting. Developers who skip `repo.signature()` break commit authorship for users whose name/email is only in global config.

**Prevention:**
- Always use `repo.signature()` (reads all config levels). Only fall back to prompting the user if `repo.signature()` returns `Err` (no git config set up at all — rare but possible on fresh systems).
- `repo.signature()` respects `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` environment variables as well — correct behavior for CI environments.

**Detection:**
- Commits created by the app show wrong author (empty name or hardcoded test value)
- `git log --format="%an <%ae>"` shows blank or incorrect for commits made through the app

**Phase:** Commit creation phase.

---

## Minor Pitfalls

### Pitfall 14: Svelte 5 Component Props — `$props()` Destructuring Loses Reactivity

**What goes wrong:** In Svelte 5, `let { commits } = $props()` destructures props into local variables. If the parent updates `commits`, the child does NOT see the update because the destructured variable is not reactive. You must use `let { commits } = $props()` and then use `commits` directly in the template — NOT assign it to another variable.

**Prevention:**
- Never do `let localCommits = commits` inside a component — use `commits` directly from `$props()` destructuring.
- For derived values from props, use `let derived = $derived(someTransform(commits))`.

**Detection:**
- Parent updates a prop but child component shows stale data
- Works if parent and child are merged into one component

**Phase:** Any phase with component composition.

---

### Pitfall 15: `git2` Index Operations Require Explicit Write-Back

**What goes wrong:** `repo.index()` returns a reference to the index. Calling `index.add_path()` modifies the in-memory index but does NOT write to `.git/index` until `index.write()` is called explicitly. Developers who skip `index.write()` see staging "succeed" (no error) but the file isn't actually staged.

**Prevention:**
- Always call `index.write()` after any index modification.
- Structure the staging function as: `open index → modify → write → drop index`. Use RAII scoping to ensure write happens.

**Detection:**
- `stage_file` command returns `Ok(())` but file remains unstaged in `git status`
- Only reproducible if you check the actual git state (run `git diff --cached` in terminal)

**Phase:** Staging implementation phase.

---

### Pitfall 16: Tauri 2 App Handle Ownership in Async Commands

**What goes wrong:** In Tauri 2, `#[tauri::command] async fn my_cmd(app: tauri::AppHandle)` gives you the app handle by value (moved). If you need to emit events after an `await` point, the handle is fine — but if you accidentally store it in a `Mutex`-protected struct, you create circular ownership (app → state → handle → app). Also, cloning `AppHandle` is cheap and correct — don't worry about it.

**Prevention:**
- Clone `AppHandle` freely — it's reference-counted and cheap.
- For the filesystem watcher (which runs in a background task), clone the `AppHandle` before spawning and move it into the watcher closure.
- Never store `AppHandle` in managed state (it's already accessible via state).

**Detection:**
- Compile error about `AppHandle` not being `Sync` when trying to store in a mutex
- Watcher closure can't emit events because it doesn't have access to the app handle

**Phase:** Filesystem watcher implementation.

---

### Pitfall 17: SVG ViewBox and Coordinate System Mismatch

**What goes wrong:** Each row SVG needs a consistent coordinate space for lane columns. If column width is defined differently in Rust (for the lane algorithm's pixel output) vs the SVG's `viewBox`, circles and connector lines won't align. This gets worse when the number of active lanes changes (a branch is created or merged), causing the lane count — and therefore SVG width — to change per row.

**Prevention:**
- Define `LANE_WIDTH` and `ROW_HEIGHT` as constants shared via a single source of truth. In practice: define them in Svelte as CSS custom properties, reference them in the SVG `viewBox` and in JavaScript math.
- The Rust lane algorithm should NOT output pixel coordinates — it should output lane indices (integers). SVG rendering translates `lane_index * LANE_WIDTH` to pixels in the frontend.
- Make the SVG `width` dynamic per row (based on max active lane count for that row) but use a consistent `viewBox` coordinate space.

**Detection:**
- Circles don't center on connector lines
- Graph looks correct in Firefox, broken in Chrome (different SVG coordinate handling)

**Phase:** SVG graph rendering phase.

---

### Pitfall 18: HEAD Detection Edge Cases

**What goes wrong:** `repo.head()` returns an error if the repo is in detached HEAD state or has no commits (empty repo). New git2 users call `repo.head().unwrap()` and the app panics when opening a freshly initialized repo or a repo in detached HEAD.

**Prevention:**
- Always handle `head()` errors explicitly:
  - `repo.is_empty()` → show "No commits yet" state
  - `repo.head_detached()` → show detached HEAD indicator in branch sidebar
  - Error from `repo.head()` on a valid non-empty repo → genuine error, log it
- `repo.head()?.shorthand()` returns `None` for detached HEAD — handle the `None` case.

**Detection:**
- App crashes/panics when opening a brand-new `git init` repo
- App crashes when checking out a tag (detached HEAD)

**Phase:** Phase 1 — repository open. Test with edge-case repos from the start.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Repo open + state setup | `Repository` not `Sync` — wrong state architecture | Use path-only state + re-open per operation for reads |
| Repo open + state setup | `head()` panics on empty repo or detached HEAD | Explicit `is_empty()` + `head_detached()` checks |
| Commit history loading | git2 types not serializable | Define DTO structs before writing any git2 code |
| Commit history loading | Revwalk sorting breaks topology | Use `SORT_TOPOLOGICAL | SORT_TIME` always |
| Virtual scroll UI | Scroll position desync | Fixed integer `ROW_HEIGHT`, test at >100% zoom |
| SVG graph rendering | DOM index vs absolute commit index | Rust emits lane data keyed by absolute index |
| SVG graph rendering | ViewBox coordinate mismatch | Lane algo emits indices; frontend does pixel math |
| File status + staging | Path separator mismatch on Windows | Normalize to forward slashes in JS comparisons |
| File status + staging | Index write-back missing | Always call `index.write()` after modifications |
| Commit creation | Wrong author identity | Always use `repo.signature()`, not hardcoded values |
| Diff display | Large diff blocks IPC | Hard-limit diff size; return `truncated: bool` flag |
| Filesystem watching | Watcher fires on own writes | Debounce 300ms; suppress events after own writes |
| Filesystem watching | macOS sandbox kills FSEvents | Test production `.app` build; avoid strict sandbox |
| IPC error handling | Tauri errors arrive as strings | Typed `invoke` wrapper that parses error to object |
| Tauri command errors | git2::Error not Serialize | `AppError` enum with `From<git2::Error>` from day 1 |

---

## Sources

All findings are from training data (cutoff August 2025). Confidence:

| Pitfall | Confidence | Basis |
|---------|------------|-------|
| Repository not Sync (#1) | HIGH | Documented in git2-rs README + Rust `Send`/`Sync` trait bounds verifiable in source |
| git2 lifetime traps (#2) | HIGH | Core Rust/git2 API design — well-documented pattern |
| Virtual scroll desync (#3) | HIGH | Well-known virtual scroll implementation problem; independent of this stack |
| SVG lane index vs DOM index (#4) | HIGH | Logical consequence of virtual scroll + lane graph architecture |
| Notify firing on own writes (#5) | HIGH | Observed pattern with notify crate in practice |
| AppError not Serialize (#6) | HIGH | Tauri 2 documented constraint on command return types |
| Svelte 5 runes reactivity (#7) | MEDIUM | Svelte 5 was stable but relatively new at training cutoff; verify with current Svelte 5 docs |
| Tauri invoke error as string (#8) | HIGH | Tauri 2 documented IPC behavior |
| Revwalk sort flags (#9) | HIGH | git2 API documented — SORT_TOPOLOGICAL behavior is explicit |
| Windows path separators (#10) | HIGH | Cross-platform Rust/git2 behavior — well established |
| Large diff payloads (#11) | HIGH | Tauri IPC is synchronous message-passing; large payloads are a known constraint |
| macOS sandbox FSEvents (#12) | MEDIUM | macOS entitlement behavior — may have changed; verify with Tauri 2 macOS build docs |
| Signature fallback (#13) | HIGH | git2 API documented — `repo.signature()` is the correct method |
| Svelte 5 props reactivity (#14) | MEDIUM | Svelte 5 runes reactivity model — verify with current Svelte 5 docs |
| Index write-back (#15) | HIGH | git2 API documented — `write()` is explicitly required |
| AppHandle in async (#16) | MEDIUM | Tauri 2 API — verify with current Tauri 2 docs |
| SVG viewBox mismatch (#17) | HIGH | SVG coordinate system behavior is browser-standard |
| HEAD edge cases (#18) | HIGH | git2 documented — `is_empty()` and `head_detached()` are explicit checks |

- git2 API: https://docs.rs/git2/latest/git2/ (verification recommended)
- Tauri 2 commands: https://v2.tauri.app/develop/calling-rust/ (verification recommended)
- Tauri 2 state: https://v2.tauri.app/develop/state-management/ (verification recommended)
- Svelte 5 runes: https://svelte.dev/docs/svelte/what-are-runes (verification recommended)
- notify crate: https://docs.rs/notify/latest/notify/ (verification recommended)
