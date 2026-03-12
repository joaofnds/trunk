# Phase 12: Commit Context Menu - Research

**Researched:** 2026-03-11
**Domain:** Tauri 2 native context menus, git2 checkout/tag, git CLI cherry-pick/revert
**Confidence:** HIGH

## Summary

Phase 12 adds a right-click context menu to every commit row in the graph, enabling copy SHA/message, checkout (detached HEAD), create branch from commit, create tag, cherry-pick, and revert. The codebase already has all the patterns needed: the stash context menu in BranchSidebar.svelte demonstrates `Menu.new()` + `MenuItem.new()` + `menu.popup()`, the `ask()` dialog for confirmations, and `safeInvoke` for IPC calls. The stash command module (stash.rs) shows the exact pattern for graph-mutating commands: inner function returns `GraphResult`, outer `#[tauri::command]` updates `CommitCache` and emits `repo-changed`.

Two new dependencies are required: `@tauri-apps/plugin-clipboard-manager` (JS) + `tauri-plugin-clipboard-manager` (Rust) for copy-to-clipboard. For branch and tag name input, Tauri's dialog plugin has no native text prompt -- a lightweight Svelte modal component is needed. Cherry-pick and revert shell out to `git` CLI per established project decision (avoids reimplementing conflict state machine).

**Primary recommendation:** Follow the stash command pattern exactly -- `_inner` functions returning `GraphResult`, cache update + `repo-changed` emit in outer command. Use `MenuItem.new({ enabled: false })` for disabled cherry-pick/revert on merge commits. Add clipboard plugin for copy actions. Build a minimal Svelte input dialog for branch name and tag name/message.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Branch Creation UX: Native dialog for branch name input, name field starts empty, always checkout new branch after creation (no checkbox), dirty workdir shows error (user stashes manually)
- Tag Creation UX: Annotated tags only (name + optional message), native dialog with name field + message textarea, empty message uses tag name as message, no push-to-remote
- Merge Commit Disabled Items: Cherry-pick and revert greyed out (native disabled menu items) for merge commits, not hidden, no label change or tooltip
- Detached HEAD Checkout: Always show confirmation dialog with specific copy: "Checkout this commit in detached HEAD mode? You won't be on any branch. Create a branch afterward to save your work." with OK/Cancel, dirty workdir shows error after confirmation

### Claude's Discretion
- Exact Rust implementation for `checkout_commit`, `create_tag`, `cherry_pick`, `revert_commit`
- How `create_branch` is extended to accept an optional `from_oid` parameter
- How cherry-pick and revert invoke git CLI vs git2
- Error message copy for dirty workdir and other failure cases
- Context menu item ordering and separator placement

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MENU-01 | Copy commit SHA to clipboard | Clipboard plugin (`writeText`), `MenuItem` in context menu |
| MENU-02 | Copy commit message to clipboard | Clipboard plugin (`writeText`), commit `summary` already in `GraphCommit` |
| MENU-03 | Checkout commit in detached HEAD mode | `repo.set_head_detached(oid)` via git2, `is_dirty()` check, `ask()` confirmation dialog |
| MENU-04 | Create branch from commit with auto-checkout | Extend `create_branch_inner` with `from_oid: Option<String>`, Svelte input dialog for name |
| MENU-05 | Create tag from commit | git2 `repo.tag()` for annotated tags, Svelte input dialog for name+message |
| MENU-06 | Cherry-pick (disabled for merge commits) | Git CLI subprocess (`git cherry-pick <oid>`), `MenuItem.new({ enabled: !commit.is_merge })` |
| MENU-07 | Revert (disabled for merge commits) | Git CLI subprocess (`git revert <oid> --no-edit`), `MenuItem.new({ enabled: !commit.is_merge })` |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@tauri-apps/api/menu` | 2.x (bundled) | Native context menu | Already used for header + stash menus |
| `@tauri-apps/plugin-dialog` | ^2.6.0 | Confirmation dialogs | Already installed, used for ask/confirm |
| `@tauri-apps/plugin-clipboard-manager` | ^2.x | Copy SHA/message to clipboard | Official Tauri plugin for clipboard |
| `tauri-plugin-clipboard-manager` | 2.x | Rust-side clipboard plugin | Required for JS clipboard to work |
| `git2` | 0.19 | checkout_commit, create_tag, create_branch | Already used for all git2 operations |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `std::process::Command` | stdlib | Cherry-pick and revert via git CLI | For operations that need conflict state machine |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Svelte input dialog | Tauri webview window | Over-engineered for a text input; Svelte dialog is simpler and consistent |
| git2 for cherry-pick | git CLI | git2 lacks cherry-pick/revert high-level API; CLI handles conflict state correctly |
| `navigator.clipboard.writeText` | Tauri clipboard plugin | Web API may not work in Tauri webview on all platforms; plugin is reliable |

**Installation:**
```bash
npm install @tauri-apps/plugin-clipboard-manager
cargo add tauri-plugin-clipboard-manager -p trunk
```

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/commands/
├── branches.rs          # extend create_branch_inner with from_oid
├── commits.rs           # NEW: checkout_commit, create_tag, cherry_pick, revert_commit
├── mod.rs               # add pub mod commits (not to be confused with existing commit.rs)
src/components/
├── CommitRow.svelte     # add oncontextmenu prop/handler
├── CommitGraph.svelte   # wire context menu, handle actions
├── InputDialog.svelte   # NEW: reusable Svelte modal for text input
```

