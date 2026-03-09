# Phase 4: Working Tree + Staging - Research

**Researched:** 2026-03-05
**Domain:** git2 status API, Tauri filesystem watcher, Svelte 5 event listeners, staging panel UI
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Panel layout:**
- Vertical split: "Unstaged Files (N)" section on top, "Staged Files (N)" section below
- Both sections are collapsible (▼ chevron), always visible simultaneously
- "Unstaged Files" header: count + "Stage All Changes" button on the right
- "Staged Files" header: count + "Unstage All" button on the right (symmetric to Stage All)
- Panel header shows: total file change count + current branch pill (e.g. "5 file changes on main")
- Panel width: Claude's discretion (fixed, not resizable in v0.1; roughly symmetric with branch sidebar width)

**File row interaction:**
- Dedicated icon button on hover (not whole-row click): a small icon (e.g. `+` or `→`) appears when hovering a row; clicking it stages/unstages the file
- Row itself does not trigger staging on click — only the hover icon button does
- Loading state during the async invoke: muted color or spinner on the row while the operation runs

**File status icons:**
- Status shown as a colored icon/symbol to the left of the filename (not a text badge)
- New: green `+`
- Modified: orange pencil icon
- Deleted: red `−`
- Renamed: blue `→`
- Typechange / Conflicted: Claude's discretion (pick colors consistent with the above set)
- Filename shown as-is; for files in subdirectories, show the relative path

**Auto-refresh on external change:**
- When the filesystem watcher fires, the panel updates silently — new `WorkingTreeStatus` is fetched and swapped in with no loading indicator
- No flash, no spinner — same as VS Code source control panel behavior
- Watcher uses Tauri event system: Rust emits a named event after debounce; Svelte `listen`s and re-fetches status

**Empty state:**
- When working tree is clean, both section headers remain visible: "Unstaged Files (0)" and "Staged Files (0)"
- Lists are empty underneath — no centered message, no illustration

### Claude's Discretion
- Exact panel width (roughly symmetric with branch sidebar)
- Typechange and Conflicted icon colors (consistent with the green/orange/red/blue set)
- Hover icon button design (exact icon, size, padding)
- Loading indicator style on row during staging operation
- Whether to show the branch pill in the panel header as a `RefPill` or plain styled text

### Deferred Ideas (OUT OF SCOPE)
- Sort button (visible in reference image) — v2 feature
- Path/Tree view toggle — v2 feature
- Red discard-all trash button — WORK-V2-01, explicitly deferred to v0.2
- Discard changes on individual files — WORK-V2-01, deferred to v0.2
- Inline diff preview in staging panel — STAGE-V2-02, deferred to v0.2
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| STAGE-01 | User can see current working tree status with files split into unstaged and staged lists, including status type (New, Modified, Deleted, Renamed, Typechange, Conflicted) | git2 `repo.statuses()` API maps `Status` bitflags to `FileStatusType`; `WorkingTreeStatus` DTO already fully defined in `git/types.rs` |
| STAGE-02 | User can stage or unstage individual files (whole-file only) | git2 `repo.index()` + `index.add_path()` for stage; `index.remove_path()` for unstage; hover icon button pattern established |
| STAGE-03 | User can stage all unstaged files at once and unstage all staged files at once with dedicated buttons | Stage-all: iterate unstaged list calling `index.add_path()` in a loop; Unstage-all: `repo.reset_default()` or clear index of HEAD-tracked entries |
| STAGE-04 | Working tree status refreshes automatically when external tools modify repository files, via filesystem watcher with 300ms debounce | `notify-debouncer-mini` already in Cargo.toml; `watcher.rs` stub ready; Tauri `app.emit("repo-changed", path)` → Svelte `listen("repo-changed", handler)` |
</phase_requirements>

---

## Summary

