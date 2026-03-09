# Phase 3: Branch Sidebar + Checkout - Research

**Researched:** 2026-03-04
**Domain:** Svelte 5 sidebar components, git2 branch/checkout/stash APIs, Tauri IPC command patterns
**Confidence:** HIGH

## Summary

Phase 3 adds a branch/tag/stash sidebar to the existing Tauri+Svelte 5 app, wiring it into the 3-pane layout (sidebar | commit graph | staging placeholder). All TypeScript DTOs (`BranchInfo`, `RefsResponse`) and Rust structs are already defined. The Rust command file (`branches.rs`) is stubbed. The key work is implementing the four Rust commands and building the Svelte sidebar component.

The Rust side uses `git2::Repository::branches(Some(BranchType::Local/Remote))` for branch listing, `repo.statuses()` to detect dirty working tree before checkout, `repo.set_head()` + `repo.checkout_head()` for the checkout operation itself, and `repo.branch()` to create a new branch. The Svelte side is a single `BranchSidebar.svelte` component with collapsible sections, frontend-only search via `$derived`, and an inline error banner for `dirty_workdir` errors.

No new dependencies are needed: all git2 APIs required exist in the already-pinned `git2 = "0.19"`. No new Tauri plugins are needed. All CSS custom properties used are already defined in `app.css`.

**Primary recommendation:** Implement four Rust commands (`list_refs`, `checkout_branch`, `create_branch`, `refresh_refs`), wire them into `generate_handler![]` in `lib.rs`, then build `BranchSidebar.svelte` following the established Svelte 5 runes pattern from `CommitGraph.svelte`.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Branch item display**
- Name only per row — no ahead/behind counts, no timestamps
- Active HEAD branch: accent color + bold text (consistent with existing RefPill.svelte HEAD styling)
- Remote branches: grouped by remote name — a "origin" sub-header, then short branch names ("main", "dev") underneath. Not flat full names ("origin/main")
- Row height: compact, ~26px — same as commit graph rows

**Section defaults + collapsibility**
- Local branches section expanded by default; Remote, Tags, Stashes collapsed by default
- Section state always resets to defaults on repo open — no persistence across sessions
- Empty sections are hidden entirely (if no tags exist, no Tags section renders)
- Section headers show item count: "Local (4)", "Remote (12)"

**Create branch flow**
- Trigger: small `+` icon button in the Local section header
- UI: clicking `+` shows an inline text input at the top of the Local section; Enter creates, Escape cancels
- Always creates from HEAD — "from specific OID" path deferred (out of scope for Phase 3)
- Auto-checkout after create: yes — new branch immediately becomes HEAD and is highlighted

**Checkout behavior**
- Clicking a branch name triggers checkout
- Subtle loading state on the branch row while the async Rust command runs
- On success: active branch highlight updates, commit graph refreshes to reflect new HEAD
- On `dirty_workdir` error: inline error banner appears below the branch row that was clicked
- Error text: "Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first."
- Banner dismisses automatically when user takes any new action (clicks another branch, types in search, etc.)
- No action buttons in the banner (stash/discard are v0.1 out of scope)

### Claude's Discretion
- Exact sidebar width (fixed, not resizable in v0.1)
- Remote sub-group header styling (indented text, chevron toggle, etc.)
- Inline input styling for new branch creation
- Loading indicator style on branch row (muted color, spinner icon, etc.)
- Search input placement (top of sidebar vs sticky above sections)