Note: The new file should be named something distinct from existing `commit.rs`. Options: `commit_actions.rs` or keep as separate commands added to `branches.rs`. Recommendation: create `commit_actions.rs` to avoid confusion with `commit.rs` (which handles create/amend).

### Pattern 1: Graph-Mutating Command (established)
**What:** Every backend command that changes repo state follows: inner fn does work + walks graph -> outer fn updates CommitCache + emits `repo-changed`
**When to use:** checkout_commit, create_branch (from oid), create_tag, cherry_pick, revert_commit
**Example:**
```rust
// Source: stash.rs established pattern
pub fn checkout_commit_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let repo = open_repo(path, state_map)?;
    if is_dirty(&repo)? {
        return Err(TrunkError::new("dirty_workdir", "Working tree has uncommitted changes. Stash or commit before checkout."));
    }
    let obj = repo.revparse_single(oid)?;
    repo.set_head_detached(obj.id())?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().safe()))?;
    drop(repo);
    // Re-walk graph
    let path_buf = state_map.get(path).ok_or_else(|| TrunkError::new("not_open", ""))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo2, 0, usize::MAX).map_err(TrunkError::from)
}
```

### Pattern 2: Native Context Menu with Disabled Items
**What:** Build menu dynamically based on commit properties (is_merge)
**When to use:** CommitRow right-click
**Example:**
```typescript
// Source: BranchSidebar.svelte stash menu pattern + disabled items
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

async function showCommitMenu(e: MouseEvent, commit: GraphCommit) {
    e.preventDefault();
    const menu = await Menu.new({
        items: [
            await MenuItem.new({ text: 'Copy SHA', action: () => handleCopySha(commit) }),
            await MenuItem.new({ text: 'Copy Message', action: () => handleCopyMessage(commit) }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await MenuItem.new({ text: 'Checkout Commit...', action: () => handleCheckout(commit) }),
            await MenuItem.new({ text: 'Create Branch...', action: () => handleCreateBranch(commit) }),
            await MenuItem.new({ text: 'Create Tag...', action: () => handleCreateTag(commit) }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await MenuItem.new({ text: 'Cherry-pick', enabled: !commit.is_merge, action: () => handleCherryPick(commit) }),
            await MenuItem.new({ text: 'Revert', enabled: !commit.is_merge, action: () => handleRevert(commit) }),
        ]
    });
    await menu.popup();
}
```

### Pattern 3: Git CLI Subprocess for Cherry-pick/Revert
**What:** Shell out to `git` for operations that git2 does not expose at a high level
**When to use:** Cherry-pick, revert (and later: fetch, pull, push in Phase 13)
**Example:**
```rust
use std::process::Command;

pub fn cherry_pick_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;

    let output = Command::new("git")
        .args(["cherry-pick", oid])
        .current_dir(path_buf)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("conflict") {
            return Err(TrunkError::new("conflict_state", "Cherry-pick resulted in conflicts. Resolve them manually."));
        }
        return Err(TrunkError::new("cherry_pick_error", stderr.to_string()));
    }

    let mut repo = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}
```