Phase 4 adds the staging panel as the third pane in the 3-column layout. All Rust-side DTOs (`WorkingTreeStatus`, `FileStatus`, `FileStatusType`) are already defined in `src-tauri/src/git/types.rs` and mirrored in `src/lib/types.ts`. The Svelte component scaffold (`BranchSection`, `BranchRow`, `RefPill`) and Tauri command stubs (`staging.rs`, `watcher.rs`) are ready — the implementation work is filling them in.

The two main technical areas requiring care are (1) correctly mapping git2 `Status` bitflags to the six `FileStatusType` variants for both the index and working-tree sides, and (2) wiring the `notify-debouncer-mini` watcher to emit a Tauri event and have Svelte clean up its `listen` subscription on component destroy. Both have well-defined patterns from the existing codebase and official library docs.

The auto-refresh path (STAGE-04) is the most novel piece: the watcher must be started when a repo opens, stored in managed state so it stays alive, and torn down on repo close. Svelte's `listen` returns an unlisten function that must be called in `onDestroy` to avoid duplicate handlers across remounts.

**Primary recommendation:** Implement staging commands in `staging.rs` following the `inner fn` pattern from `branches.rs`; implement `watcher.rs` using `notify-debouncer-mini` with `app.emit`; add `StagingPanel.svelte` and `FileRow.svelte` new components; wire everything in `App.svelte` where the comment placeholder already exists.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.19 | Index manipulation (stage/unstage), status enumeration | Already in Cargo.toml; all Phase 1-3 git ops use it |
| notify-debouncer-mini | 0.5 | Filesystem watcher with debounce | Already in Cargo.toml per INFRA-02; purpose-built for FS change debouncing |
| @tauri-apps/api/event | (Tauri 2 bundled) | `listen()` on frontend to receive Rust events | Tauri's official IPC event bus |
| Svelte 5 runes | project standard | Component state + derived values | Established pattern throughout project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tauri::AppHandle | Tauri 2 | `app.emit("repo-changed", payload)` in Rust | Needed to emit events from watcher thread to frontend |
| tempfile | 3 (dev) | In-process test repos for staging unit tests | Already used in `branches.rs` tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| notify-debouncer-mini | notify (raw) | Raw notify requires manual debounce timer; debouncer-mini already provides it |
| Tauri event bus | Polling from Svelte | Polling wastes cycles and adds latency; event push is instant and CPU-friendly |

**Installation:** No new dependencies needed. All are already declared in `Cargo.toml` and `package.json`.

---

## Architecture Patterns

### Recommended File Structure
```
src/
├── components/
│   ├── StagingPanel.svelte   # Top-level panel: header + two sections
│   └── FileRow.svelte        # Single file row: status icon + name + hover action button
src-tauri/src/
├── commands/
│   └── staging.rs            # get_status, stage_file, unstage_file, stage_all, unstage_all
└── watcher.rs                # start_watcher(), stop_watcher(), WatcherState managed struct
```

### Pattern 1: git2 Status Bitflag Mapping

**What:** git2 returns `Status` bitflags for each path. Staged changes use `INDEX_*` flags; working-tree changes use `WT_*` flags.

**Mapping table (HIGH confidence — derived from git2 0.19 source and branches.rs existing usage):**

```rust
// Source: git2::Status flags — same ones already used in branches.rs is_dirty()
use git2::Status;

fn classify_index(s: Status) -> Option<FileStatusType> {
    if s.contains(Status::INDEX_NEW)        { return Some(FileStatusType::New); }
    if s.contains(Status::INDEX_MODIFIED)   { return Some(FileStatusType::Modified); }
    if s.contains(Status::INDEX_DELETED)    { return Some(FileStatusType::Deleted); }
    if s.contains(Status::INDEX_RENAMED)    { return Some(FileStatusType::Renamed); }
    if s.contains(Status::INDEX_TYPECHANGE) { return Some(FileStatusType::Typechange); }
    if s.contains(Status::CONFLICTED)       { return Some(FileStatusType::Conflicted); }
    None
}

fn classify_workdir(s: Status) -> Option<FileStatusType> {
    if s.contains(Status::WT_NEW)        { return Some(FileStatusType::New); }
    if s.contains(Status::WT_MODIFIED)   { return Some(FileStatusType::Modified); }
    if s.contains(Status::WT_DELETED)    { return Some(FileStatusType::Deleted); }
    if s.contains(Status::WT_RENAMED)    { return Some(FileStatusType::Renamed); }
    if s.contains(Status::WT_TYPECHANGE) { return Some(FileStatusType::Typechange); }
    None
}
```

