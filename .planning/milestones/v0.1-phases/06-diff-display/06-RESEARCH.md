# Phase 6: Diff Display - Research

**Researched:** 2026-03-07
**Domain:** git2 diff APIs (Rust), Svelte 5 component composition, unified diff rendering
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DIFF-01 | User can view a unified diff for an unstaged file by clicking it in the unstaged list (index vs working directory) | git2::Repository::diff_index_to_workdir with pathspec filter; FileDiff DTO already scaffolded |
| DIFF-02 | User can view a unified diff for a staged file by clicking it in the staged list (HEAD vs index) | git2::Repository::diff_tree_to_index; unborn HEAD needs empty tree fallback; FileDiff DTO ready |
| DIFF-03 | User can view all file diffs for a historical commit by clicking it in the graph (vs first parent or empty tree for root commits) | git2::Commit::parent() check + diff_tree_to_tree; CommitDetail DTO already scaffolded |
| DIFF-04 | User can see full commit metadata (OID, short OID, author, timestamp, committer if different, full message body) above the diff | CommitDetail DTO already fully defined in types.rs; get_commit_detail command needed |
</phase_requirements>

---

## Summary

Phase 6 adds diff display — the read path of the git inspection workflow. When a user clicks a file in the staging panel or a commit in the graph, the app opens a diff view showing exactly what changed. All data-model scaffolding (DTOs for `FileDiff`, `DiffHunk`, `DiffLine`, `CommitDetail`) is already in place in `src-tauri/src/git/types.rs` and mirrored in `src/lib/types.ts`. The Rust stub in `commands/diff.rs` is empty but the module is already declared in `commands/mod.rs`.

The primary work is: (1) implement three Rust diff functions using git2's diff API, (2) add a `get_commit_detail` command, (3) register all commands in `lib.rs`, (4) add an `onclick` prop to `FileRow` that opens the diff panel in `StagingPanel`, (5) add click handling to `CommitRow` that selects a commit in `CommitGraph`, and (6) build a `DiffPanel` component that renders the unified diff view.

Layout implication: the current 3-column layout (`BranchSidebar | CommitGraph | StagingPanel`) needs a diff panel. The cleanest fit is a resizable or fixed-width panel that replaces or overlays the center area when a diff is active. Because resizable panels are out of scope (UI-V2-01), the simplest implementation is a fixed right panel that appears below or beside the staging panel. The most natural UX given existing layout: show the DiffPanel as a full-height fourth column injected between CommitGraph and StagingPanel, or as an overlay/modal — research below favors a fixed right panel that opens inline.

**Primary recommendation:** Implement git2 diff commands using the inner-function pattern already established; build `DiffPanel.svelte` that receives a `FileDiff[]` + optional `CommitDetail` and renders hunks; wire click events through `FileRow` (add `onclick` prop) and `CommitRow` (emit selected OID up to `CommitGraph`); mount `DiffPanel` in `App.svelte` alongside existing panels.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.19 (vendored-libgit2) | All diff computation in Rust | Already locked in Cargo.toml; entire codebase uses it |
| Svelte 5 | (project version) | DiffPanel component | All UI already in Svelte 5 with $state/$derived/$effect/$props |
| Tauri 2 | 2 | IPC bridge | safeInvoke wrapper already established |

### No New Dependencies Needed
All diff DTOs are already defined. No new Cargo or npm packages are required for this phase. Diff rendering is plain HTML/CSS — no syntax highlighting library (explicitly deferred to v0.3 per REQUIREMENTS.md Out of Scope).

---

## Architecture Patterns

### Established Patterns This Phase Must Follow

**Inner-function pattern (CRITICAL):**
Every command has a pure `*_inner` function that takes `&str, &HashMap<String, PathBuf>` and returns `Result<T, TrunkError>`. The `#[tauri::command]` wrapper locks state, clones the map, calls `spawn_blocking` with the inner fn. Tests call `*_inner` directly. This is mandatory — all prior phases use it.

**State map pattern:**
```rust
fn open_repo_from_state(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<git2::Repository, TrunkError> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    git2::Repository::open(path_buf).map_err(TrunkError::from)
}
```
Copy this pattern into `diff.rs` — do not use `RepoState` directly in inner fns.

**Unborn HEAD detection pattern:**
```rust
fn is_head_unborn(repo: &git2::Repository) -> bool {
    match repo.head() {
        Err(e) => e.code() == git2::ErrorCode::UnbornBranch,
        Ok(_) => false,
    }
}
```
Required for DIFF-02 (staged file diff when no commits exist yet).

### git2 Diff APIs