### Pattern 4: Svelte Input Dialog
**What:** Lightweight modal for text input since Tauri dialog plugin lacks prompt()
**When to use:** Branch name input, tag name + message input
**Example:**
```svelte
<!-- InputDialog.svelte -->
<script lang="ts">
  interface Props {
    title: string;
    fields: { key: string; label: string; placeholder?: string; multiline?: boolean; required?: boolean }[];
    onsubmit: (values: Record<string, string>) => void;
    oncancel: () => void;
  }
  let { title, fields, onsubmit, oncancel }: Props = $props();
  let values = $state<Record<string, string>>({});
</script>

{#if true}
<div class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.5);">
  <div class="rounded-lg p-4 w-80" style="background: var(--color-surface); border: 1px solid var(--color-border);">
    <h3 class="text-sm font-medium mb-3" style="color: var(--color-text);">{title}</h3>
    {#each fields as field}
      <label class="block text-xs mb-1" style="color: var(--color-text-muted);">{field.label}</label>
      {#if field.multiline}
        <textarea bind:value={values[field.key]} placeholder={field.placeholder} class="w-full rounded px-2 py-1 text-sm mb-2" style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text);" rows="3"></textarea>
      {:else}
        <input bind:value={values[field.key]} placeholder={field.placeholder} class="w-full rounded px-2 py-1 text-sm mb-2" style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text);" />
      {/if}
    {/each}
    <div class="flex justify-end gap-2 mt-2">
      <button onclick={oncancel} class="px-3 py-1 text-xs rounded" style="color: var(--color-text-muted);">Cancel</button>
      <button onclick={() => onsubmit(values)} class="px-3 py-1 text-xs rounded" style="background: var(--color-accent); color: white;">OK</button>
    </div>
  </div>
</div>
{/if}
```

### Anti-Patterns to Avoid
- **Opening a second Tauri webview window for input:** Over-engineered; a simple Svelte overlay is much simpler and consistent with the app's feel
- **Using git2 for cherry-pick/revert:** git2 does not expose high-level cherry-pick/revert; you would have to manually implement merge, index update, conflict detection -- the git CLI handles all of this
- **Forgetting `GIT_TERMINAL_PROMPT=0`:** Without this env var, git CLI may hang waiting for user input (credentials, merge editor) in a headless context
- **Not re-walking graph after mutations:** Every graph-mutating command MUST repopulate CommitCache before emitting `repo-changed` or the UI will show stale data

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Clipboard access | Custom IPC command | `@tauri-apps/plugin-clipboard-manager` writeText | Cross-platform clipboard is OS-specific; plugin handles it |
| Cherry-pick logic | Manual merge + index update via git2 | `git cherry-pick <oid>` via Command | Conflict detection, 3-way merge, index update are complex; CLI does it right |
| Revert logic | Manual reverse-diff + apply via git2 | `git revert <oid> --no-edit` via Command | Same complexity as cherry-pick; CLI handles edge cases |
| Confirmation dialogs | Custom HTML dialog | `@tauri-apps/plugin-dialog` ask() | Already used in codebase, native OS look |
| Detached HEAD detection | Manual ref parsing | git2 `repo.head_detached()` | One-liner API vs parsing refs manually |

**Key insight:** Cherry-pick and revert are the only commands that shell out to git CLI in this phase. Everything else (checkout, branch, tag) uses git2 directly, matching the established codebase pattern.

## Common Pitfalls

### Pitfall 1: Dirty Workdir Check Timing
**What goes wrong:** User confirms checkout, but workdir is dirty -- error appears after confirmation
**Why it happens:** CONTEXT.md specifies: show confirmation first, then check dirty state
**How to avoid:** Follow the exact flow: (1) ask() confirmation -> (2) check is_dirty -> (3) perform checkout. If dirty, return error AFTER confirmation was accepted.
**Warning signs:** Error appearing before confirmation dialog

### Pitfall 2: Borrow Checker with repo + graph walk
**What goes wrong:** Cannot call `graph::walk_commits(&mut repo)` after operations that consumed or borrowed repo
**Why it happens:** git2::Repository borrows propagate through operations
**How to avoid:** Drop the first repo handle, then reopen for graph walk (established pattern in checkout_branch_inner and stash commands)
**Warning signs:** Compile error about mutable borrow

### Pitfall 3: Cherry-pick/Revert Conflict State
**What goes wrong:** Command returns success but repo is in conflict state
**Why it happens:** Git cherry-pick with conflicts exits non-zero, but partial apply may leave index in merge state
**How to avoid:** Check `output.status.success()` AND scan stderr for "conflict". Return a `conflict_state` error code so the UI can show an appropriate message.
**Warning signs:** Cherry-pick appears to succeed but staging panel shows conflicted files