A file can appear in both unstaged and staged lists if it has both INDEX and WT changes (e.g. partially-staged). The `conflicted` field in `WorkingTreeStatus` is populated from `Status::CONFLICTED` entries.

### Pattern 2: Inner Function Separation (established in branches.rs)

**What:** Every Tauri `#[tauri::command]` delegates immediately to a plain `pub fn ..._inner(path, state_map)` that holds all business logic and is directly callable in tests without Tauri machinery.

```rust
// Source: branches.rs pattern — replicate exactly
pub fn get_status_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<WorkingTreeStatus, TrunkError> {
    // ... business logic ...
}

#[tauri::command]
pub async fn get_status(
    path: String,
    state: State<'_, RepoState>,
) -> Result<WorkingTreeStatus, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_status_inner(&path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}
```

### Pattern 3: Staging and Unstaging with git2

**Stage a file (index → add):**
```rust
// Source: git2 index API
let mut index = repo.index()?;
index.add_path(Path::new(relative_path))?;
index.write()?;
```

**Unstage a file (index → remove / reset to HEAD):**
```rust
// Source: git2 reset API — correct approach for unstaging (not index.remove_path)
// index.remove_path removes the file from tracking entirely (like `git rm --cached`)
// Correct unstage is to reset the index entry to match HEAD:
let head_commit = repo.head()?.peel_to_commit()?;
repo.reset_default(Some(&head_commit.as_object()), [relative_path].iter())?;
```

**Unstage all:**
```rust
let head_commit = repo.head()?.peel_to_commit()?;
// Pass all staged paths to reset_default, or pass None for all:
repo.reset_default(Some(&head_commit.as_object()), staged_paths.iter())?;
```

**Stage all:**
```rust
let mut index = repo.index()?;
index.update_all(["*"].iter(), None)?;
index.write()?;
```

**Edge case — initial repo (no HEAD yet):** When there are no commits, `repo.head()` returns an error. Unstage-all on an initial repo must handle this: if HEAD does not exist, clear the index instead of `reset_default`.

### Pattern 4: Filesystem Watcher with Tauri Event Emission

```rust
// Source: notify-debouncer-mini docs + Tauri 2 AppHandle::emit
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use std::time::Duration;
use tauri::AppHandle;

pub fn start_watcher(
    path: PathBuf,
    app: AppHandle,
) -> notify_debouncer_mini::Debouncer<notify::RecommendedWatcher> {
    let debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        if res.is_ok() {
            let _ = app.emit("repo-changed", path.to_string_lossy().to_string());
        }
    })
    .expect("failed to create debouncer");
    debouncer
        .watcher()
        .watch(&path, RecursiveMode::Recursive)
        .expect("failed to watch path");
    debouncer
}
```

**Storing the watcher:** The `Debouncer` handle must be kept alive — dropping it stops the watcher. Store it in a `Mutex<HashMap<String, Debouncer<...>>>` managed state (similar to `RepoState`). A type alias helps with the verbose type.

**Watcher teardown on repo close:** `close_repo` command must also remove the watcher from the map (drop triggers stop).

### Pattern 5: Svelte `listen` with Cleanup

```typescript
// Source: @tauri-apps/api/event — Tauri 2 official pattern
import { listen } from '@tauri-apps/api/event';
import { onDestroy } from 'svelte';

// Inside StagingPanel component:
let unlistenFn: (() => void) | undefined;

$effect(() => {
  listen<string>('repo-changed', (event) => {
    if (event.payload === repoPath) {
      loadStatus(); // silent re-fetch, no loading indicator
    }
  }).then((unlisten) => {
    unlistenFn = unlisten;
  });

  return () => {
    unlistenFn?.();
  };
});
```

