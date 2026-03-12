# Phase 14: Toolbar + Tracking - Research

**Researched:** 2026-03-12
**Domain:** Git ahead/behind tracking, undo/redo commit operations, Svelte 5 toolbar UI
**Confidence:** HIGH

## Summary

Phase 14 adds two distinct features: (1) real ahead/behind counts in the branch sidebar, and (2) Undo/Redo buttons in the existing toolbar. Both features build on well-established patterns already in the codebase.

For ahead/behind, the `BranchInfo` struct and TypeScript interface already have `ahead`/`behind` fields (hardcoded to 0). The `list_refs_inner` function already resolves upstream branches per local branch. The only change is calling `git2::Repository::graph_ahead_behind(local_oid, upstream_oid)` inside the existing iteration loop. This is a single-function enhancement with no new commands needed.

For undo/redo, the existing `reset_to_commit_inner` already performs `git reset --soft` via CLI. The undo command is essentially `git reset --soft HEAD~1` with commit message capture. The redo command is `create_commit_inner` with a saved message. The undo/redo stack lives in frontend Svelte state (ephemeral, not persisted). The toolbar component (`Toolbar.svelte`) already exists with the exact button pattern needed.

**Primary recommendation:** Bundle ahead/behind into `list_refs_inner` (not a separate command) using `repo.graph_ahead_behind()`. Implement undo/redo as two new Tauri commands that reuse existing `reset_to_commit_inner` and `create_commit_inner` patterns. Manage the undo/redo stack as frontend-only `$state`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Arrow badge style: down-arrow + count, up-arrow + count inline after branch name -- compact, GitKraken/Fork style
- Badges right-aligned in the branch row, branch name stays left
- Branches without a remote tracking branch show no badge at all
- Ahead/behind counts displayed in sidebar only
- Counts update automatically after fetch, pull, and push operations complete
- Undo performs `git reset --soft HEAD~1` -- moves HEAD back one commit, restores all changes as staged
- No confirmation dialog for undo -- immediate action on click
- Undo disabled (grayed out) when HEAD is a merge commit -- regular commits only
- Undo disabled when there's nothing to undo (initial commit, no parent)
- Undo allowed even when workdir is dirty
- Multiple undos allowed -- each click undoes one more commit, redo stack grows
- Redo re-commits staged changes with the saved commit message from the undo stack
- Ephemeral memory -- undo/redo stack stored in app state, not persisted across app restarts
- Redo stack cleared when user makes a new commit (standard undo/redo behavior)
- Redo disabled when stack is empty
- Toolbar order: [Undo] [Redo] | [Pull dropdown] [Push] | [Branch] [Stash] [Pop] -- history ops first, then remote, then branch/stash
- Unicode arrows for Undo/Redo -- consistent with existing button icon style
- No tooltips -- matches existing buttons which have no tooltips
- Same disabled styling as Pull/Push during remote ops (opacity 0.5, no pointer events)

### Claude's Discretion
- Ahead/behind computation approach (bundle into list_refs vs separate command)
- Exact badge styling (font size, color values for ahead/behind arrows)
- How the undo/redo stack is managed internally
- Whether redo re-stages files exactly or just commits whatever is currently staged
- Rust implementation details for soft reset (git2 vs git CLI)

### Deferred Ideas (OUT OF SCOPE)
- Undo/Redo for merge commits
- Tooltip showing commit message on hover
- Persistent undo/redo stack across app restarts
- Ahead/behind in status bar
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TRACK-01 | Branch sidebar shows ahead/behind counts relative to upstream | `git2::Repository::graph_ahead_behind` called inside `list_refs_inner` populates existing `BranchInfo.ahead`/`behind` fields; `BranchRow.svelte` renders badges |
| TRACK-02 | Ahead/behind counts update after fetch, pull, and push | Already handled -- remote ops call `refresh_graph` which emits `repo-changed`, sidebar listens via `$effect` on `refreshSignal` and calls `loadRefs` |
| TOOLBAR-01 | Quick actions bar visible with Pull, Push, Branch, Stash, Pop | Already implemented in Phase 13 (`Toolbar.svelte`) -- just needs Undo/Redo buttons prepended |
| TOOLBAR-02 | Undo button performs soft reset of last commit | New `undo_commit` Tauri command: captures HEAD message, calls `git reset --soft HEAD~1`, returns saved message for redo stack |
| TOOLBAR-03 | Redo button re-commits with original message after undo | New `redo_commit` Tauri command: calls `create_commit` with saved subject/body from frontend redo stack |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.19 (vendored-libgit2) | Ahead/behind counting via `graph_ahead_behind` | Already in project; native C binding is fast for rev-list counting |
| git CLI | system | Soft reset (`git reset --soft HEAD~1`) | Established project pattern for mutation ops (cherry-pick, revert, reset all use CLI) |
| Svelte 5 | current | Toolbar UI, reactive undo/redo stack | Project standard |
| Tauri 2 | current | IPC commands | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| serde/serde_json | current | Serialize undo response with captured message | Already in project for all command responses |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| git2 `graph_ahead_behind` | `git rev-list --count` CLI | CLI would be slower (N subprocess spawns for N branches); git2 is O(1) call per branch in-process |
| Frontend undo/redo stack | Tauri managed state | Frontend state is simpler, ephemeral by nature (matches decision), no Rust struct needed |
| CLI for soft reset | git2 `repo.reset()` | CLI matches established pattern; `reset_to_commit_inner` already uses CLI. git2's `reset` requires more boilerplate for the same result |

