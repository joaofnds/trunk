# Feature Research

**Domain:** Git GUI — Remote operations, stash management, commit context menu
**Researched:** 2026-03-10
**Confidence:** HIGH (based on direct analysis of GitKraken, Fork, GitHub Desktop, Tower, SourceTree, VS Code Git; all are well-documented, mature tools with established UX patterns)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features that users assume any Git GUI provides. Missing these = product feels incomplete or unshippable.

#### Remote Operations

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Fetch all remotes** | Every Git GUI has a fetch button. It is the safest remote op (read-only). Users click it habitually before starting work. | LOW | Shell out to `git fetch --all`. Stream stderr for progress. No auth prompt needed for already-configured remotes. Depends on: existing RemoteState/sidebar already shows remote branches. |
| **Pull current branch** | Users expect a single "Pull" action for the checked-out branch. Fetches and merges (or rebases) in one step. | MEDIUM | Shell out to `git pull`. Must handle fast-forward vs merge-commit outcomes. Must detect and surface rejection (diverged history, conflicts). Depends on: checkout already implemented. |
| **Push current branch** | Core workflow action. After committing locally, users push to origin. | MEDIUM | Shell out to `git push`. Must handle: no upstream set (offer to set it), rejected push (non-fast-forward), auth failures. Depends on: commit creation already implemented. |
| **Visual upstream tracking** | Users expect the UI to show how many commits ahead/behind the remote branch they are (e.g., "↑2 ↓1"). Every Git GUI shows this in the branch list. | LOW | `git rev-list --count HEAD..@{u}` and `..@{u}..HEAD`. Add ahead/behind counts to the branch sidebar. Depends on: branch sidebar already implemented. |
| **Progress feedback during remote ops** | Remote ops can take seconds or minutes. Without progress, users assume the app is frozen. Every Git GUI shows a spinner, progress bar, or streaming output during push/pull/fetch. | MEDIUM | Spawn git CLI in a child process, stream stderr line-by-line to frontend via Tauri event (not a single await). Parse standard git progress lines ("Counting objects: 42", "remote: Enumerating objects: 5"). Show in a status bar or modal. |
| **Auth failure shown clearly** | When push/pull fails due to auth, the error message must be human-readable, not raw git stderr. GitKraken, Fork, Tower all translate "Authentication failed" into actionable guidance. | MEDIUM | Detect "Authentication failed", "Permission denied (publickey)", "could not read Username" in stderr. Surface these as structured error states with a retry option. Depends on: structured error code pattern already established in codebase. |

#### Stash

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Stash current changes (create)** | Every Git GUI has a "Stash" button in the toolbar or staging panel. It is a daily workflow action when context-switching. | LOW | Shell out to `git stash push` (preferred over deprecated `git stash save`). Refresh working tree status after. Depends on: staging panel + filesystem watcher already exist. |
| **Pop most-recent stash** | The complement of stash create. Users expect stash to be a stack they can push/pop. At minimum, popping the top entry is table stakes. | LOW | Shell out to `git stash pop`. Detect conflicts (exit code 1). Refresh commit graph and working tree after. Depends on: stash create. |
| **Stash list visible in sidebar** | The sidebar already shows a "Stashes" section (per v0.1 requirements). Stash entries must be visible. | ALREADY DONE | Already listed in sidebar from v0.1. This research is about operations, not display. |
| **Apply stash (without dropping)** | Apply stash without removing it from the stack. Users use this to apply the same changes to multiple branches, or to apply and keep the stash as a backup. GitKraken, Fork, Tower all offer Apply as a separate action from Pop. | LOW | Shell out to `git stash apply stash@{N}`. Distinguish from pop in the UI. Same conflict detection as pop. |
| **Drop stash entry** | Remove a stash entry without applying it. Standard cleanup action. All major tools support this. | LOW | Shell out to `git stash drop stash@{N}`. Confirm dialog before dropping. |
| **Named stash on create** | Allow providing a description when creating a stash (`git stash push -m "description"`). Without names, stash list shows only timestamps and branch names, making old stashes impossible to identify. Fork, GitKraken, and Tower all offer an optional message field on stash creation. | LOW | Add an optional message field to the stash dialog. If empty, use `git stash push` (git auto-generates the description). If provided, use `git stash push -m "message"`. |