Using `$effect` cleanup (return fn) is the Svelte 5 runes pattern for subscription teardown. This replaces the Svelte 4 `onDestroy` approach.

### Pattern 6: File Row with Hover Action Button

```svelte
<!-- FileRow.svelte — Svelte 5 runes, 26px row height matching BranchRow -->
<script lang="ts">
  import type { FileStatus } from '../lib/types.js';

  interface Props {
    file: FileStatus;
    isLoading?: boolean;
    onaction: () => void; // stage or unstage depending on context
  }
  let { file, isLoading = false, onaction }: Props = $props();
  let hovered = $state(false);
</script>

<div
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
  style="height: 26px; padding: 0 8px; display: flex; align-items: center; gap: 6px;
         background: {hovered ? 'var(--color-surface)' : 'transparent'};"
>
  <!-- Status icon (colored symbol) -->
  <!-- Filename -->
  <!-- Hover action button — only visible when hovered and not loading -->
  {#if hovered && !isLoading}
    <button onclick={(e) => { e.stopPropagation(); onaction(); }}>+</button>
  {/if}
</div>
```

### Anti-Patterns to Avoid

- **Using `index.remove_path()` for unstage:** This removes the file from git tracking entirely (like `git rm --cached`), not what the user wants. Use `repo.reset_default()` pointing at HEAD instead.
- **Calling `repo.head().peel_to_commit()` without handling unborn HEAD:** Fresh repos have no commits; HEAD is unborn. Guard with `repo.head().ok()` and fall back to clearing the index when no HEAD commit exists.
- **Dropping the watcher Debouncer immediately:** If the watcher is returned but not stored in managed state, it is dropped at end of scope and stops watching.
- **Not unlistening on Svelte component destroy:** Each `listen()` call registers a new handler. Without cleanup, each remount (triggered by `{#key graphKey}` or repo close/reopen) stacks duplicate listeners.
- **Emitting on every FS event before debounce:** Always use `notify-debouncer-mini`, never raw `notify`, to avoid flooding the frontend with status fetches on multi-file save operations.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Filesystem debouncing | Manual timer/channel in Rust | notify-debouncer-mini | Handles rapid burst events, configurable window, already in Cargo.toml |
| Staging a file | Custom git plumbing shell-out | git2 `index.add_path()` | Handles binary files, symlinks, renames, exec-bit correctly |
| Unstaging a file | `index.remove_path()` | `repo.reset_default()` | remove_path un-tracks the file; reset_default correctly restores the HEAD version |
| Status classification | Manual flag arithmetic | git2 `Status` bitflag constants | All edge cases (renamed+modified, type-change, conflict) covered by git2 |
| Event deduplication | Svelte store diffing | Natural: same data replaces `$state` | Svelte 5 reactive state already skips re-render when value is structurally equal |

**Key insight:** git2's index API is the correct layer for staging operations — it handles all edge cases that shell-outs (or manual file manipulation) miss. The `Status` bitflags cover all six `FileStatusType` variants directly.

---

## Common Pitfalls

### Pitfall 1: Unborn HEAD on First Unstage

**What goes wrong:** On a repository with no commits yet (just initialized), `repo.head()` returns `Err(ErrorCode::UnbornBranch)`. Calling `head()?.peel_to_commit()?` panics/errors when the user tries to unstage in a brand-new repo.

**Why it happens:** git2's `head()` succeeds only after the first commit.

**How to avoid:** Check `repo.is_head_unborn()` before calling `reset_default`. If unborn, unstage by clearing the full index: `index.clear()` + `index.write()`.

**Warning signs:** Error `TrunkError { code: "git_error", message: "reference 'refs/heads/main' not found" }` on unstage.

### Pitfall 2: Watcher Stops When Debouncer is Dropped

