# Phase 5: Commit Creation - Research

**Researched:** 2026-03-05
**Domain:** git2 commit/amend APIs, Svelte 5 form patterns, Tauri IPC event emission
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Form lives inside StagingPanel.svelte, pinned at the bottom below a permanent divider
- Unstaged + staged file sections use overflow scroll; commit form is always visible without scrolling
- Form is a separate CommitForm.svelte component (not inlined in StagingPanel) — consistent with Phase 3/4 component extraction pattern
- Body field (optional description) is always visible — no toggle or expand/collapse
- Form shares the existing 240px StagingPanel column; no layout restructuring needed
- Checkbox labeled "Amend previous commit" in the form (below the body field, above the commit button)
- When the checkbox is checked: subject and body fields pre-populate with the most recent commit's message
- Amend message-only is allowed — staging area can be empty in amend mode (COMIT-03 explicitly covers "updating its message")
- When unchecked: fields revert to empty (or retain any edits the user made before toggling)
- Errors shown on submit attempt only (not real-time while typing)
- Subject empty: inline red/warning text below the subject field
- Staging area empty (non-amend mode): inline warning near the commit button
- Commit button is always enabled; validation runs on click and blocks submission if invalid
- Errors clear on the next successful submit or when the user modifies the relevant field
- On success: subject and body fields clear, amend checkbox unchecks, staging panel refreshes
- Silent reset — no toast, no success banner, no green flash
- Commit button shows a loading/disabled state during the async invoke (prevents double-submit; consistent with file row loading pattern from Phase 4)
- Graph refresh: Rust's create_commit command emits the existing `repo-changed` event after success; App.svelte adds a `listen("repo-changed", ...)` handler to bump `graphKey`; StagingPanel auto-refreshes via its existing `repo-changed` listener

### Claude's Discretion
- Exact form padding/spacing inside the 240px column
- Subject textarea vs single-line input (single-line input likely appropriate given narrow width)
- Body textarea row count
- Exact loading indicator style on the commit button during in-flight invoke
- Error text color and icon (red text, warning icon — consistent with existing muted/accent color palette)

### Deferred Ideas (OUT OF SCOPE)
- None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| COMIT-01 | User can create a commit with a subject line and optional description body; author identity is read from gitconfig via `repo.signature()` | git2 `repo.signature()` reads user.name/user.email from gitconfig; `repo.commit()` takes a `Signature` for both author and committer; `index.write_tree()` + `repo.find_tree()` required before committing |
| COMIT-02 | App refuses to create a commit if the subject is empty or the staging area is empty, with a visible validation message | Frontend validation only — no Rust-side guard needed; subject check is a string trim; staged-empty check reads from `status.staged.length` already available in StagingPanel state |
| COMIT-03 | User can amend the most recent commit, updating its message or adding currently staged changes to it | git2 `Commit::amend()` method handles both message-only and message+tree amend; needs `repo.head()?.peel_to_commit()` to get HEAD; after amend, `CommitCache` in state must be invalidated so graph refreshes correctly |
</phase_requirements>

---

## Summary

Phase 5 adds commit creation and amend to an already fully wired staging panel. The Rust side requires implementing two commands (`create_commit`, `amend_commit`) in the existing stub `src-tauri/src/commands/commit.rs`, a read-only helper (`get_head_commit_message`) for amend pre-population, and registration in `generate_handler![]`. The frontend requires a new `CommitForm.svelte` component mounted at the bottom of `StagingPanel.svelte`, plus a `listen("repo-changed", ...)` handler in `App.svelte` to trigger graph refresh on commit.

The core git2 operations are straightforward: `repo.signature()` reads gitconfig, `repo.index()` + `index.write_tree()` produces the tree OID, and `repo.commit()` / `commit.amend()` writes the commit. The critical Rust pitfall is that after `create_commit` or `amend_commit` the `CommitCache` in managed state must be invalidated (cleared for the repo path) so the graph fetches fresh data on the next `get_commit_graph` call.