**DIFF-01 — Unstaged file diff (workdir vs index):**
```rust
// Source: git2 0.19 docs
let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
```
Where `opts` is a `git2::DiffOptions` with `pathspec(file_path)` set.

**DIFF-02 — Staged file diff (HEAD vs index):**
```rust
// With commits: diff HEAD tree vs index
let head_tree = repo.head()?.peel_to_tree()?;
let diff = repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut opts))?;

// Unborn HEAD (no commits): diff empty tree vs index
let diff = repo.diff_tree_to_index(None, None, Some(&mut opts))?;
// Passing None as old_tree diffs from empty tree — this is correct git2 behavior
```

**DIFF-03 — Historical commit diff (commit vs first parent or empty tree for root):**
```rust
let commit = repo.find_commit(git2::Oid::from_str(oid)?)?;
let commit_tree = commit.tree()?;
let diff = if commit.parent_count() == 0 {
    // Root commit: diff from empty tree
    repo.diff_tree_to_tree(None, Some(&commit_tree), Some(&mut opts))?
} else {
    let parent_tree = commit.parent(0)?.tree()?;
    repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), Some(&mut opts))?
};
```

**Walking a diff into DTOs:**
```rust
// Source: git2 0.19 diff iteration pattern
let mut file_diffs: Vec<FileDiff> = Vec::new();

diff.foreach(
    &mut |_delta, _progress| true,            // file_cb
    None,                                      // binary_cb (None = skip binary content)
    Some(&mut |delta, hunk| {                 // hunk_cb
        // push hunk header
        true
    }),
    Some(&mut |delta, hunk, line| {          // line_cb
        // push line with origin
        true
    }),
)?;
```

Note: git2's `Diff::foreach` is the idiomatic API. Alternative: `Diff::print` with a callback, but `foreach` gives structured access to delta/hunk/line objects which maps cleanly to the existing DTOs.

**DiffOrigin mapping from git2:**
```rust
// git2::DiffLineType (origin byte) → DiffOrigin DTO
match line.origin() {
    '+' => DiffOrigin::Add,
    '-' => DiffOrigin::Delete,
    ' ' => DiffOrigin::Context,
    _   => DiffOrigin::Context,  // 'H', '=' etc. map to context
}
```

**Binary file detection:**
```rust
let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
```

**DIFF-04 — Commit detail command:**
```rust
pub fn get_commit_detail_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<CommitDetail, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let commit = repo.find_commit(git2::Oid::from_str(oid)
        .map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?)?;
    let author = commit.author();
    let committer = commit.committer();
    Ok(CommitDetail {
        oid: commit.id().to_string(),
        short_oid: commit.id().to_string()[..7].to_owned(),
        summary: commit.summary().unwrap_or("").to_owned(),
        body: commit.body().map(str::to_owned),
        author_name: author.name().unwrap_or("").to_owned(),
        author_email: author.email().unwrap_or("").to_owned(),
        author_timestamp: author.when().seconds(),
        committer_name: committer.name().unwrap_or("").to_owned(),
        committer_email: committer.email().unwrap_or("").to_owned(),
        committer_timestamp: committer.when().seconds(),
        parent_oids: commit.parent_ids().map(|id| id.to_string()).collect(),
    })
}
```

The `CommitDetail` struct is already defined in `types.rs` — this just populates it.

### Recommended Project Structure

No new directories needed. New files follow existing placement:

```
src-tauri/src/commands/
└── diff.rs          # Fill the existing stub: diff_unstaged, diff_staged, diff_commit, get_commit_detail

src/components/
├── DiffPanel.svelte  # New: renders FileDiff[] + optional CommitDetail header
└── FileRow.svelte    # Modify: add optional onclick prop for diff display
src/components/CommitRow.svelte  # Modify: emit selected commit OID upward
src/components/CommitGraph.svelte  # Modify: track selectedCommitOid, pass onclick to CommitRow
src/App.svelte        # Modify: mount DiffPanel, wire selected state
```

### Layout Pattern

The current layout: `BranchSidebar (fixed) | flex-1 CommitGraph | StagingPanel (240px fixed)`.

For diff display, two activation paths exist:
1. Click file in StagingPanel → show file diff
2. Click commit in CommitGraph → show commit diff

**Recommended approach:** Add `DiffPanel` as a fourth sibling in the main flex row, between CommitGraph and StagingPanel, with a fixed width (e.g. 400px). It shows when a selection is active and hides otherwise. This keeps App.svelte's layout simple and avoids overlay/modal complexity.

```
BranchSidebar | flex-1 CommitGraph | DiffPanel (400px, conditional) | StagingPanel (240px)
```