### Deferred Ideas (OUT OF SCOPE)
- "Create branch from specific commit OID" — deferred
- Sidebar collapse/expand state persistence per repo — needs Tauri store, deferred
- Stash create/pop — stashes listed read-only only
- Delete branch from sidebar — not in BRNCH requirements, deferred
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BRNCH-01 | User can see all local branches, remote branches, tags, and stashes in collapsible sidebar sections with the active branch highlighted | `git2::Repository::branches()` with `BranchType::Local`/`BranchType::Remote`, `repo.tag_foreach()` for tags, `repo.stash_foreach()` for stashes. DTOs `BranchInfo` and `RefsResponse` already defined. |
| BRNCH-02 | User can filter the branch list by typing a search string; filtering happens on the frontend without a round-trip to Rust | Frontend-only: `$derived` rune in Svelte 5 computes filtered list from `$state` search string and fetched refs. No backend involvement. |
| BRNCH-03 | User can checkout a local branch; if the working tree is dirty, an inline error banner appears with instructions and the branch does not switch | Rust: `repo.statuses()` detects dirty tree (emit `dirty_workdir` error code), then `repo.set_head()` + `repo.checkout_head()` if clean. Frontend: match on `code === 'dirty_workdir'` from `safeInvoke`. |
| BRNCH-04 | User can create a new local branch, optionally from a specific commit OID | Rust: `repo.branch(name, &head_commit, false)` creates branch from HEAD. Auto-checkout after create via same checkout path. "From specific OID" is out of scope per deferred list. |
</phase_requirements>

---

## Standard Stack

### Core (No New Dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.19 (already in Cargo.toml) | Branch listing, checkout, stash enumeration, status check | Already vendor-compiled; all needed APIs present |
| Svelte 5 runes | ^5.0.0 (already in package.json) | Reactive sidebar state ($state, $derived, $effect) | Established pattern from CommitGraph.svelte |
| Tailwind CSS v4 | ^4.2.1 (already in package.json) | Sidebar layout and utility classes | Established project styling |
| @tauri-apps/api | ^2 (already in package.json) | `invoke` for Rust commands via `safeInvoke` | Project-wide IPC wrapper |

### No New npm or Cargo Dependencies Required

All git2 APIs needed (`branches()`, `statuses()`, `set_head()`, `checkout_head()`, `branch()`, `stash_foreach()`, `tag_foreach()`) exist in git2 0.19. No icons library is needed — Unicode chevrons (▶ / ▼) or simple SVG arrows suffice for section toggles and loading spinners can use CSS animation on a Unicode character or simple SVG.

### Existing CSS Custom Properties Available (from app.css)

| Property | Value | Use in Sidebar |
|----------|-------|---------------|
| `--color-bg` | `#0d1117` | Sidebar background |
| `--color-surface` | `#161b22` | Hover state on branch rows, search input bg |
| `--color-border` | `#30363d` | Section header borders, input border |
| `--color-text` | `#c9d1d9` | Branch name text |
| `--color-text-muted` | `#8b949e` | Section count "(4)", remote sub-headers |
| `--color-accent` | `#388bfd` | HEAD branch highlight, active branch bold |

---

## Architecture Patterns

### Recommended Component Structure

```
src/
├── components/
│   ├── BranchSidebar.svelte      # Top-level sidebar: search, sections, error state
│   ├── BranchSection.svelte      # Reusable collapsible section (Local/Remote/Tags/Stashes)
│   ├── BranchRow.svelte          # Single branch row with loading state + error banner
│   └── RemoteGroup.svelte        # Remote sub-header grouping (e.g. "origin")
src-tauri/src/
├── commands/
│   └── branches.rs               # Four new commands: list_refs, checkout_branch, create_branch (no separate refresh — list_refs is the refresh)
```

### Layout Update in App.svelte

Current App.svelte:
```
TabBar | (WelcomeScreen OR CommitGraph)
```

Phase 3 update:
```
TabBar | (WelcomeScreen OR (BranchSidebar + CommitGraph side-by-side))
```

```svelte
<!-- App.svelte - Phase 3 layout -->
<main class="flex-1 overflow-hidden flex">
  <BranchSidebar {repoPath} oncheckout={handleRefresh} />
  <CommitGraph {repoPath} bind:this={graphRef} />
  <!-- Phase 4 adds StagingPanel here -->
</main>
```

After checkout/branch-create, both the sidebar and commit graph must refresh. Pass an `oncheckout` callback up from `BranchSidebar` to `App.svelte`, which then triggers a refresh of `CommitGraph`.

### Pattern 1: Rust Command — Dirty-Tree-Guarded Checkout