The frontend layout challenge is making the scrollable file lists and the always-visible form coexist in 240px. The established approach is: make the two file sections a `flex-shrink: 1; overflow-y: auto` scrollable region and give the form `flex-shrink: 0` at the bottom of the flex column.

**Primary recommendation:** Implement Rust commands using the established `_inner` fn pattern (pure logic in `*_inner`, Tauri wrapper calls `spawn_blocking`), emit `repo-changed` after success to piggyback on existing listeners, and invalidate CommitCache to ensure the graph remounts with fresh data.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.19 (vendored-libgit2) | All git operations — commit, amend, signature | Already in Cargo.toml; all prior phases use it |
| tauri | 2 | IPC: `#[tauri::command]`, `AppHandle`, `Emitter::emit` | Project foundation |
| Svelte 5 | current | Frontend component + reactive state | Project foundation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tauri::async_runtime::spawn_blocking | tauri 2 | Run git2 ops on thread pool | All git2 calls (Repository not Sync) |
| @tauri-apps/api/event listen | tauri 2 JS | Subscribe to `repo-changed` | App.svelte graph refresh on commit |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| git2 Commit::amend() | git CLI `git commit --amend` | CLI approach not used in this project; git2 is the standard |
| Frontend validation only | Rust-side validation | Rust validation would require extra error code handling; subject empty is purely a UI concern |

**No new packages required.** All dependencies already present.

---

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/commands/
├── commit.rs        # IMPLEMENT: create_commit_inner, amend_commit_inner,
│                    #   get_head_commit_message_inner + Tauri wrappers
src/components/
├── CommitForm.svelte  # NEW: commit form component
├── StagingPanel.svelte  # MODIFY: import + mount CommitForm, adjust layout
src/App.svelte         # MODIFY: add repo-changed listener for graph refresh
src/lib/types.ts       # MODIFY: add HeadCommitMessage DTO if needed
```

### Pattern 1: Inner Function / Tauri Wrapper Split
**What:** All git2 logic lives in a `*_inner(path, state_map)` pure function; the `#[tauri::command]` fn clones the state map, calls `spawn_blocking`, and serializes errors. This is the established pattern for every command in this project.
**When to use:** Every new Rust command.
**Example:**
```rust
// Source: staging.rs — established project pattern
pub fn create_commit_inner(
    path: &str,
    subject: &str,
    body: Option<&str>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let sig = repo.signature()?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let message = match body {
        Some(b) if !b.trim().is_empty() => format!("{}\n\n{}", subject, b),
        _ => subject.to_owned(),
    };
    let head_ref = "HEAD";
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(h) => vec![h.peel_to_commit()?],
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => vec![],
        Err(e) => return Err(TrunkError::from(e)),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    repo.commit(Some(head_ref), &sig, &sig, &message, &tree, &parent_refs)?;
    Ok(())
}

#[tauri::command]
pub async fn create_commit(
    path: String,
    subject: String,
    body: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_commit_inner(&path_clone, &subject, body.as_deref(), &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    // Invalidate commit cache so graph fetches fresh data
    cache.0.lock().unwrap().remove(&path);
    // Notify all listeners (StagingPanel + App.svelte graph refresh)
    let _ = app.emit("repo-changed", path);
    Ok(())
}
```

### Pattern 2: git2 Amend
**What:** `Commit::amend()` updates message and/or tree in-place. To amend message-only, pass `None` for tree. To amend with staged changes, write tree from index first.
**When to use:** `amend_commit` command.
**Example:**
```rust
// Source: git2 0.19 API
pub fn amend_commit_inner(
    path: &str,
    subject: &str,
    body: Option<&str>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let sig = repo.signature()?;
    let message = match body {
        Some(b) if !b.trim().is_empty() => format!("{}\n\n{}", subject, b),
        _ => subject.to_owned(),
    };

    // Write current index as new tree (picks up any staged changes)
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    head_commit.amend(
        Some("HEAD"),   // update_ref
        Some(&sig),     // author
        Some(&sig),     // committer
        None,           // encoding — None = UTF-8
        Some(&message), // message
        Some(&tree),    // tree — None = keep existing tree (message-only amend)
    )?;
    Ok(())
}
```