## Architecture Patterns

### Recommended Approach for Ahead/Behind (Claude's Discretion Decision)

**Decision: Bundle into `list_refs_inner`, not a separate command.**

Rationale:
1. `list_refs_inner` already iterates local branches and resolves upstream -- adding `graph_ahead_behind` is 3 lines per branch
2. A separate command would require a second IPC roundtrip on every sidebar refresh
3. `graph_ahead_behind` is fast (in-process, walks commit graph) -- no measurable performance impact
4. The data is always needed together (branch + its tracking counts)

**Implementation:**
```rust
// Inside the local branch iteration in list_refs_inner
let (ahead, behind) = match &upstream {
    Some(_) => {
        let local_oid = branch.get().target().unwrap_or(git2::Oid::zero());
        match branch.upstream() {
            Ok(upstream_branch) => {
                let upstream_oid = upstream_branch.get().target().unwrap_or(git2::Oid::zero());
                repo.graph_ahead_behind(local_oid, upstream_oid).unwrap_or((0, 0))
            }
            Err(_) => (0, 0),
        }
    }
    None => (0, 0),
};
```

Note: `branch.upstream()` is called twice (once for name, once for OID). This can be optimized by extracting both in a single call.

### Recommended Approach for Undo/Redo Stack (Claude's Discretion Decision)

**Decision: Frontend-only Svelte `$state` array, redo commits whatever is currently staged.**

Rationale:
1. Ephemeral by design (user decision) -- frontend state auto-clears on restart
2. Redo commits "whatever is currently staged" because: (a) after undo, the undone changes ARE staged, so committing staged = exact restore; (b) if user modifies staging between undo and redo, that's intentional; (c) tracking exact file states would require snapshotting tree OIDs, adding complexity for no user benefit
3. Stack is a simple array of `{ subject: string, body: string | null }` objects

**Stack management:**
```typescript
// src/lib/undo-redo.svelte.ts
interface UndoEntry {
  subject: string;
  body: string | null;
}

export const undoRedoState = $state({
  redoStack: [] as UndoEntry[],
  canUndo: false,  // derived from HEAD commit state
  canRedo: false,  // derived from redoStack.length > 0
});
```

### Recommended Approach for Undo Tauri Command (Claude's Discretion Decision)

**Decision: Use git CLI (`git reset --soft HEAD~1`) matching existing `reset_to_commit_inner` pattern.**

The undo command needs to:
1. Read HEAD commit message (subject + body) BEFORE resetting
2. Check HEAD is not a merge commit (parent count > 1)
3. Check HEAD has a parent (not initial commit)
4. Perform `git reset --soft HEAD~1`
5. Return the captured message to frontend

```rust
// New struct for undo response
#[derive(Debug, Serialize, Clone)]
pub struct UndoResult {
    pub subject: String,
    pub body: Option<String>,
}
```

### Pattern: Inner-fn with Cache Repopulate

All mutation commands follow this established pattern:
```
1. _inner function does the git work (testable without Tauri state)
2. Tauri command wrapper: clone state -> spawn_blocking(_inner) -> update cache -> emit repo-changed
```

### Anti-Patterns to Avoid
- **Separate IPC call for ahead/behind:** Would double sidebar load time for no benefit
- **Storing undo stack in Rust state:** Adds unnecessary managed state complexity; frontend state is simpler and naturally ephemeral
- **Using git2 for soft reset:** Would break the established pattern where all CLI mutation ops use subprocess

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Ahead/behind counting | Manual rev-list walking | `repo.graph_ahead_behind(local_oid, upstream_oid)` | git2 wraps libgit2's optimized graph walker; handles all edge cases (shallow clones, grafts) |
| Commit message parsing | String splitting on `\n\n` | `commit.summary()` + `commit.body()` from git2 | Already used in `get_head_commit_message_inner`; handles edge cases like multi-line subjects |