**What:** Before calling `set_head` + `checkout_head`, check `repo.statuses()` for any INDEX_* or WT_* flags (excluding IGNORED and CURRENT). If any modified/new/deleted files exist, return `TrunkError { code: "dirty_workdir", ... }` without touching HEAD.

**When to use:** Every branch checkout invocation.

```rust
// Source: docs.rs/git2/latest/git2/struct.Repository.html + git2 Status flags
use git2::{Status, StatusOptions};

fn is_dirty(repo: &git2::Repository) -> Result<bool, git2::Error> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(false); // untracked files don't block checkout
    opts.include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses.iter().any(|s| {
        let flags = s.status();
        flags.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        )
    }))
}
```

**Important:** `WT_NEW` (untracked) is deliberately excluded. Untracked files do not block `git checkout` in normal git. The project decision says "dirty_workdir" blocks checkout — match git's actual behavior (only tracked file modifications block).

### Pattern 2: Rust Command — Branch Checkout Sequence

```rust
// Source: docs.rs/git2/latest/git2/struct.Repository.html
// set_head then checkout_head — correct order for local branch checkout
pub async fn checkout_branch(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), TrunkError> {
        let path_buf = state.0.lock().unwrap().get(&path)
            .ok_or_else(|| TrunkError::new("repo_not_open", "Repository not open"))?
            .clone();
        let repo = git2::Repository::open(&path_buf)?;

        if is_dirty(&repo)? {
            return Err(TrunkError::new(
                "dirty_workdir",
                "Working tree has uncommitted changes",
            ));
        }

        let refname = format!("refs/heads/{}", branch_name);
        repo.set_head(&refname)?;
        repo.checkout_head(Some(
            git2::build::CheckoutBuilder::default().safe()
        ))?;
        Ok(())
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())
}
```

### Pattern 3: Rust Command — List Refs (BRNCH-01 backend)

Remote branch names from git2 are stored as `refs/remotes/origin/main` — `shorthand()` returns `origin/main`. To group by remote, split on first `/`: `origin` is the remote name, `main` is the short branch name. This split must happen in Rust when building `RefsResponse` so the frontend gets pre-grouped data or at minimum the full shortname to split on frontend.

**Recommended:** Return `RefsResponse.remote` with `BranchInfo.name = "origin/main"` (full shorthand). Frontend splits on first `/` to derive `remoteName = "origin"` and `branchShort = "main"`. This is simpler than a new DTO.

```rust
// Source: docs.rs/git2/latest/git2/struct.Repository.html (branches method)
pub async fn list_refs(path: String, state: State<'_, RepoState>) -> Result<RefsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<RefsResponse, TrunkError> {
        let path_buf = /* get from state */;
        let repo = git2::Repository::open(&path_buf)?;

        let head_name = repo.head().ok()
            .and_then(|h| h.shorthand().map(|s| s.to_owned()));

        // Local branches
        let local: Vec<BranchInfo> = repo.branches(Some(git2::BranchType::Local))?
            .filter_map(|r| r.ok())
            .map(|(branch, _)| {
                let name = branch.name().unwrap_or(Ok("")).unwrap_or("").to_owned();
                let is_head = branch.is_head();
                BranchInfo {
                    name,
                    is_head,
                    upstream: branch.upstream().ok()
                        .and_then(|u| u.name().ok().flatten().map(|s| s.to_owned())),
                    ahead: 0,
                    behind: 0,
                    last_commit_timestamp: branch.get().peel_to_commit()
                        .map(|c| c.author().when().seconds())
                        .unwrap_or(0),
                }
            })
            .collect();

        // Remote branches
        let remote: Vec<BranchInfo> = repo.branches(Some(git2::BranchType::Remote))?
            .filter_map(|r| r.ok())
            .filter(|(b, _)| {
                // Skip HEAD tracking refs like "origin/HEAD"
                b.name().ok().flatten()
                    .map(|n| !n.ends_with("/HEAD"))
                    .unwrap_or(false)
            })
            .map(|(branch, _)| BranchInfo {
                name: branch.name().unwrap_or(Ok("")).unwrap_or("").to_owned(),
                is_head: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                last_commit_timestamp: 0,
            })
            .collect();

        // Tags via tag_foreach
        let mut tags: Vec<RefLabel> = Vec::new();
        repo.tag_foreach(|oid, name| {
            let name_str = std::str::from_utf8(name).unwrap_or("").to_owned();
            let short = name_str.trim_start_matches("refs/tags/").to_owned();
            tags.push(RefLabel {
                name: name_str,
                short_name: short,
                ref_type: RefType::Tag,
                is_head: false,
            });
            true
        })?;

        // Stashes via stash_foreach (&mut repo required)
        let mut repo = repo; // already owned, stash_foreach needs &mut
        let mut stashes: Vec<RefLabel> = Vec::new();
        let _ = repo.stash_foreach(|_idx, name, _oid| {
            stashes.push(RefLabel {
                name: name.to_owned(),
                short_name: name.trim_start_matches("stash@{")
                    .trim_end_matches('}')
                    .to_owned(),
                ref_type: RefType::Stash,
                is_head: false,
            });
            true
        });

        Ok(RefsResponse { local, remote, tags, stashes })
    })
    .await
    .map_err(...)
    .map_err(...)
}
```