### Pattern 3: Head Commit Message Fetch
**What:** A lightweight read command that returns just the subject and body of HEAD. Used by the frontend when the amend checkbox is toggled.
**When to use:** Frontend calls `get_head_commit_message` on amend checkbox check.
**Example:**
```rust
pub fn get_head_commit_message_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<HeadCommitMessage, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let commit = repo.head()?.peel_to_commit()?;
    Ok(HeadCommitMessage {
        subject: commit.summary().unwrap_or("").to_owned(),
        body: commit.body().map(str::to_owned),
    })
}
```

### Pattern 4: CommitForm Svelte 5 Component
**What:** Svelte 5 runes pattern for form state + submit handler. Consistent with FileRow and StagingPanel patterns.
**When to use:** CommitForm.svelte implementation.
**Example:**
```typescript
// Source: established Svelte 5 runes pattern from project
interface Props {
  repoPath: string;
  stagedCount: number;   // passed from StagingPanel to drive validation
}

let { repoPath, stagedCount }: Props = $props();

let subject = $state('');
let body = $state('');
let amend = $state(false);
let committing = $state(false);
let subjectError = $state('');
let stagedError = $state('');

async function handleSubmit() {
  subjectError = '';
  stagedError = '';

  if (!subject.trim()) {
    subjectError = 'Subject is required';
    return;
  }
  if (!amend && stagedCount === 0) {
    stagedError = 'No files staged';
    return;
  }

  committing = true;
  try {
    if (amend) {
      await safeInvoke('amend_commit', { path: repoPath, subject: subject.trim(), body: body.trim() || null });
    } else {
      await safeInvoke('create_commit', { path: repoPath, subject: subject.trim(), body: body.trim() || null });
    }
    subject = '';
    body = '';
    amend = false;
  } catch (e) {
    // surface error if needed
  } finally {
    committing = false;
  }
}
```

### Pattern 5: App.svelte repo-changed Listener for Graph Refresh
**What:** `App.svelte` adds a `listen("repo-changed", ...)` handler that calls `handleRefresh()` (which bumps `graphKey`) — exactly the same as the watcher's debounced emission already does when external tools modify repo files. After a commit, the Rust command also emits `repo-changed`, triggering both StagingPanel refresh and graph remount.
**When to use:** App.svelte `$effect` block; same style as StagingPanel's existing listener.
**Example:**
```typescript
// Source: established project pattern from StagingPanel.svelte
$effect(() => {
  let unlisten: (() => void) | undefined;
  listen<string>('repo-changed', (event) => {
    if (event.payload === repoPath) handleRefresh();
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
});
```

### StagingPanel Layout: Scrollable Sections + Fixed Form
**What:** The existing StagingPanel is a flex column (height 100%). Unstaged and staged sections currently have `flex-shrink: 0` (they expand to content). For CommitForm to always be visible, both file sections must become scrollable together inside a `flex: 1; overflow-y: auto` wrapper, and CommitForm gets `flex-shrink: 0` at the bottom.
**Example:**
```html
<!-- StagingPanel structure after modification -->
<div style="display: flex; flex-direction: column; height: 100%; ...">
  <!-- Panel header — flex-shrink: 0 -->
  <div style="flex-shrink: 0; ...">...</div>

  <!-- Scrollable file lists region — flex: 1; overflow-y: auto -->
  <div style="flex: 1; overflow-y: auto; min-height: 0;">
    <!-- Unstaged section -->
    <!-- Staged section -->
  </div>

  <!-- Commit form divider -->
  <div style="flex-shrink: 0; border-top: 1px solid var(--color-border);"></div>

  <!-- Commit form — flex-shrink: 0 -->
  <CommitForm {repoPath} stagedCount={status?.staged.length ?? 0} />
</div>
```