## Common Pitfalls

### Pitfall 1: Double Borrow of Branch for Upstream Resolution
**What goes wrong:** `branch.upstream()` borrows `branch`, but you also need `branch.get().target()` -- calling both in certain orderings can cause borrow issues.
**Why it happens:** git2's `Branch` wrapper holds references to the underlying `Reference`.
**How to avoid:** Extract local OID first (`branch.get().target()`), then call `branch.upstream()` separately. Or collect all data from the branch before moving on.
**Warning signs:** Compile errors about multiple borrows of `branch`.

### Pitfall 2: Zero OID on Unborn Branches
**What goes wrong:** `branch.get().target()` returns `None` for unborn branches, and `graph_ahead_behind` panics or errors on zero OIDs.
**Why it happens:** New repos with no commits have unborn HEAD.
**How to avoid:** Guard with `unwrap_or(git2::Oid::zero())` and skip `graph_ahead_behind` when either OID is zero. Or simply use `unwrap_or((0, 0))` on the result.
**Warning signs:** Crash on brand new repositories.

### Pitfall 3: Redo After New Commit Should Clear Stack
**What goes wrong:** User undoes a commit, then makes a NEW commit (not redo), but redo stack still contains the old commit message.
**Why it happens:** Standard undo/redo semantics require clearing the redo stack on any new action.
**How to avoid:** Listen for `repo-changed` events or hook into `create_commit` success callback to clear `redoStack` when a non-redo commit occurs.
**Warning signs:** Redo button active after making a fresh commit.

### Pitfall 4: Undo on Merge Commits
**What goes wrong:** `git reset --soft HEAD~1` on a merge commit drops the second parent, making redo impossible.
**Why it happens:** Merge commits have multiple parents; soft reset to HEAD~1 only references the first parent.
**How to avoid:** Check `is_merge` (parent count > 1) on HEAD before allowing undo. Disable the button when HEAD is a merge.
**Warning signs:** Loss of merge history after undo.

### Pitfall 5: Ahead/Behind for Branches Without Upstream
**What goes wrong:** Calling `graph_ahead_behind` when there's no upstream causes an error.
**Why it happens:** Not all branches track a remote.
**How to avoid:** Only compute when `upstream` is `Some`. Branches without upstream show no badge (per user decision).
**Warning signs:** Error badges appearing on local-only branches.

## Code Examples

### Ahead/Behind in list_refs_inner
```rust
// Source: Verified against git2 0.19 Repository::graph_ahead_behind signature
// Inside the local branch .map() closure in list_refs_inner:

let local_oid = branch.get().target();
let (ahead, behind) = match (&upstream, local_oid) {
    (Some(_), Some(local)) => {
        branch.upstream()
            .ok()
            .and_then(|ub| ub.get().target())
            .map(|remote| repo.graph_ahead_behind(local, remote).unwrap_or((0, 0)))
            .unwrap_or((0, 0))
    }
    _ => (0, 0),
};

BranchInfo {
    name,
    is_head,
    upstream,
    ahead,
    behind,
    last_commit_timestamp,
}
```

### BranchRow Badge Rendering
```svelte
<!-- Right-aligned badges after branch name -->
<span style="flex-shrink: 0; font-size: 11px; color: var(--color-text-muted); margin-left: 4px;">
  {#if behind > 0}
    <span>↓{behind}</span>
  {/if}
  {#if ahead > 0}
    <span>↑{ahead}</span>
  {/if}
</span>
```

### Undo Command (Rust)
```rust
// New command in a new or existing module
pub fn undo_commit_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<UndoResult, TrunkError> {
    let repo = open_repo(path, state_map)?;
    let head = repo.head()?.peel_to_commit()?;

    // Guard: no parent = nothing to undo
    if head.parent_count() == 0 {
        return Err(TrunkError::new("nothing_to_undo", "No parent commit to undo to"));
    }
    // Guard: merge commit
    if head.parent_count() > 1 {
        return Err(TrunkError::new("merge_commit", "Cannot undo a merge commit"));
    }

    let subject = head.summary().unwrap_or("").to_owned();
    let body = head.body().map(str::to_owned);
    drop(head);
    drop(repo);

    // Perform soft reset via CLI (matches reset_to_commit_inner pattern)
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let output = std::process::Command::new("git")
        .args(["reset", "--soft", "HEAD~1"])
        .current_dir(path_buf)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| TrunkError::new("undo_error", e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TrunkError::new("undo_error", stderr.to_string()));
    }

    Ok(UndoResult { subject, body })
}
```