**Note:** `stash_foreach` requires `&mut Repository`, but `tag_foreach` and `branches()` only need `&Repository`. Call `tag_foreach` before taking `mut repo` — or call `stash_foreach` last on the same `mut repo`. The pattern above does exactly this.

### Pattern 4: Svelte 5 Sidebar — Reactive Search with $derived

```svelte
<!-- Source: svelte.dev/docs/svelte/$derived -->
<script lang="ts">
  import type { RefsResponse, BranchInfo } from '../lib/types.js';

  interface Props {
    repoPath: string;
    onrefreshed?: () => void; // signals App.svelte to refresh commit graph
  }

  let { repoPath, onrefreshed }: Props = $props();

  let refs = $state<RefsResponse | null>(null);
  let search = $state('');
  let checkingOutBranch = $state<string | null>(null); // branch name being checked out
  let checkoutError = $state<{ branch: string; message: string } | null>(null);
  let localExpanded = $state(true);
  let remoteExpanded = $state(false);
  let tagsExpanded = $state(false);
  let stashesExpanded = $state(false);
  let showCreateInput = $state(false);
  let newBranchName = $state('');

  // Frontend-only filter — no backend round-trip (BRNCH-02)
  let filteredLocal = $derived(
    search
      ? refs?.local.filter(b => b.name.toLowerCase().includes(search.toLowerCase())) ?? []
      : refs?.local ?? []
  );

  let filteredRemote = $derived(
    search
      ? refs?.remote.filter(b => b.name.toLowerCase().includes(search.toLowerCase())) ?? []
      : refs?.remote ?? []
  );

  // Group remote branches by remote name
  let remoteGroups = $derived(
    filteredRemote.reduce<Record<string, string[]>>((acc, b) => {
      const slash = b.name.indexOf('/');
      const remote = slash >= 0 ? b.name.slice(0, slash) : 'origin';
      const short = slash >= 0 ? b.name.slice(slash + 1) : b.name;
      (acc[remote] ??= []).push(short);
      return acc;
    }, {})
  );

  async function loadRefs() { /* safeInvoke('list_refs', { path: repoPath }) */ }
  $effect(() => { loadRefs(); });

  function dismissError() { checkoutError = null; }
</script>
```

### Pattern 5: Inline Error Banner (BRNCH-03)

The error banner lives inside `BranchRow.svelte`, shown conditionally when `errorBranch === branch.name`. It is dismissed automatically when: the user clicks another branch row (any checkout attempt clears previous error first), or the user types in search (search `$effect` clears error).

```svelte
<!-- BranchRow.svelte — inline error below the row -->
{#if isErrorBranch}
  <div
    class="px-3 py-2 text-xs rounded-sm mx-2 mb-1"
    style="background: #3d1c1c; border: 1px solid #6b2a2a; color: #f87171;"
  >
    Cannot checkout — working tree has uncommitted changes.
    Commit or stash your changes first.
  </div>
{/if}
```