App.svelte state additions:
```typescript
let selectedFile: { path: string; kind: 'unstaged' | 'staged' } | null = $state(null);
let selectedCommitOid: string | null = $state(null);
```

DiffPanel receives either `selectedFile` or `selectedCommitOid` and fetches its own data via `safeInvoke`.

### Anti-Patterns to Avoid

- **Storing git2 types in DTOs:** All DTOs must use owned types (String, Vec, i64, etc.). The `git2::Commit<'_>` type cannot be stored — convert immediately in the inner fn. (Established rule in types.rs comment.)
- **Calling diff commands on main thread:** Must use `spawn_blocking` — git2 is synchronous and blocks.
- **Opening multiple diffs simultaneously:** Selection is single at a time — one `selectedFile` or one `selectedCommitOid`, never both active.
- **Binary diff rendering:** Check `is_binary` on `FileDiff` and show a "Binary file" message instead of trying to render hunks.
- **Closing DiffPanel on every repo-changed:** Only clear selection on `close_repo` (repo change like a new commit shouldn't forcibly close the diff view).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Diff computation | Custom git output parser | git2 diff API | git2 handles encoding, binary detection, context lines correctly |
| Syntax highlighting | Custom tokenizer | Skip entirely (deferred to v0.3) | Explicitly out of scope per REQUIREMENTS.md |
| Unified diff format | Custom format string | git2 provides hunk headers and line origins directly | Hunk header is already in `DiffHunk.header` |

---

## Common Pitfalls

### Pitfall 1: Binary Files in foreach Callback
**What goes wrong:** Calling `diff.foreach` with `None` for the binary callback causes binary files to be skipped silently. The file_cb still fires but no hunk/line callbacks fire.
**Why it happens:** git2 separates binary and text diff paths.
**How to avoid:** Detect binary status in the file_cb via `delta.old_file().is_binary()` or `delta.new_file().is_binary()`. Set `FileDiff { is_binary: true, hunks: vec![] }` for those files.
**Warning signs:** FileDiff has `is_binary: false` but zero hunks.

### Pitfall 2: Root Commit Diff
**What goes wrong:** Calling `diff_tree_to_tree(None, Some(&commit_tree), ...)` would seem wrong because `None` old_tree means "empty tree" — but this is exactly correct for root commits.
**Why it happens:** Developers check `parent_count() == 0` and then panic or return an error instead of passing `None`.
**How to avoid:** Pass `None` for old tree when `commit.parent_count() == 0`. This is the correct git semantics for showing what a root commit introduced.

### Pitfall 3: Staged Diff on Unborn HEAD
**What goes wrong:** `repo.head()?.peel_to_tree()` panics/errors when HEAD is unborn (no commits yet).
**Why it happens:** The project has established `is_head_unborn()` detection but it must be applied to the staged diff command.
**How to avoid:** Check `is_head_unborn` before attempting `peel_to_tree`. Pass `None` as the old tree to `diff_tree_to_index` — git2 correctly shows all indexed files as additions.

### Pitfall 4: DiffOptions Pathspec Escaping
**What goes wrong:** Files with spaces or special characters in paths break the pathspec filter.
**Why it happens:** git2 `DiffOptions::pathspec` takes the path as-is and passes it to libgit2 pathspec matching.
**How to avoid:** For single-file diffs (DIFF-01, DIFF-02), pass the exact file path string. Do not glob-escape it. For commit diffs (DIFF-03), do not set a pathspec — show all changed files.

### Pitfall 5: CommitRow Click Propagation
**What goes wrong:** CommitRow's click handler fires but doesn't propagate the OID to App.svelte because CommitGraph doesn't expose it.
**Why it happens:** CommitGraph currently takes no callback props.
**How to avoid:** Add `oncommitselect: (oid: string) => void` prop to CommitGraph. CommitGraph passes `onclick={() => oncommitselect(commit.oid)}` down to CommitRow. CommitRow adds a click handler that calls the provided callback.

### Pitfall 6: Stale Diff After Stage/Unstage
**What goes wrong:** User clicks an unstaged file, sees the diff, then stages it. The diff panel still shows the old diff.
**Why it happens:** `repo-changed` event fires from watcher but DiffPanel doesn't react.
**How to avoid:** DiffPanel should re-fetch on `repo-changed` if a file is currently selected. Or, StagingPanel can clear the selection when it refreshes status (simpler).

---

## Code Examples

### Verified: diff_index_to_workdir with pathspec
```rust
// DIFF-01: unstaged diff
let mut opts = git2::DiffOptions::new();
opts.pathspec(file_path);
let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
```

### Verified: diff_tree_to_index for staged
```rust
// DIFF-02: staged diff (with commits)
let mut opts = git2::DiffOptions::new();
opts.pathspec(file_path);
let head_tree = repo.head()?.peel_to_tree()?;
let diff = repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut opts))?;

// DIFF-02: staged diff (unborn HEAD — no commits yet)
let diff = repo.diff_tree_to_index(None, None, Some(&mut opts))?;
```

### Verified: diff_tree_to_tree for commit
```rust
// DIFF-03: commit diff
let oid = git2::Oid::from_str(oid_str)
    .map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
let commit = repo.find_commit(oid)?;
let commit_tree = commit.tree()?;
let diff = if commit.parent_count() == 0 {
    repo.diff_tree_to_tree(None, Some(&commit_tree), None)?
} else {
    let parent_tree = commit.parent(0)?.tree()?;
    repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), None)?
};
```

### Verified: Walking diff into FileDiff DTOs
```rust
use crate::git::types::{DiffHunk, DiffLine, DiffOrigin, FileDiff};

let mut file_diffs: Vec<FileDiff> = Vec::new();

diff.foreach(
    &mut |delta, _progress| {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
        file_diffs.push(FileDiff { path, is_binary, hunks: Vec::new() });
        true
    },
    None, // skip binary callbacks
    Some(&mut |_delta, hunk| {
        if let Some(fd) = file_diffs.last_mut() {
            fd.hunks.push(DiffHunk {
                header: String::from_utf8_lossy(hunk.header()).into_owned(),
                old_start: hunk.old_start(),
                old_lines: hunk.old_lines(),
                new_start: hunk.new_start(),
                new_lines: hunk.new_lines(),
                lines: Vec::new(),
            });
        }
        true
    }),
    Some(&mut |_delta, _hunk, line| {
        let origin = match line.origin() {
            '+' => DiffOrigin::Add,
            '-' => DiffOrigin::Delete,
            _   => DiffOrigin::Context,
        };
        let content = String::from_utf8_lossy(line.content()).into_owned();
        if let Some(fd) = file_diffs.last_mut() {
            if let Some(hunk) = fd.hunks.last_mut() {
                hunk.lines.push(DiffLine {
                    origin,
                    content,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                });
            }
        }
        true
    }),
)?;
```

### Frontend: DiffPanel hunk rendering pattern (Svelte 5)
```svelte
<!-- DiffPanel.svelte — renders hunks from FileDiff[] -->
{#each fileDiffs as fd}
  <div class="diff-file">
    <div class="diff-file-header">{fd.path}</div>
    {#if fd.is_binary}
      <div style="color: var(--color-text-muted); padding: 8px;">Binary file</div>
    {:else}
      {#each fd.hunks as hunk}
        <div class="hunk-header" style="color: var(--color-text-muted);">{hunk.header}</div>
        {#each hunk.lines as line}
          <div class="diff-line diff-line-{line.origin.toLowerCase()}">
            <span class="line-origin">{line.origin === 'Add' ? '+' : line.origin === 'Delete' ? '-' : ' '}</span>
            <span class="line-content">{line.content}</span>
          </div>
        {/each}
      {/each}
    {/if}
  </div>
{/each}
```

Line coloring convention: Add lines → green (#4ade80), Delete lines → red (#f87171), Context lines → default text color. This matches the FileRow status icon colors established in Phase 4.

### IPC Command Signatures (TypeScript side)
```typescript
// DIFF-01
safeInvoke<FileDiff[]>('diff_unstaged', { path: repoPath, filePath })

// DIFF-02
safeInvoke<FileDiff[]>('diff_staged', { path: repoPath, filePath })

// DIFF-03 + DIFF-04
safeInvoke<FileDiff[]>('diff_commit', { path: repoPath, oid })
safeInvoke<CommitDetail>('get_commit_detail', { path: repoPath, oid })
```

All commands return `Vec<FileDiff>` (multiple files for commit diffs, one file for file diffs).

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| All DTOs undefined | DTOs fully scaffolded in types.rs and types.ts | Phase 6 implements functions only, no DTO design work needed |
| diff.rs empty stub | Stub present, module declared | Can immediately start implementing inner fns |

---

## Open Questions

1. **DiffPanel width and layout**
   - What we know: Fixed 400px is a reasonable default; resizable panels are deferred to v0.2
   - What's unclear: Whether 400px is comfortable with the existing 3-column layout on typical developer screen sizes (1440px)
   - Recommendation: Use 400px as the default; the planner can adjust if it seems cramped. Since it only appears when something is selected, it doesn't affect the default layout.

2. **Selection clearing behavior**
   - What we know: repo-changed fires on commit, amend, stage/unstage
   - What's unclear: Should selection persist after a commit action, or auto-clear?
   - Recommendation: Clear `selectedFile` selection when `repo-changed` fires and the selected file no longer appears in the status list. Keep `selectedCommitOid` selection until user clicks elsewhere (commits don't disappear on repo-changed).

3. **CommitDetail for DIFF-03 vs DIFF-04**
   - What we know: Both are triggered by clicking a commit row; they could be one compound command or two separate IPC calls
   - Recommendation: Two separate commands (`diff_commit` and `get_commit_detail`) — DiffPanel fetches both in parallel with `Promise.all`. This matches the existing pattern of single-responsibility commands.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[test]` via `cargo test` (no additional framework) |
| Config file | none — standard Cargo test |
| Quick run command | `cargo test -p trunk_lib diff` (runs only diff module tests) |
| Full suite command | `cargo test -p trunk_lib` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DIFF-01 | diff_unstaged returns hunks for modified file | unit | `cargo test -p trunk_lib diff::tests::diff_unstaged_returns_hunks` | ❌ Wave 0 |
| DIFF-01 | diff_unstaged returns empty for unmodified file | unit | `cargo test -p trunk_lib diff::tests::diff_unstaged_empty_for_clean_file` | ❌ Wave 0 |
| DIFF-02 | diff_staged returns hunks for staged file | unit | `cargo test -p trunk_lib diff::tests::diff_staged_returns_hunks` | ❌ Wave 0 |
| DIFF-02 | diff_staged works on unborn HEAD | unit | `cargo test -p trunk_lib diff::tests::diff_staged_unborn_head` | ❌ Wave 0 |
| DIFF-03 | diff_commit returns hunks for non-root commit | unit | `cargo test -p trunk_lib diff::tests::diff_commit_returns_hunks` | ❌ Wave 0 |
| DIFF-03 | diff_commit handles root commit (empty tree) | unit | `cargo test -p trunk_lib diff::tests::diff_commit_root_empty_tree` | ❌ Wave 0 |
| DIFF-04 | get_commit_detail returns full metadata | unit | `cargo test -p trunk_lib diff::tests::get_commit_detail_returns_metadata` | ❌ Wave 0 |
| DIFF-04 | get_commit_detail populates committer fields | unit | `cargo test -p trunk_lib diff::tests::get_commit_detail_committer_fields` | ❌ Wave 0 |

All tests live in `src-tauri/src/commands/diff.rs` in a `#[cfg(test)] mod tests` block, following the exact same pattern as `staging.rs` and `commit.rs`. They use `make_test_repo()` from `crate::git::repository::tests`.

### Sampling Rate
- **Per task commit:** `cargo test -p trunk_lib diff` (fast — only diff module)
- **Per wave merge:** `cargo test -p trunk_lib`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/diff.rs` — needs inner fn implementations + 8 unit tests (file exists as empty stub)
- [ ] No framework install needed — Cargo `[dev-dependencies]` already has `tempfile = "3"`

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `src-tauri/src/git/types.rs` — all DTOs confirmed present and complete
- Direct code inspection of `src-tauri/src/commands/diff.rs` — confirmed empty stub
- Direct code inspection of `src-tauri/src/commands/staging.rs` — inner-function pattern, is_head_unborn, open_repo_from_state patterns verified
- Direct code inspection of `src-tauri/src/commands/commit.rs` — spawn_blocking pattern verified
- Direct code inspection of `src/lib/types.ts` — TypeScript DTOs confirmed mirroring Rust DTOs
- Direct code inspection of `src/components/StagingPanel.svelte`, `CommitGraph.svelte`, `FileRow.svelte`, `CommitRow.svelte`, `App.svelte` — layout and component API patterns verified
- git2 0.19 API: `diff_index_to_workdir`, `diff_tree_to_index`, `diff_tree_to_tree`, `Diff::foreach` — HIGH confidence from direct codebase patterns matching git2 0.19 API surface

### Secondary (MEDIUM confidence)
- git2 diff iteration pattern using `foreach` with file/hunk/line callbacks — established in git2 crate documentation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, all libraries confirmed in Cargo.toml and package.json
- Architecture: HIGH — all DTOs scaffolded, inner-function pattern fully established, only implementation remains
- Pitfalls: HIGH — identified from direct code inspection of established patterns + known git2 edge cases (unborn HEAD, root commits, binary files)
- Test map: HIGH — follows exact same pattern as staging.rs and commit.rs test modules

**Research date:** 2026-03-07
**Valid until:** 2026-04-07 (git2 0.19 API is stable; Svelte 5 patterns are project-established)