**What goes wrong:** The watcher silently stops if the `Debouncer` handle is not kept alive in managed state.

**Why it happens:** Rust drops the value when it goes out of scope. The watcher thread terminates.

**How to avoid:** Store `Debouncer<RecommendedWatcher>` in a `Mutex<HashMap<String, ...>>` managed state, inserted on `open_repo` and removed on `close_repo`.

**Warning signs:** First `git commit` from terminal doesn't trigger a panel refresh.

### Pitfall 3: Stale Svelte Event Listeners

**What goes wrong:** After repo close/reopen (which causes `{#key graphKey}` remount in App.svelte), duplicate `listen` handlers fire, causing double status fetches or stale-path events.

**Why it happens:** `listen()` is additive — it doesn't replace previous handlers.

**How to avoid:** Always store the unlisten callback returned by `listen()` and call it in the `$effect` cleanup function (return value of the `$effect` callback).

**Warning signs:** Panel refreshes twice per external change; status shows stale data from previous repo.

### Pitfall 4: notify Watching .git Directory Changes

**What goes wrong:** Watching the repo root recursively includes `.git/` — every git operation (commit, checkout) emits dozens of rapid FS events that flood the debouncer.

**Why it happens:** `.git/` contains many files that change during git operations.

**How to avoid:** Either (a) watch only the working tree (non-.git paths) and `.git/index` specifically, or (b) rely on the 300ms debounce to batch all events into one. Option (b) is simpler and sufficient for v0.1.

**Warning signs:** Panel flickers rapidly during checkout operations.

### Pitfall 5: File Path Separators on Windows

**What goes wrong:** git2 returns paths with forward slashes on all platforms, but `Path::new()` on Windows expects backslashes. `index.add_path(Path::new("src/foo.ts"))` may fail.

**Why it happens:** git stores paths as bytes with `/` separators; the OS path API uses `\` on Windows.

**How to avoid:** Use `Path::new(path)` — on macOS (current target) this works fine. Note for cross-platform future: `std::path::PathBuf::from(path.replace('/', std::path::MAIN_SEPARATOR_STR))`. Not a concern for current darwin target.

---

## Code Examples

### Get Working Tree Status (Rust)

```rust
// Source: git2 0.19 statuses() API — established in branches.rs is_dirty()
pub fn get_status_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<WorkingTreeStatus, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    let mut unstaged: Vec<FileStatus> = Vec::new();
    let mut staged: Vec<FileStatus> = Vec::new();
    let mut conflicted: Vec<FileStatus> = Vec::new();

    for entry in statuses.iter() {
        let path_str = entry.path().unwrap_or("").to_owned();
        let s = entry.status();

        if s.contains(Status::CONFLICTED) {
            conflicted.push(FileStatus {
                path: path_str,
                status: FileStatusType::Conflicted,
                is_binary: false,
            });
            continue;
        }

        if let Some(status_type) = classify_index(s) {
            staged.push(FileStatus {
                path: path_str.clone(),
                status: status_type,
                is_binary: false,
            });
        }

        if let Some(status_type) = classify_workdir(s) {
            unstaged.push(FileStatus {
                path: path_str,
                status: status_type,
                is_binary: false,
            });
        }
    }

    Ok(WorkingTreeStatus { unstaged, staged, conflicted })
}
```

### Stage / Unstage Individual File (Rust)

```rust
// Source: git2 index API
pub fn stage_file_inner(path: &str, file_path: &str, state_map: &HashMap<String, PathBuf>)
    -> Result<(), TrunkError>
{
    let repo = open_repo_from_state(path, state_map)?;
    let mut index = repo.index()?;
    index.add_path(Path::new(file_path))?;
    index.write()?;
    Ok(())
}