### Pattern 6: Inline Branch Create Input (BRNCH-04)

```svelte
<!-- Inside the Local section, when showCreateInput is true -->
{#if showCreateInput}
  <input
    type="text"
    bind:value={newBranchName}
    placeholder="New branch name"
    class="w-full text-sm px-2 py-0.5 outline-none"
    style="
      background: var(--color-surface);
      border: 1px solid var(--color-accent);
      color: var(--color-text);
      height: 26px;
    "
    onkeydown={(e) => {
      if (e.key === 'Enter') createBranch();
      if (e.key === 'Escape') { showCreateInput = false; newBranchName = ''; }
    }}
    use:autoFocus
  />
{/if}
```

Use Svelte's `use:action` pattern with a `autoFocus` action to focus the input when it mounts.

### Anti-Patterns to Avoid

- **Persisting section expanded/collapsed state:** Locked out of scope — always reset on repo open.
- **Showing "origin/HEAD" in remote list:** This is a git internal tracking ref. Filter it out: `!name.endsWith('/HEAD')`.
- **Using Svelte stores for sidebar state:** The CONTEXT.md specifies `$state`/`$derived` runes unless cross-component sharing is needed. The sidebar state is self-contained — no store needed.
- **Calling `checkout_head()` before `set_head()`:** This leaves the index in a dirty-looking state. Always `set_head` first, then `checkout_head`.
- **Not draining checkout result into cache refresh:** After successful checkout or branch create, `open_repo` cache must be invalidated and the commit graph must reload (HEAD position changes).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Dirty working tree detection | Custom file stat comparison | `git2::repo.statuses()` with status flags | Handles renames, typechanges, submodules, .gitignore rules correctly |
| Branch enumeration | Walk `refs/heads/*` manually | `repo.branches(Some(BranchType::Local))` | Iterator handles packed refs, loose refs, edge cases |
| Tag listing | Parse `.git/refs/tags/` | `repo.tag_foreach()` | Handles annotated tags (which point at tag objects, not commits) |
| Stash listing | Parse stash reflog | `repo.stash_foreach()` | Only API that correctly enumerates stash stack |
| Checkout file update | Manually copy files | `repo.checkout_head(Some(CheckoutBuilder::default().safe()))` | Handles mode bits, symlinks, submodules |
| Frontend search debounce | setTimeout wrapper | `$derived` rune computes synchronously | Svelte 5 `$derived` is synchronous — runs before render, no debounce needed for in-memory filter |

**Key insight:** git2 provides all the right abstractions. The only custom logic needed is the `is_dirty()` guard function (which itself just calls `repo.statuses()`), and the remote branch name splitting (`"origin/main"` → `["origin", "main"]`).

---

## Common Pitfalls

### Pitfall 1: `stash_foreach` Requires `&mut Repository`

**What goes wrong:** Calling `repo.stash_foreach(...)` fails to compile if `repo` is an immutable reference. This is a libgit2 API design — stash iteration modifies internal state.

**Why it happens:** git2 binds the C function `git_stash_foreach` which requires `*mut git_repository`.

**How to avoid:** Call all read-only operations (`branches()`, `tag_foreach()`, `statuses()`) first, then convert `repo` to mutable for `stash_foreach`:
```rust
let mut repo = git2::Repository::open(&path_buf)?;
// Use &repo for read-only ops...
let mut stashes = vec![];
let _ = repo.stash_foreach(|_idx, name, _oid| { stashes.push(...); true });
```

**Warning signs:** `error[E0596]: cannot borrow 'repo' as mutable` at compile time.

### Pitfall 2: Showing `origin/HEAD` as a Remote Branch

**What goes wrong:** `repo.branches(Some(BranchType::Remote))` yields a `origin/HEAD` entry in repos with a configured remote. Displaying it in the sidebar is confusing — it's a symbolic ref, not a real branch.

**Why it happens:** libgit2 returns all refs under `refs/remotes/`, including the `HEAD` tracking symref.