#### Commit Context Menu

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Copy commit SHA** | Power users constantly need to copy SHAs for `git cherry-pick`, Jira tickets, code review links, etc. Every Git GUI puts "Copy SHA" at the top of the commit right-click menu. | LOW | Access to clipboard via Tauri's `writeText`. Already noted in PROJECT.md as a target feature. |
| **Copy commit message** | Less common than SHA copy but expected. Fork and GitKraken include it. | LOW | Same mechanism as copy SHA. |
| **Checkout commit (detached HEAD)** | Users expect to be able to checkout a specific commit to examine its state. GitKraken, Fork, Sourcetree all provide this. | LOW | Shell out to `git checkout <sha>`. Update HEAD display after. Show warning about detached HEAD state. Depends on: checkout already implemented (established pattern). |
| **Create branch from commit** | The standard way to rescue a commit, start a hotfix, or experiment from a specific point. All Git GUIs offer "Create branch here" in the commit context menu. | MEDIUM | Dialog: prompt for branch name. Shell out to `git branch <name> <sha>`. Optionally offer to checkout the new branch immediately. Depends on: branch creation already established (checkout flow). |
| **Create tag from commit** | Tagging releases, annotating significant commits. Fork, GitKraken, Tower, Sourcetree all include this. | MEDIUM | Dialog: prompt for tag name, optional annotation message. Shell out to `git tag <name> <sha>` (lightweight) or `git tag -a <name> <sha> -m "message"` (annotated). |
| **Cherry-pick commit** | Apply a specific commit to the current branch. Universally present in Git GUI context menus. Users expect this as a "grab this commit" action. | MEDIUM | Shell out to `git cherry-pick <sha>`. Detect conflicts (exit code 1). Show commit message preview in confirmation dialog. Refresh graph + working tree after. |
| **Revert commit** | Create a new commit that undoes the changes introduced by a specific commit. Fork, GitKraken, Tower, Sourcetree all include this. Users expect it as the "safe undo" for pushed commits. | MEDIUM | Shell out to `git revert <sha> --no-edit`. Detect conflicts. Refresh graph after. The `--no-edit` flag uses the auto-generated message; a more polished version offers an edit dialog. |

---

### Differentiators (Competitive Advantage)

Features present in top-tier tools but not universally expected. Implementing them elevates the product above commodity tools.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Push --force-with-lease (not --force)** | Tower and Fork use `--force-with-lease` instead of plain `--force` when the user chooses "force push." This prevents overwriting others' work if the remote changed since your last fetch. Plain `--force` in a GUI is dangerous and considered a red flag by senior developers. | LOW | Swap `git push --force` for `git push --force-with-lease`. Add a confirmation dialog with explanation when force-push is attempted. |
| **Streaming progress with parsed output** | GitHub Desktop and Fork show phase-by-phase progress ("Counting objects", "Compressing", "Writing") with a real progress bar. Most tools just show a spinner. Parsed progress reduces user anxiety during slow operations. | MEDIUM | Parse git's `--progress` output format. Git emits `\r`-terminated progress lines on stderr. Parse them in Rust and emit structured progress events to the frontend. |
| **Stash preview on hover/click** | Clicking a stash in the sidebar shows the diff of what's stashed, without applying it. Fork and Tower do this. Users need to see what a stash contains before deciding whether to apply it. | MEDIUM | Shell out to `git stash show -p stash@{N}`. Parse as a diff. Reuse existing DiffPanel component. Depends on: stash list in sidebar + DiffPanel already implemented. |
| **Push new branch with upstream tracking** | When pushing a branch that has no upstream, automatically set tracking (`git push -u origin <branch>`). Tower and Fork do this seamlessly. Without it, users get confusing "no upstream configured" errors. | LOW | Detect "no upstream" condition. Offer to push with `-u origin <branch>`. Store result. |
| **Revert with edit message** | Offer an edit dialog for the revert commit message instead of auto-accepting the generated "Revert 'xyz'" message. Fork and GitKraken offer this. | LOW | Remove `--no-edit` flag, instead open a commit-message dialog pre-filled with the auto-generated message. Reuse existing commit dialog UI. |
| **Cherry-pick series (multiple commits)** | Select multiple commits in the graph and cherry-pick them in order. GitKraken and Fork support this; most simpler tools don't. | HIGH | Requires multi-select in the commit graph (not yet built). Defer until multi-select is implemented. |