### Pitfall 4: Annotated Tag Requires Signature
**What goes wrong:** `repo.tag()` fails because no signature is available
**Why it happens:** Annotated tags require a tagger signature (unlike lightweight tags)
**How to avoid:** Use `repo.signature()` to get the configured user identity before calling `repo.tag()`
**Warning signs:** "config value 'user.email' was not found" error

### Pitfall 5: Context Menu on WIP/Stash Rows
**What goes wrong:** Right-clicking the WIP sentinel row or a stash synthetic row opens the commit context menu
**Why it happens:** WIP row (oid `__wip__`) and stash rows (oid `__stash_N__`) go through the same CommitRow component
**How to avoid:** Check `commit.oid` prefix before showing context menu -- skip for `__wip__` and `__stash_` prefixed OIDs
**Warning signs:** Nonsensical actions (cherry-pick WIP) appearing in menu

### Pitfall 6: Clipboard Permission Not Configured
**What goes wrong:** `writeText()` throws a permission error at runtime
**Why it happens:** Tauri 2 requires explicit capability permissions for clipboard
**How to avoid:** Add `clipboard-manager:allow-write-text` to `src-tauri/capabilities/default.json`
**Warning signs:** "Not allowed" error on copy action

### Pitfall 7: `--no-edit` Required for Revert
**What goes wrong:** `git revert` opens an editor in the subprocess, blocking forever
**Why it happens:** Without `--no-edit`, git revert launches `$EDITOR` for the commit message
**How to avoid:** Always pass `--no-edit` flag to `git revert`. Also set `GIT_TERMINAL_PROMPT=0`.
**Warning signs:** Command hangs indefinitely

## Code Examples

### Checkout Commit (Detached HEAD) via git2
```rust
// Source: Adapted from checkout_branch_inner in branches.rs
pub fn checkout_commit_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let repo = open_repo(path, state_map)?;
    if is_dirty(&repo)? {
        return Err(TrunkError::new("dirty_workdir", "Working tree has uncommitted changes. Stash or commit before checking out."));
    }
    let obj = repo.revparse_single(oid)?;
    repo.checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().safe()))?;
    repo.set_head_detached(obj.id())?;
    drop(repo);
    // Re-walk graph
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo2, 0, usize::MAX).map_err(TrunkError::from)
}
```

### Create Annotated Tag via git2
```rust
// Source: git2 docs for Repository::tag
pub fn create_tag_inner(
    path: &str,
    oid: &str,
    tag_name: &str,
    message: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let repo = open_repo(path, state_map)?;
    let obj = repo.revparse_single(oid)?;
    let sig = repo.signature()?;
    let msg = if message.trim().is_empty() { tag_name } else { message };
    repo.tag(tag_name, &obj, &sig, msg, false)?;
    drop(repo);
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo2, 0, usize::MAX).map_err(TrunkError::from)
}
```

### Extend create_branch with from_oid
```rust
// Source: Adapted from existing create_branch_inner in branches.rs
pub fn create_branch_inner(
    path: &str,
    name: &str,
    from_oid: Option<&str>,  // NEW parameter
    state_map: &HashMap<String, PathBuf>,
    cache_map: &mut HashMap<String, GraphResult>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    // Resolve target commit: from_oid if provided, otherwise HEAD
    let target_oid = match from_oid {
        Some(oid_str) => {
            let obj = repo.revparse_single(oid_str)?;
            obj.id()
        }
        None => repo.head()?.target().ok_or_else(|| {
            TrunkError::new("git_error", "HEAD has no target (unborn branch?)")
        })?,
    };
    let target_commit = repo.find_commit(target_oid)?;
    repo.branch(name, &target_commit, false)?;
    drop(target_commit);
    // Auto-checkout + dirty check
    if is_dirty(&repo)? {
        return Err(TrunkError::new("dirty_workdir", "Working tree has uncommitted changes. Stash or commit first."));
    }
    repo.set_head(&format!("refs/heads/{}", name))?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().safe()))?;
    drop(repo);
    // Rebuild cache
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    let graph_result = graph::walk_commits(&mut repo2, 0, usize::MAX)?;
    cache_map.insert(path.to_owned(), graph_result);
    Ok(())
}
```