### Anti-Patterns to Avoid
- **Forgetting to invalidate CommitCache:** After `create_commit` or `amend_commit`, if `CommitCache` is not cleared, `get_commit_graph` will return the pre-commit data. The `{#key graphKey}` in App.svelte remounts CommitGraph which calls `get_commit_graph` — it must see fresh data.
- **Not handling unborn HEAD in create_commit:** Repositories with no commits yet have an unborn HEAD. The `parents` list must be empty in that case (same pattern as `unstage_file_inner`).
- **Using `peel_to_commit()` in amend:** The project documents that `target() + find_commit(oid)` can be safer than `peel_to_commit()` when lifetime conflicts arise. However, `peel_to_commit()` on a direct reference works fine for HEAD in `commit.rs` context.
- **Calling `amend` with `None` tree when staged changes exist:** If user checks amend and has staged files, always pass the current tree so staged changes are included.
- **Inlining CommitForm in StagingPanel:** Context.md locks the extraction — it must be its own component file.
- **Loading flex-1 wrapper omission:** Without `min-height: 0` on the scrollable region, the flex child can refuse to shrink below content height on some browsers, breaking the always-visible form.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Author identity | Manual gitconfig parsing | `repo.signature()` | Reads user.name + user.email + timestamp correctly, handles missing config with error |
| Commit tree building | Manual tree construction | `index.write_tree()` + `repo.find_tree()` | git2 handles staged index → tree object correctly |
| Amend mechanics | Manual parent rewrites | `Commit::amend()` | Handles ref update, object rewrite, all edge cases |
| IPC error propagation | Custom error type | `TrunkError { code, message }` + `safeInvoke<T>` | Already established; frontend matches on `code` string |

**Key insight:** git commit is deceptively complex (unborn HEAD, message encoding, author vs committer, parent lists). git2's high-level API handles all of this — use it directly.

---

## Common Pitfalls

### Pitfall 1: CommitCache not invalidated after commit
**What goes wrong:** `get_commit_graph` returns stale cache after a commit, so the graph still shows the old HEAD even though `graphKey` bumped and CommitGraph remounted.
**Why it happens:** `CommitCache` is populated on `open_repo` and never cleared except on `close_repo`. A new commit changes history but the cache is unaware.
**How to avoid:** In `create_commit` and `amend_commit` Tauri wrappers, call `cache.0.lock().unwrap().remove(&path)` before emitting `repo-changed`. The graph remount will call `get_commit_graph`, which re-walks history and repopulates the cache.
**Warning signs:** Graph does not show new commit after `committing` state clears; refreshing via close+reopen shows it.

### Pitfall 2: Unborn HEAD panic in create_commit
**What goes wrong:** `repo.head()?` returns `Err(ErrorCode::UnbornBranch)` on a fresh repo, causing the inner function to return an error and the commit to fail.
**Why it happens:** Newly init'd repos have no commits yet.
**How to avoid:** Use the same unborn detection pattern already in `staging.rs`:
```rust
let parents: Vec<git2::Commit> = match repo.head() {
    Ok(h) => vec![h.peel_to_commit()?],
    Err(e) if e.code() == git2::ErrorCode::UnbornBranch => vec![],
    Err(e) => return Err(TrunkError::from(e)),
};
```
**Warning signs:** `create_commit` fails silently on a new repo with no prior commits.

### Pitfall 3: StagingPanel overflow layout breaks form visibility
**What goes wrong:** If both file sections have `flex-shrink: 0`, the panel grows to fit all files and CommitForm scrolls out of view. Alternatively, the file region with `flex: 1` may refuse to shrink without `min-height: 0`.
**Why it happens:** Default flex behaviour doesn't shrink children below content height without explicit `min-height: 0`.
**How to avoid:** Wrap both file sections in a `div` with `flex: 1; overflow-y: auto; min-height: 0;`. CommitForm gets `flex-shrink: 0`.