---

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem useful but create disproportionate complexity or risk for v0.3.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **In-app SSH key management** | Users want the GUI to handle SSH keys without terminal setup | Enormous scope: key generation, passphrase storage, agent integration, platform keychain access. Every major tool that tried this (Atlassian SourceTree) shipped years of bugs. libgit2's SSH support is unreliable (already noted in PROJECT.md). | Shell out to system git, which uses the user's existing SSH agent and `~/.ssh/config`. Document the expected setup. |
| **Credential manager integration** | Store passwords/tokens for HTTPS remotes | OS keychain APIs differ by platform (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). Implementing correctly is a multi-week project per platform. | Rely on git's credential helper (`git config credential.helper`). The system git invocation inherits the user's configured helper. |
| **Conflict resolution UI** | After a failed merge/pull/cherry-pick, show a 3-way merge editor | 3-way diff UI is the most complex component in any Git GUI (see: Kaleidoscope, P4Merge, IntelliJ IDEA's merge tool). Building it correctly takes months. Already explicitly deferred to v0.4+ in PROJECT.md. | Show a clear "conflicts detected" state, list the conflicting files, and provide a button to open them in the user's editor (`code .` / `open .`). |
| **Interactive rebase (reorder/squash/fixup)** | Power users want to clean up history before pushing | Interactive rebase requires a fake editor that intercepts `GIT_SEQUENCE_EDITOR`, complex state management for the in-progress rebase, and handling every failure mode. Tower spent significant engineering on this. | Defer to v0.5+. For v0.3, revert + cherry-pick covers most cleanup needs. |
| **Force push without warning** | Users want the convenience of force pushing without extra clicks | Destructive. In any collaborative repo, force-pushing without review causes data loss. The extra click exists for a reason. | Always show a confirmation dialog that explains what force push does and what `--force-with-lease` protects against. |
| **Stash include untracked with no confirmation** | Some tools auto-include untracked files in stash | Silently stashing untracked files surprises users who did not expect their new files to disappear. | Default to `git stash push` (tracked only). Offer `git stash push -u` as an explicit checkbox option: "Include untracked files." |

---

## Feature Dependencies

```
[Existing: commit creation]
  └──enables──> [stash create] (need working tree changes to stash)
  └──enables──> [cherry-pick] (need a branch to cherry-pick onto)
  └──enables──> [revert] (need a branch to revert on)

[Existing: branch checkout]
  └──enables──> [create branch from commit] (established dialog + Tauri menu pattern)
  └──enables──> [checkout commit (detached HEAD)] (same invoke path)

[Existing: DiffPanel]
  └──enables──> [stash preview] (reuse diff display)

[Existing: filesystem watcher + auto-refresh]
  └──required by──> [all remote ops] (refresh graph after pull/fetch)
  └──required by──> [stash pop/apply] (refresh working tree after)

[Existing: branch sidebar]
  └──required by──> [ahead/behind counts] (display location already exists)

[Existing: Tauri native menu (from v0.2 header context menu)]
  └──reuse pattern──> [commit context menu] (same API, apply to commit rows)

[stash create]
  └──prerequisite──> [stash pop]
  └──prerequisite──> [stash apply]
  └──prerequisite──> [stash drop]

[fetch]
  └──enables──> [pull] (pull = fetch + merge; fetch must work first)
  └──updates──> [ahead/behind counts] (remote refs update after fetch)

[push]
  └──enables──> [force push with --force-with-lease] (same code path, different flag)
```

### Dependency Notes

- **Stash pop/apply require stash create first:** You cannot pop/apply until the stash mechanism works end-to-end. Implement and verify stash create before wiring apply/drop.
- **Remote ops are independent of stash and context menu:** All three feature groups can be developed in parallel by different phases.
- **Commit context menu reuses existing patterns:** The Tauri native menu pattern is already established (`@tauri-apps/api/menu`, confirmed in PROJECT.md Key Decisions). The commit row needs a `contextmenu` event handler; the menu construction follows the same API.
- **Cherry-pick and revert both need conflict detection:** They share the same post-operation check (non-zero exit code + `CHERRY_PICK_HEAD`/`REVERT_HEAD` file in `.git`). Build this once, reuse for both.
- **Create branch and create tag from commit:** Both require an input dialog. Tower/Fork show a minimal inline dialog (just a name field). The existing checkout dirty-workdir dialog pattern (structured error + modal) serves as the template.

---

## MVP Definition

### Launch With (v0.3 milestone)

Minimum set to make remote ops, stash, and commit actions feel complete and usable.

- [ ] **Fetch all** — safest remote op, always expected, no conflict risk
- [ ] **Pull current branch** — core daily workflow, needed alongside push
- [ ] **Push current branch** — core daily workflow; handles "set upstream" automatically
- [ ] **Progress feedback** — streaming stderr to status bar; required for all remote ops to not feel frozen
- [ ] **Auth failure error message** — translate git stderr into human-readable error state
- [ ] **Ahead/behind counts in branch sidebar** — required to make remote ops visible/meaningful
- [ ] **Stash create (with optional name)** — core workflow; named stash is trivial marginal cost
- [ ] **Stash pop** — the "complete" to stash create; without it stash is useless
- [ ] **Stash apply** — distinct from pop; all major tools include both
- [ ] **Stash drop** — necessary for stash list hygiene; simple operation
- [ ] **Copy SHA / Copy message** — trivial to implement, high daily use
- [ ] **Checkout commit (detached HEAD)** — follows existing checkout pattern
- [ ] **Create branch from commit** — high-value, follows established dialog pattern
- [ ] **Create tag from commit** — moderate value, same dialog pattern as create branch
- [ ] **Cherry-pick** — core power-user action; present in every Git GUI
- [ ] **Revert** — the "safe" counterpart to cherry-pick; always paired with it

### Add After Validation (v0.3.x)

- [ ] **Stash preview in sidebar** — triggers when users complain "I can't tell which stash to apply"
- [ ] **Push --force-with-lease** — add when force-push is first requested
- [ ] **Revert with edit message** — polish pass after basic revert ships

### Future Consideration (v0.4+)

- [ ] **Conflict resolution UI** — explicitly deferred in PROJECT.md; enormous scope
- [ ] **Interactive rebase** — high complexity, not required for v0.3 goal
- [ ] **Cherry-pick series (multi-select)** — requires multi-select graph feature first
- [ ] **SSH key / credential manager** — platform-specific, high complexity

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Fetch all | HIGH | LOW | P1 |
| Pull current branch | HIGH | MEDIUM | P1 |
| Push current branch | HIGH | MEDIUM | P1 |
| Progress feedback (streaming) | HIGH | MEDIUM | P1 |
| Auth failure error message | HIGH | LOW | P1 |
| Ahead/behind counts | MEDIUM | LOW | P1 |
| Stash create (with name) | HIGH | LOW | P1 |
| Stash pop | HIGH | LOW | P1 |
| Stash apply | MEDIUM | LOW | P1 |
| Stash drop | LOW | LOW | P1 |
| Copy SHA / message | HIGH | LOW | P1 |
| Checkout commit | MEDIUM | LOW | P1 |
| Create branch from commit | HIGH | MEDIUM | P1 |
| Create tag from commit | MEDIUM | MEDIUM | P1 |
| Cherry-pick | HIGH | MEDIUM | P1 |
| Revert | HIGH | MEDIUM | P1 |
| Stash preview | MEDIUM | MEDIUM | P2 |
| Push --force-with-lease | MEDIUM | LOW | P2 |
| Revert with edit message | LOW | LOW | P2 |
| Conflict resolution UI | HIGH | VERY HIGH | P3 |
| Interactive rebase | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for v0.3 milestone
- P2: Should have, add when possible
- P3: Nice to have, future milestone

---

## Competitor Feature Analysis

How the established Git GUIs handle these three feature groups.

### Remote Operations

| Feature | GitKraken | Fork | Tower | GitHub Desktop | Our Approach |
|---------|-----------|------|-------|----------------|--------------|
| Fetch | Toolbar button; one-click; shows progress bar | Toolbar button; streams progress | Toolbar; streaming progress with phase names | Toolbar; spinner only | Toolbar + status bar streaming |
| Pull | Toolbar dropdown (merge vs rebase option) | Toolbar; detects divergence before pulling | Toolbar; merge vs rebase option | Single button; merge only | Merge only for v0.3; rebase deferred |
| Push | Toolbar; detects "no upstream", offers to set | Toolbar; offers `-u origin` when no upstream | Toolbar; same | Toolbar; handles upstream automatically | Offer to set upstream automatically |
| Auth failure | Modal with SSH troubleshooting link | Clear error dialog | Modal with credential manager link | Modal with auth help link | Structured error dialog with guidance |
| Ahead/behind | Shown in branch list next to branch name | Shown as ↑↓ counters in branch list | Shown in branch list | Shown in status bar at bottom | Add to existing branch sidebar |
| Force push | Confirmation dialog; uses `--force-with-lease` | Confirmation + warning; uses `--force-with-lease` | Confirmation; uses `--force-with-lease` | Confirmation dialog; plain `--force` | `--force-with-lease` with confirmation |

### Stash

| Feature | GitKraken | Fork | Tower | GitHub Desktop | Our Approach |
|---------|-----------|------|-------|----------------|--------------|
| Create | Toolbar "Stash" button; optional message dialog | Toolbar button; prompts for description | Sidebar "New Stash"; message field | "Stash changes" in Changes tab | Staging panel button + optional name dialog |
| Pop vs Apply | Both available from stash context menu | Both available; default action in sidebar is Apply | Both available in stash list context menu | Only "Pop" available (simpler UX) | Provide both; Pop = apply + drop |
| Drop | Context menu on stash entry | Context menu | Context menu | Not available | Context menu on sidebar stash entry |
| Named stashes | Always prompted | Optional description in create dialog | Required (short name field) | Not available | Optional message field on create |
| Preview | Click stash in sidebar shows diff in main panel | Click stash shows diff in right pane | Click stash shows diff | No preview | Reuse DiffPanel for stash click (v0.3.x) |
| Include untracked | Checkbox in create dialog | Checkbox option | Option in dialog | Not configurable | Checkbox in create dialog; default off |

### Commit Context Menu

| Feature | GitKraken | Fork | Tower | VS Code Git Graph | Our Approach |
|---------|-----------|------|-------|-------------------|--------------|
| Copy SHA | Top of menu | Top of menu | Top of menu | Top of menu | Top of menu |
| Copy message | Present | Present | Present | Not present | Present |
| Checkout commit | "Checkout this commit" | "Checkout '<sha>'" | "Checkout Commit" | "Checkout" | "Checkout commit" with detached HEAD warning |
| Create branch | "Create branch here" (dialog) | "Create New Branch" (dialog) | "New Branch from Commit" (dialog) | "Create Branch" | Dialog: name field + optional checkout |
| Create tag | "Create tag here" (dialog: lightweight vs annotated) | "Tag '<sha>'" (dialog: name + message) | "New Tag from Commit" (dialog) | "Create Tag" | Dialog: name + optional message (annotated) |
| Cherry-pick | "Cherry pick commit" (with confirmation) | "Cherry-Pick commit" | "Cherry-Pick Commit" | "Cherry pick" | Confirmation dialog showing commit message |
| Revert | "Revert commit" (creates revert commit) | "Revert commit" | "Revert Commit" | "Revert" | Confirmation dialog; `--no-edit` for v0.3 |
| Reset (soft/mixed/hard) | Present (dangerous; with warnings) | Present | Present | Present | **NOT in v0.3** — too dangerous without undo |
| Merge into current | Present in some tools | Present | Present | Not present | **Defer** — requires conflict handling |
| Interactive rebase from here | GitKraken Pro only | Present | Present | Not present | **Defer** — high complexity |

---

## UX Behavior Specifications

### Remote Operation UX Flow

**Push (happy path):**
1. User clicks Push button (toolbar or keyboard shortcut)
2. If no upstream: show modal "Push and set upstream to origin/<branch>?" with confirm/cancel
3. Show status: "Pushing to origin/<branch>…" with streaming progress lines
4. On success: update ahead/behind counts (↑0), show brief "Pushed" toast
5. Graph refreshes (remote branch ref moves to HEAD)

**Push (rejection — non-fast-forward):**
1. Git exits non-zero with "rejected" in stderr
2. Show error dialog: "Push rejected. The remote has commits you don't have locally. Pull first, then push." with Pull / Cancel buttons
3. Do NOT offer force push automatically — require user to explicitly request it

**Pull (conflict detected):**
1. Git exits non-zero; `.git/MERGE_HEAD` exists
2. Show error: "Pull completed with conflicts. Resolve conflicts in your editor, then commit." List conflicting files.
3. Refresh working tree status (conflicted files show as "conflicted" in staging panel)
4. **No conflict resolution UI** — explicitly out of scope for v0.3

**Fetch (always safe):**
1. No confirmation needed
2. Stream progress
3. On completion: refresh remote refs, update ahead/behind counts silently
4. Show brief "Fetched" indicator

### Stash Create UX Flow

**Standard stash create:**
1. User clicks "Stash" in staging panel toolbar (or context menu)
2. Optional name dialog appears (single text field; OK with empty uses auto-name; Enter confirms)
3. `git stash push [-m "name"]` runs
4. Working tree status refreshes (all changes disappear)
5. Stash list in sidebar updates

**Pop/Apply UX:**
- Pop: confirm if working tree has changes ("Pop will apply stash and drop it. You have unstaged changes — continue?")
- Apply: no confirmation needed (non-destructive)
- Conflict on pop/apply: show "Conflicts detected" error, list files, refresh status

### Commit Context Menu UX Flow

**Cherry-pick:**
1. Right-click commit → "Cherry-pick"
2. Confirmation: "Apply changes from '<first 50 chars of message>' to current branch?" with SHA shown
3. On success: graph refreshes with new commit at HEAD
4. On conflict: "Cherry-pick paused — conflicts detected. Resolve conflicts, then run `git cherry-pick --continue` in terminal." (terminal fallback for v0.3)

**Create branch from commit:**
1. Right-click commit → "Create Branch Here"
2. Modal: text input for branch name, checkbox "Checkout new branch" (default: checked)
3. Validate: branch name not empty, no spaces, no invalid chars (real-time validation)
4. `git branch <name> <sha>` (+ `git checkout <name>` if checkbox checked)
5. Graph and sidebar refresh

**Create tag from commit:**
1. Right-click commit → "Create Tag"
2. Modal: tag name field (required), annotation message field (optional; if provided creates annotated tag)
3. `git tag <name> <sha>` or `git tag -a <name> <sha> -m "<message>"`
4. Sidebar tags section refreshes

**Revert:**
1. Right-click commit → "Revert Commit"
2. Confirmation: "Create a new commit that undoes the changes from '<message>'?"
3. `git revert <sha> --no-edit`
4. Graph refreshes with new revert commit at HEAD
5. On conflict: same terminal fallback message as cherry-pick

---

## Sources

### HIGH confidence (direct product observation and established patterns)
- GitKraken commit graph and toolbar UX — direct product use; feature page at gitkraken.com/features
- Fork for macOS — direct product use; fork.dev
- Tower for macOS — direct product use; git-tower.com
- GitHub Desktop — open source; github.com/desktop/desktop — can verify exact behavior in source
- VS Code git-graph extension — open source; github.com/mhutchie/vscode-git-graph — well-documented behavior

### MEDIUM confidence (documentation and release notes)
- git stash documentation — git-scm.com/docs/git-stash — command flags and behavior
- git revert documentation — git-scm.com/docs/git-revert — `--no-edit` behavior
- git cherry-pick documentation — git-scm.com/docs/git-cherry-pick — conflict state

### Project context (HIGH confidence)
- PROJECT.md — existing architecture, patterns, explicit feature list for v0.3, out-of-scope decisions

---
*Feature research for: Trunk v0.3 — Remote ops, stash, commit context menu*
*Researched: 2026-03-10*