### Undo/Redo Frontend State
```typescript
// src/lib/undo-redo.svelte.ts
interface UndoEntry {
  subject: string;
  body: string | null;
}

export const undoRedoState = $state({
  redoStack: [] as UndoEntry[],
});

export function pushToRedoStack(entry: UndoEntry) {
  undoRedoState.redoStack = [...undoRedoState.redoStack, entry];
}

export function popFromRedoStack(): UndoEntry | undefined {
  const stack = undoRedoState.redoStack;
  if (stack.length === 0) return undefined;
  const entry = stack[stack.length - 1];
  undoRedoState.redoStack = stack.slice(0, -1);
  return entry;
}

export function clearRedoStack() {
  undoRedoState.redoStack = [];
}
```

### Toolbar Layout (Updated)
```svelte
<!-- Undo/Redo group -->
<button class="toolbar-btn" disabled={!canUndo} onclick={handleUndo}>
  ↩ Undo
</button>
<button class="toolbar-btn" disabled={!canRedo} onclick={handleRedo}>
  ↪ Redo
</button>

<span class="separator"></span>

<!-- Existing Pull/Push/Branch/Stash/Pop buttons unchanged -->
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `git rev-list --count local..upstream` | `git2::graph_ahead_behind` | Always available in git2 | In-process, no subprocess spawn per branch |
| Separate ahead/behind IPC call | Bundled into list_refs | This phase (decision) | Single roundtrip for all sidebar data |

## Open Questions

1. **Upstream resolution double-call optimization**
   - What we know: `branch.upstream()` is called once for the name string, and would need to be called again for OID. This is two libgit2 calls per branch.
   - What's unclear: Whether this is a measurable performance concern for repos with many branches.
   - Recommendation: Refactor to extract both name and OID from a single `branch.upstream()` call. The upstream name and OID should be resolved together before constructing BranchInfo.

2. **canUndo state derivation**
   - What we know: Undo should be disabled when HEAD is a merge commit or initial commit. This information comes from the commit graph data, not a separate query.
   - What's unclear: Best way to derive `canUndo` reactively without an extra IPC call.
   - Recommendation: Derive from the already-loaded graph data. `GraphCommit` already has `is_head`, `is_merge`, and `parent_oids` fields. Find the HEAD commit and check `!is_merge && parent_oids.length > 0`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust `#[cfg(test)]` + cargo test |
| Config file | src-tauri/Cargo.toml (built-in) |
| Quick run command | `cd src-tauri && cargo test` |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TRACK-01 | list_refs returns real ahead/behind for branches with upstream | unit | `cd src-tauri && cargo test branches::tests::list_refs_ahead_behind -x` | No -- Wave 0 |
| TRACK-02 | Ahead/behind updates after remote ops (integration) | manual-only | Manual: fetch then check sidebar | N/A -- event-driven refresh already tested by existing repo-changed flow |
| TOOLBAR-01 | Toolbar has Pull, Push, Branch, Stash, Pop buttons | manual-only | Manual: visual check | N/A -- already implemented in Phase 13 |
| TOOLBAR-02 | undo_commit soft-resets HEAD and returns message | unit | `cd src-tauri && cargo test undo_commit -x` | No -- Wave 0 |
| TOOLBAR-03 | redo uses saved message to recommit | unit | `cd src-tauri && cargo test redo_commit -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test`
- **Per wave merge:** `cd src-tauri && cargo test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `branches::tests::list_refs_ahead_behind` -- test that branches with upstream return non-zero ahead/behind (requires test repo with remote)
- [ ] `undo_commit` tests -- undo returns captured message, undo on merge fails, undo on initial commit fails
- [ ] `redo_commit` tests -- if implemented as separate command (may just reuse `create_commit_inner`)

## Sources

### Primary (HIGH confidence)
- git2 0.19 `Repository::graph_ahead_behind` -- verified signature from [git2-rs source](https://github.com/rust-lang/git2-rs/blob/master/src/repo.rs): `fn graph_ahead_behind(&self, local: Oid, upstream: Oid) -> Result<(usize, usize), Error>`
- Existing codebase -- `list_refs_inner` (branches.rs), `reset_to_commit_inner` (commit_actions.rs), `create_commit_inner` (commit.rs), `Toolbar.svelte`, `BranchRow.svelte`, `BranchSidebar.svelte`

### Secondary (MEDIUM confidence)
- git2 0.19 `Branch::upstream()` returns the tracking branch -- used in existing code, behavior confirmed by codebase usage

### Tertiary (LOW confidence)
- None -- all findings verified against codebase or official sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in project, APIs verified
- Architecture: HIGH -- all patterns match existing codebase conventions exactly
- Pitfalls: HIGH -- derived from direct code analysis of borrow patterns and edge cases

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable -- no moving parts, git2 0.19 is pinned)