### Pitfall 4: Double graph refresh (watcher + explicit emit)
**What goes wrong:** After a commit, the filesystem watcher fires on the `.git` directory change (debounced 300ms), triggering a second `repo-changed` event on top of the explicit emit from the command. This causes two graph remounts in quick succession.
**Why it happens:** The watcher watches the full repo path recursively, including `.git`. Any git write operation triggers it.
**How to avoid:** This is a known and acceptable behaviour in this project — the second remount is harmless (idempotent). The `CommitCache` was already cleared by the command, so both remounts fetch fresh data. No special handling needed.

### Pitfall 5: Amend on unborn HEAD
**What goes wrong:** Calling `amend_commit` when there is no prior commit (unborn HEAD) crashes with a git2 error.
**Why it happens:** There is nothing to amend.
**How to avoid:** The amend checkbox should only be shown/checkable when there is at least one commit. In CommitForm, derive a `canAmend` boolean. Easiest implementation: `get_head_commit_message` returns an error for unborn HEAD; the checkbox is disabled while that fetch is in-flight or returns an error. Alternatively, disable the checkbox by checking whether `status` has any prior commits (not directly available). Simplest safe approach: the Rust `amend_commit` command returns a clear `TrunkError { code: "no_commit_to_amend", ... }` on unborn HEAD, and the UI surfaces it as an inline error.

### Pitfall 6: Errors not clearing on field edit
**What goes wrong:** User sees an error, edits the subject field to fix it, but the error text stays.
**Why it happens:** Error state only cleared on successful submit, not on field change.
**How to avoid:** Clear `subjectError` in the subject input's `oninput` handler; clear `stagedError` when `amend` is checked or when `stagedCount` changes.

---

## Code Examples

Verified patterns from project codebase:

### git2 signature (COMIT-01)
```rust
// Source: git2 0.19 — repo.signature() reads user.name/email/now() from gitconfig
let sig = repo.signature()?;
// Returns TrunkError (from git2::Error) if user.name or user.email are not configured
```

### git2 commit creation
```rust
// Source: repository.rs make_test_repo() — same pattern used in all tests
let mut index = repo.index()?;
let tree_oid = index.write_tree()?;
let tree = repo.find_tree(tree_oid)?;
repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)?;
```

### git2 amend
```rust
// Source: git2 0.19 Commit::amend signature
// fn amend(
//   &self,
//   update_ref: Option<&str>,
//   author: Option<&Signature<'_>>,
//   committer: Option<&Signature<'_>>,
//   message_encoding: Option<&str>,
//   message: Option<&str>,
//   tree: Option<&Tree<'_>>,
// ) -> Result<Oid, Error>
head_commit.amend(Some("HEAD"), Some(&sig), Some(&sig), None, Some(&message), Some(&tree))?;
```

### CommitCache invalidation
```rust
// Source: repo.rs close_repo — same pattern for cache removal
cache.0.lock().unwrap().remove(&path);
```

### Tauri event emission pattern
```rust
// Source: watcher.rs — app.emit pattern confirmed in project
use tauri::Emitter;
let _ = app.emit("repo-changed", path.clone());
```