**How to avoid:** Filter in the `list_refs` Rust command:
```rust
.filter(|(b, _)| {
    b.name().ok().flatten()
        .map(|n| !n.ends_with("/HEAD"))
        .unwrap_or(false)
})
```

**Warning signs:** User sees "HEAD" listed as a remote branch under each remote.

### Pitfall 3: Forgetting to Invalidate CommitCache After Checkout

**What goes wrong:** After `checkout_branch` succeeds, the Rust `CommitCache` still holds the old commit graph (with the old HEAD refs). The commit graph Svelte component re-fetches from the stale cache and shows incorrect `is_head` markers.

**Why it happens:** `CommitCache` is populated only in `open_repo`. No automatic invalidation exists.

**How to avoid:** After a successful `checkout_branch` or `create_branch`, the command must rebuild the cache (call `graph::walk_commits` and update `CommitCache`), OR the frontend must call a new `refresh_repo` command that re-runs the graph walk. The simpler approach: rebuild the cache inside `checkout_branch`/`create_branch` before returning success.

**Warning signs:** After checkout, the commit graph still shows the old branch highlighted as HEAD.

### Pitfall 4: `WT_NEW` Blocking Checkout (Over-strict Dirty Check)

**What goes wrong:** Treating untracked files (`WT_NEW`) as a dirty-tree condition causes the error banner to appear even when the user just has untracked files in their working directory — which is not how `git checkout` behaves.

**Why it happens:** `WT_NEW` is a valid status flag but untracked files don't conflict with checkout.

**How to avoid:** Exclude `Status::WT_NEW` from the dirty check. Only `INDEX_*` and `WT_MODIFIED`, `WT_DELETED`, `WT_RENAMED`, `WT_TYPECHANGE` should block checkout.

### Pitfall 5: Branch Name Validation for Create

**What goes wrong:** git branch names have strict rules (no spaces, no `..`, no trailing `.lock`, etc.). Passing an invalid name to `repo.branch()` returns a git2 error, which surfaces as a generic `git_error` code on the frontend.

**Why it happens:** git2 delegates validation to libgit2.

**How to avoid:** The generic `git_error` code is acceptable for Phase 3 — display `err.message` in the inline input area on error. No need for frontend-side branch name validation in v0.1.

### Pitfall 6: Svelte 5 `$effect` Running Stale Closure

**What goes wrong:** A `$effect` that closes over `repoPath` but doesn't list it as a dependency won't re-run when the repo changes.

**Why it happens:** In Svelte 5, `$effect` tracks reactive state reads inside the effect body. If `repoPath` is a `$props()` value, reading it inside `$effect` is sufficient — it is tracked.

**How to avoid:** Always read `repoPath` (or any prop) directly inside the effect body, not via a local variable assigned outside the effect.

---

## Code Examples

Verified patterns from official sources:

### Dirty Working Tree Detection

```rust
// Source: docs.rs/git2/latest/git2/struct.Status.html (Status flags)
// Source: docs.rs/git2/latest/git2/struct.Repository.html (statuses method)
fn is_dirty(repo: &git2::Repository) -> Result<bool, git2::Error> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(false);
    opts.include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses.iter().any(|entry| {
        entry.status().intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE
                | git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        )
    }))
}
```

### Branch Checkout (set_head + checkout_head)

```rust
// Source: docs.rs/git2/latest/git2/struct.Repository.html
// Critical: set_head BEFORE checkout_head
repo.set_head(&format!("refs/heads/{}", branch_name))?;
repo.checkout_head(Some(git2::build::CheckoutBuilder::default().safe()))?;
```

### Local Branch Creation from HEAD

```rust
// Source: docs.rs/git2/latest/git2/struct.Repository.html (branch method)
let head_commit = repo.head()?.peel_to_commit()?;
let _branch = repo.branch(&new_name, &head_commit, false)?;
// false = don't force (fail if name already exists — return git_error)
```

### Frontend Error Handling Pattern (established in project)