pub fn unstage_file_inner(path: &str, file_path: &str, state_map: &HashMap<String, PathBuf>)
    -> Result<(), TrunkError>
{
    let repo = open_repo_from_state(path, state_map)?;
    if repo.is_head_unborn() {
        // No HEAD commit — just remove from index
        let mut index = repo.index()?;
        index.remove_path(Path::new(file_path))?;
        index.write()?;
    } else {
        let head_commit = repo.head()?.peel_to_commit()?;
        repo.reset_default(Some(head_commit.as_object()), std::iter::once(file_path))?;
    }
    Ok(())
}
```

### Svelte Status Fetch with Silent Refresh

```typescript
// Source: established pattern from BranchSidebar.svelte (onrefreshed / loadRefs)
let status = $state<WorkingTreeStatus | null>(null);
let loadSeq = 0; // prevents stale async responses

async function loadStatus() {
  const seq = ++loadSeq;
  const result = await safeInvoke<WorkingTreeStatus>('get_status', { path: repoPath });
  if (seq === loadSeq) {
    status = result; // silent swap, no loading indicator
  }
}
```

### Tauri Event Listen with $effect Cleanup (Svelte 5)

```typescript
// Source: @tauri-apps/api/event + Svelte 5 $effect
import { listen } from '@tauri-apps/api/event';