### Svelte 5 error state clear on input
```typescript
// Source: established Svelte 5 runes pattern
<input
  bind:value={subject}
  oninput={() => { if (subjectError) subjectError = ''; }}
/>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| git CLI subprocess for commits | git2 Rust API | Pre-phase decision | No subprocess, no shell quoting issues, testable |
| Manual index build | `index.write_tree()` | Standard git2 usage | Automatically reflects staged state |

**No deprecated patterns relevant to this phase.**

---

## Open Questions

1. **Should `get_head_commit_message` be a separate Tauri command or reuse CommitDetail?**
   - What we know: `CommitDetail` DTO already exists in `types.ts` with `summary` and `body` fields. However, it is designed for the Phase 6 diff panel and carries full commit metadata.
   - What's unclear: Whether reusing `CommitDetail` introduces confusion or creates coupling with Phase 6.
   - Recommendation: Add a minimal `HeadCommitMessage { subject: String, body: Option<String> }` DTO to `types.rs` and a dedicated `get_head_commit_message` command. Keeps the surface clean and avoids dependency on Phase 6 structures. Alternatively, `CommitDetail` already has everything needed and could be reused — planner's call based on coupling preference.

2. **Should `stagedCount` be passed as a prop to CommitForm or should CommitForm call `get_status` itself?**
   - What we know: StagingPanel already has `status.staged` available in reactive state.
   - What's unclear: Whether CommitForm should be self-contained or receive data from parent.
   - Recommendation: Pass `stagedCount={status?.staged.length ?? 0}` as a prop. CommitForm should not duplicate the `get_status` call — it already exists in StagingPanel's reactive state. This matches the existing pattern where FileRow receives data as props rather than fetching.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in test (`cargo test`) |
| Config file | none — standard `#[cfg(test)] mod tests` in each `.rs` file |
| Quick run command | `cargo test -p trunk --lib commit -- --nocapture` |
| Full suite command | `cargo test -p trunk` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| COMIT-01 | `create_commit_inner` creates a commit readable by git2 | unit | `cargo test -p trunk --lib commit::tests::create_commit_creates_commit` | ❌ Wave 0 |
| COMIT-01 | `create_commit_inner` handles unborn HEAD (first commit) | unit | `cargo test -p trunk --lib commit::tests::create_commit_unborn_head` | ❌ Wave 0 |
| COMIT-01 | `create_commit_inner` uses gitconfig signature | unit | `cargo test -p trunk --lib commit::tests::create_commit_uses_signature` | ❌ Wave 0 |
| COMIT-02 | Frontend validation blocks empty subject — no Rust test needed | manual | n/a — UI validation only | n/a |
| COMIT-03 | `amend_commit_inner` updates HEAD commit message | unit | `cargo test -p trunk --lib commit::tests::amend_commit_updates_message` | ❌ Wave 0 |
| COMIT-03 | `amend_commit_inner` includes staged changes in amended tree | unit | `cargo test -p trunk --lib commit::tests::amend_commit_includes_staged` | ❌ Wave 0 |
| COMIT-03 | `get_head_commit_message_inner` returns subject and body | unit | `cargo test -p trunk --lib commit::tests::get_head_commit_message_returns_message` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo test -p trunk --lib commit`
- **Per wave merge:** `cargo test -p trunk`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/commit.rs` — all test cases above (file exists as stub, needs `#[cfg(test)] mod tests` block)

*(Svelte component tests are not part of this project's test infrastructure — no vitest/jest configured. Frontend validation is covered by manual smoke testing during verify-work.)*

---

## Sources

### Primary (HIGH confidence)
- Codebase direct inspection: `src-tauri/src/commands/staging.rs`, `src-tauri/src/commands/repo.rs`, `src-tauri/src/commands/branches.rs` — established patterns for inner fns, spawn_blocking, error serialization, cache invalidation
- Codebase direct inspection: `src-tauri/src/watcher.rs` — `app.emit("repo-changed", path)` confirmed
- Codebase direct inspection: `src-tauri/src/state.rs` — `CommitCache` confirmed, removal pattern from `close_repo`
- Codebase direct inspection: `src/components/StagingPanel.svelte` — current layout, `status.staged`, `repo-changed` listener pattern
- Codebase direct inspection: `src/App.svelte` — `handleRefresh()`, `graphKey`, `{#key graphKey}` pattern
- Codebase direct inspection: `src-tauri/src/git/repository.rs` — `make_test_repo()` test helper, `git2::Commit` creation pattern
- Codebase direct inspection: `src-tauri/Cargo.toml` — git2 0.19, tauri 2 confirmed; no new deps needed

### Secondary (MEDIUM confidence)
- git2 0.19 `Commit::amend` API — confirmed from crate documentation pattern; signature matches established git2 usage in codebase

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies confirmed in Cargo.toml; no new packages needed
- Architecture: HIGH — all patterns derived directly from existing codebase files
- Pitfalls: HIGH — CommitCache invalidation confirmed by tracing close_repo; unborn HEAD confirmed from staging.rs; layout pattern confirmed from Phase 3 flex-1 wrapper decision

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable stack; git2 and Svelte 5 APIs not changing rapidly)