```typescript
// Source: src/lib/invoke.ts (safeInvoke — existing project pattern)
try {
  await safeInvoke<void>('checkout_branch', { path: repoPath, branchName });
  // success: refresh refs + signal graph refresh
  await loadRefs();
  onrefreshed?.();
} catch (e) {
  const err = e as TrunkError;
  if (err.code === 'dirty_workdir') {
    checkoutError = { branch: branchName, message: err.message };
  }
  // other error codes: could show generic error, or ignore for v0.1
}
```

### Svelte 5 `use:action` for Auto-Focus

```svelte
<!-- Svelte 5 action for focusing an element when it mounts -->
<script lang="ts">
  function autoFocus(node: HTMLElement) {
    node.focus();
    return {};
  }
</script>

<input use:autoFocus ... />
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Svelte 4 `$: derived = ...` reactive declarations | Svelte 5 `$derived` rune | Svelte 5 release (stable Oct 2024) | More explicit, works outside `.svelte` files, better TypeScript |
| Svelte 4 `writable()` stores | Svelte 5 `$state` rune | Svelte 5 release | No store subscription boilerplate, simpler syntax |
| Svelte 4 `onMount()` | Svelte 5 `$effect()` | Svelte 5 release | Unified API for mount + reactive re-runs |

**Deprecated/outdated:**
- Svelte stores (`writable`, `readable`, `derived` from `svelte/store`): Still valid, but the CONTEXT.md explicitly says use Svelte 5 runes unless cross-component sharing is needed. BranchSidebar is self-contained — use runes.

---

## Validation Architecture

Nyquist validation is enabled (`workflow.nyquist_validation: true`).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[test]` (cargo test) |
| Config file | None — cargo test runs automatically |
| Quick run command | `cargo test -p trunk --lib -- branches` |
| Full suite command | `cargo test -p trunk --lib` |

No frontend test framework exists in the project. The established pattern is Rust unit tests inside `#[cfg(test)]` modules using `tempfile` for real git repos (see `commands/repo.rs`, `git/repository.rs`, `git/graph.rs`).

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BRNCH-01 | `list_refs` returns local branches, remote branches, tags, stashes | unit (Rust) | `cargo test -p trunk --lib -- branches::tests` | Wave 0 |
| BRNCH-01 | `list_refs` hides `origin/HEAD` tracking ref | unit (Rust) | `cargo test -p trunk --lib -- branches::tests::list_refs_hides_remote_head` | Wave 0 |
| BRNCH-01 | `list_refs` marks HEAD branch with `is_head: true` | unit (Rust) | `cargo test -p trunk --lib -- branches::tests::list_refs_head_flag` | Wave 0 |
| BRNCH-02 | Frontend search filter (frontend-only, no Rust test) | manual-only | N/A — pure frontend $derived, no backend | N/A |
| BRNCH-03 | `checkout_branch` returns `dirty_workdir` when tree is dirty | unit (Rust) | `cargo test -p trunk --lib -- branches::tests::checkout_dirty_returns_error` | Wave 0 |
| BRNCH-03 | `checkout_branch` succeeds on clean tree and updates HEAD | unit (Rust) | `cargo test -p trunk --lib -- branches::tests::checkout_clean_succeeds` | Wave 0 |
| BRNCH-04 | `create_branch` creates branch pointing at HEAD | unit (Rust) | `cargo test -p trunk --lib -- branches::tests::create_branch_from_head` | Wave 0 |
| BRNCH-04 | `create_branch` fails if name already exists | unit (Rust) | `cargo test -p trunk --lib -- branches::tests::create_branch_duplicate_fails` | Wave 0 |

**BRNCH-02 justification for manual-only:** The search filter is a pure `$derived` computation on already-fetched data. It has no Rust backend involvement and the Svelte compilation guarantees reactive consistency. Visual verification in tauri dev is sufficient.

### Sampling Rate