$effect(() => {
  let unlisten: (() => void) | undefined;
  listen<string>('repo-changed', (event) => {
    if (event.payload === repoPath) loadStatus();
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `onDestroy` for cleanup | `$effect` return fn | Svelte 5 runes | Cleaner, no import needed |
| `index.remove_path` for unstage | `repo.reset_default` | Always correct | Preserves tracking; only resets index entry to HEAD |
| Svelte stores for shared state | `$state` runes with props | Svelte 5 | Simpler, co-located with component |
| `writable(null)` loading flags | `let loading = $state(false)` | Svelte 5 | Direct, no store subscription boilerplate |

**Deprecated/outdated:**
- `onDestroy` for event listener cleanup: Use `$effect` cleanup return instead (though `onDestroy` still works in Svelte 5 for backwards compat)
- `statusOptions.sort_case_insensitively()`: Available but not needed for v0.1

---

## Open Questions

1. **AppHandle in watcher thread**
   - What we know: Tauri 2 `AppHandle` is `Clone + Send`, so it can be moved into the watcher closure.
   - What's unclear: Whether `app.emit()` is safe to call from `notify`'s OS thread on macOS (FSEvents runs on a dedicated thread).
   - Recommendation: Use `app.emit()` directly; Tauri 2's AppHandle is designed for cross-thread use. If issues arise, channel the event through `tauri::async_runtime::spawn`.

2. **WatcherState type complexity**
   - What we know: `notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>` is a concrete type needed in managed state.
   - What's unclear: Whether `RecommendedWatcher` implements `Send` (required for `Mutex`).
   - Recommendation: `notify::RecommendedWatcher` is `Send` on all platforms. Define `type WatcherMap = Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>` and manage it via `app.manage()`.

3. **macOS sandbox in production .app (noted in STATE.md)**
   - What we know: FSEvents (used by notify on macOS) requires entitlements in sandboxed builds.
   - What's unclear: Whether `tauri dev` and production `.app` behave identically for FS watching.
   - Recommendation: Validate against `tauri build` before marking STAGE-04 complete. This is the blocker flagged in STATE.md.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in tests (`#[test]`) |
| Config file | none (Cargo test discovery) |
| Quick run command | `cargo test -p trunk_lib --lib 2>&1 \| tail -20` |
| Full suite command | `cargo test -p trunk_lib 2>&1 \| tail -30` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STAGE-01 | `get_status_inner` returns correct unstaged/staged/conflicted lists | unit | `cargo test -p trunk_lib -- staging::tests::get_status_returns_unstaged -x` | ❌ Wave 0 |
| STAGE-01 | New file shows as `FileStatusType::New` in unstaged | unit | `cargo test -p trunk_lib -- staging::tests::status_new_file -x` | ❌ Wave 0 |
| STAGE-01 | Modified file shows as `FileStatusType::Modified` | unit | `cargo test -p trunk_lib -- staging::tests::status_modified_file -x` | ❌ Wave 0 |
| STAGE-02 | `stage_file_inner` moves file from unstaged to staged | unit | `cargo test -p trunk_lib -- staging::tests::stage_file_moves_to_staged -x` | ❌ Wave 0 |
| STAGE-02 | `unstage_file_inner` moves file from staged to unstaged | unit | `cargo test -p trunk_lib -- staging::tests::unstage_file_moves_to_unstaged -x` | ❌ Wave 0 |
| STAGE-02 | Unstage on unborn HEAD clears index entry (no panic) | unit | `cargo test -p trunk_lib -- staging::tests::unstage_on_unborn_head -x` | ❌ Wave 0 |
| STAGE-03 | `stage_all_inner` stages every unstaged file | unit | `cargo test -p trunk_lib -- staging::tests::stage_all_stages_everything -x` | ❌ Wave 0 |
| STAGE-03 | `unstage_all_inner` clears entire index | unit | `cargo test -p trunk_lib -- staging::tests::unstage_all_clears_index -x` | ❌ Wave 0 |
| STAGE-04 | Watcher emits event within ~300ms of file change | manual-only | n/a — requires real FS + Tauri runtime | — |

### Sampling Rate
- **Per task commit:** `cargo test -p trunk_lib --lib 2>&1 | tail -20`
- **Per wave merge:** `cargo test -p trunk_lib 2>&1 | tail -30`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/staging.rs` — fill stub with `get_status_inner`, `stage_file_inner`, `unstage_file_inner`, `stage_all_inner`, `unstage_all_inner` + `#[cfg(test)]` block
- [ ] Tests live inside `staging.rs` `#[cfg(test)]` using `make_test_repo()` from `crate::git::repository::tests`
- [ ] `src-tauri/src/watcher.rs` — fill stub with `WatcherState` managed type + `start_watcher`/`stop_watcher`

*(No separate test file needed — Rust inline tests match the established pattern from `branches.rs`)*

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `src-tauri/src/commands/branches.rs` — established patterns for inner fn, spawn_blocking, error mapping, test structure
- Direct code inspection of `src-tauri/src/git/types.rs` — `WorkingTreeStatus`, `FileStatus`, `FileStatusType` fully defined
- Direct code inspection of `src-tauri/src/commands/staging.rs` — confirmed it is a stub awaiting implementation
- Direct code inspection of `src-tauri/src/watcher.rs` — confirmed it is a stub awaiting implementation
- Direct code inspection of `src/App.svelte` — confirmed `<!-- Phase 4 adds StagingPanel here -->` comment in correct slot
- Direct code inspection of `src/components/BranchSection.svelte` and `BranchRow.svelte` — reusable patterns for StagingPanel sections and FileRow
- `Cargo.toml` — confirmed `notify = "7"`, `notify-debouncer-mini = "0.5"` already declared

### Secondary (MEDIUM confidence)
- git2 0.19 `Status` bitflag names (`INDEX_NEW`, `WT_NEW`, `CONFLICTED`, etc.) — consistent with usage in `branches.rs` `is_dirty()` function which was verified to work correctly in Phase 3
- `repo.reset_default()` for unstage — standard git2 pattern; `index.remove_path()` vs `reset_default` distinction verified from git2 API semantics
- Tauri 2 `AppHandle::emit()` for cross-thread event emission — Tauri 2 standard pattern; AppHandle is Clone+Send per official design

### Tertiary (LOW confidence — flag for validation)
- macOS sandbox behavior for FSEvents in production `.app` — acknowledged in STATE.md as needing validation against production build, not just `tauri dev`

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in Cargo.toml, patterns already in codebase
- Architecture: HIGH — inner fn pattern, spawn_blocking, error mapping directly cloned from branches.rs
- Pitfalls: HIGH — unborn HEAD and watcher drop are well-known git2/notify issues; Svelte listener leak verified from Tauri docs pattern

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable libraries; Svelte 5 runes API stable)