### Copy to Clipboard (Frontend)
```typescript
// Source: @tauri-apps/plugin-clipboard-manager docs
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

async function handleCopySha(commit: GraphCommit) {
    await writeText(commit.oid);
}

async function handleCopyMessage(commit: GraphCommit) {
    await writeText(commit.summary);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `navigator.clipboard.writeText` | Tauri clipboard plugin | Tauri 2 | Web API unreliable in webview; plugin provides cross-platform guarantee |
| Tauri v1 `dialog.prompt()` | No native prompt in v2 | Tauri 2 | Must use custom Svelte dialog for text input |
| git2 for all operations | git CLI for cherry-pick/revert | Project decision (v0.3) | Avoids reimplementing conflict state machine |

**Deprecated/outdated:**
- Tauri v1 had a `dialog.prompt()` API for text input. Tauri v2 removed it. Use a Svelte modal instead.

## Open Questions

1. **Context menu naming for "commit_actions.rs" vs extending existing files**
   - What we know: `commit.rs` handles create/amend, `branches.rs` handles checkout/create_branch
   - What's unclear: Best module organization for new commands
   - Recommendation: Create `commit_actions.rs` for checkout_commit, create_tag, cherry_pick, revert_commit. Extend `branches.rs` only for the `from_oid` parameter on create_branch. This keeps modules focused.

2. **InputDialog component reusability**
   - What we know: Need input for branch name (1 field) and tag (2 fields: name + message)
   - What's unclear: Whether to make a generic component or two specific ones
   - Recommendation: One generic `InputDialog.svelte` with configurable fields array. Reusable for future phases.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust `#[cfg(test)]` + `cargo test` |
| Config file | Standard Cargo test runner |
| Quick run command | `cargo test -p trunk --lib -- commit_actions` |
| Full suite command | `cargo test -p trunk --lib` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MENU-01 | Copy SHA to clipboard | manual-only | N/A (clipboard requires OS context) | N/A |
| MENU-02 | Copy message to clipboard | manual-only | N/A (clipboard requires OS context) | N/A |
| MENU-03 | Checkout commit detached HEAD | unit | `cargo test -p trunk --lib -- commit_actions::tests::checkout_commit` | No - Wave 0 |
| MENU-04 | Create branch from commit | unit | `cargo test -p trunk --lib -- branches::tests::create_branch_from_oid` | No - Wave 0 |
| MENU-05 | Create tag from commit | unit | `cargo test -p trunk --lib -- commit_actions::tests::create_tag` | No - Wave 0 |
| MENU-06 | Cherry-pick non-merge commit | unit | `cargo test -p trunk --lib -- commit_actions::tests::cherry_pick` | No - Wave 0 |
| MENU-07 | Revert non-merge commit | unit | `cargo test -p trunk --lib -- commit_actions::tests::revert` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo test -p trunk --lib -- commit_actions`
- **Per wave merge:** `cargo test -p trunk --lib`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/commit_actions.rs` -- tests for checkout_commit, create_tag, cherry_pick, revert_commit
- [ ] Update `branches.rs` tests -- test create_branch_inner with from_oid parameter
- [ ] MENU-01, MENU-02 are manual-only (clipboard requires native OS context, cannot be tested headlessly)

## Sources

### Primary (HIGH confidence)
- Project codebase: `src-tauri/src/commands/stash.rs` -- established graph-mutating command pattern
- Project codebase: `src-tauri/src/commands/branches.rs` -- checkout_branch_inner, create_branch_inner, is_dirty()
- Project codebase: `src/components/BranchSidebar.svelte` -- stash entry context menu pattern (Menu.new + MenuItem.new + popup)
- Project codebase: `src/components/CommitGraph.svelte` -- header context menu with CheckMenuItem
- [Tauri Clipboard Plugin docs](https://v2.tauri.app/plugin/clipboard/) -- writeText API, installation, permissions
- [Tauri Dialog Plugin docs](https://v2.tauri.app/reference/javascript/dialog/) -- ask(), confirm(), message() (no prompt)

### Secondary (MEDIUM confidence)
- [Tauri Menu API](https://v2.tauri.app/reference/javascript/api/namespacemenu/) -- MenuItem enabled property, PredefinedMenuItem separator
- git2 0.19 API: `Repository::set_head_detached()`, `Repository::tag()`, `Repository::signature()`

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all patterns established in codebase, clipboard plugin is official Tauri plugin
- Architecture: HIGH -- follows exact patterns from Phase 11 stash commands and context menus
- Pitfalls: HIGH -- identified from direct codebase analysis and established project decisions

**Research date:** 2026-03-11
**Valid until:** 2026-04-11 (stable dependencies, no fast-moving APIs)