- **Per task commit:** `cargo test -p trunk --lib -- branches`
- **Per wave merge:** `cargo test -p trunk --lib`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/commands/branches.rs` — all test cases listed above (currently only a comment stub)
- [ ] Helper function `make_test_repo_with_remote_branch()` — extend `repository::tests` to create a repo with a remote tracking branch for BRNCH-01 remote tests
- [ ] Helper function `make_dirty_repo()` — create a test repo with uncommitted changes for BRNCH-03

Existing `make_test_repo()` in `git/repository.rs` is reusable for the clean-tree tests.

---

## Open Questions

1. **CommitCache invalidation strategy after checkout**
   - What we know: `CommitCache` is only populated in `open_repo`. After checkout, HEAD ref position changes, so cached `GraphCommit.is_head` becomes stale.
   - What's unclear: Should `checkout_branch` rebuild the CommitCache inline (adding a graph walk to the checkout command), or should it invalidate the cache and let the frontend trigger a re-fetch via `open_repo`?
   - Recommendation: Rebuild cache inline inside `checkout_branch` (and `create_branch`). This keeps the IPC surface clean — success means everything is fresh. The performance cost is acceptable (graph walk is ~5ms for typical repos per Phase 2 design).

2. **Sidebar width (Claude's Discretion)**
   - What we know: Fixed width in v0.1, not resizable.
   - Recommendation: 220px fixed width. This matches Fork/GitKraken sidebar widths and fits typical branch names without truncation. Use `min-w-[220px] w-[220px]` in Tailwind.

3. **Search input placement (Claude's Discretion)**
   - Recommendation: Sticky at the top of the sidebar, above all sections. This mirrors VS Code's file explorer search and is the expected location for users.

---

## Sources

### Primary (HIGH confidence)
- [docs.rs/git2/latest/git2/struct.Repository.html](https://docs.rs/git2/latest/git2/struct.Repository.html) — `branches()`, `branch()`, `set_head()`, `checkout_head()`, `statuses()`, `stash_foreach()`, `tag_foreach()`, `head()` methods
- [docs.rs/git2/latest/git2/struct.Status.html](https://docs.rs/git2/latest/git2/struct.Status.html) — Status flag constants (INDEX_NEW, WT_MODIFIED, etc.)
- [docs.rs/git2/latest/git2/struct.Branch.html](https://docs.rs/git2/latest/git2/struct.Branch.html) — `name()`, `is_head()`, `upstream()`, `get()` methods
- [docs.rs/git2/latest/git2/enum.BranchType.html](https://docs.rs/git2/latest/git2/enum.BranchType.html) — `BranchType::Local`, `BranchType::Remote`
- [svelte.dev/docs/svelte/$state](https://svelte.dev/docs/svelte/$state) — `$state` rune
- [svelte.dev/docs/svelte/$derived](https://svelte.dev/docs/svelte/$derived) — `$derived` rune for frontend filter
- [svelte.dev/docs/svelte/$effect](https://svelte.dev/docs/svelte/$effect) — `$effect` rune for data loading
- Existing codebase: `src/lib/invoke.ts`, `src/lib/types.ts`, `src-tauri/src/error.rs`, `src-tauri/src/git/types.rs`, `src-tauri/src/git/repository.rs` — all read directly

### Secondary (MEDIUM confidence)
- [github.com/rust-lang/git2-rs/blob/master/src/repo.rs](https://github.com/rust-lang/git2-rs/blob/master/src/repo.rs) — Confirmed `stash_foreach` requires `&mut self`
- WebSearch: git2 checkout sequence (`set_head` before `checkout_head`) — confirmed via community docs and official repo examples

### Tertiary (LOW confidence)
- None — all claims verified via official docs or direct codebase inspection.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies already in project; git2 0.19 APIs verified via docs.rs
- Architecture: HIGH — follows exact patterns from existing CommitGraph.svelte and commands/repo.rs
- Rust command APIs: HIGH — verified via docs.rs/git2
- Pitfalls: HIGH — `stash_foreach &mut` and `origin/HEAD` filtering are libgit2 documented behaviors; cache invalidation derived from reading existing cache code
- Frontend patterns: HIGH — Svelte 5 runes verified via official svelte.dev docs; matches existing CommitGraph.svelte pattern

**Research date:** 2026-03-04
**Valid until:** 2026-04-04 (git2 0.19 and Svelte 5 are stable; unlikely to change meaningfully)
