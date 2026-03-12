# Roadmap: Trunk

## Milestones

- ✅ **v0.1 MVP** — Phases 1-6 (shipped 2026-03-09)
- ✅ **v0.2 Commit Graph** — Phases 7-10 (shipped 2026-03-10)
- 🚧 **v0.3 Actions** — Phases 11-14 (in progress)

## Phases

<details>
<summary>✅ v0.1 MVP (Phases 1-6) — SHIPPED 2026-03-09</summary>

- [x] Phase 1: Foundation (3/3 plans) — completed 2026-03-03
- [x] Phase 2: Repository Open + Commit Graph (8/9 plans) — completed 2026-03-09
- [x] Phase 3: Branch Sidebar + Checkout (5/5 plans) — completed 2026-03-04
- [x] Phase 4: Working Tree + Staging (4/4 plans) — completed 2026-03-07
- [x] Phase 5: Commit Creation (3/3 plans) — completed 2026-03-07
- [x] Phase 6: Diff Display (3/3 plans) — completed 2026-03-07

Full details: [milestones/v0.1-ROADMAP.md](milestones/v0.1-ROADMAP.md)

</details>

<details>
<summary>✅ v0.2 Commit Graph (Phases 7-10) — SHIPPED 2026-03-10</summary>

- [x] Phase 7: Lane Algorithm Hardening (2/2 plans) — completed 2026-03-09
- [x] Phase 8: Straight Rail Rendering (1/1 plans) — completed 2026-03-09
- [x] Phase 9: WIP Row + Visual Polish (1/1 plans) — completed 2026-03-09
- [x] Phase 10: Differentiators (5/5 plans) — completed 2026-03-10

Full details: [milestones/v0.2-ROADMAP.md](milestones/v0.2-ROADMAP.md)

</details>

### 🚧 v0.3 Actions (In Progress)

**Milestone Goal:** Enable push/pull/fetch with remote auth, stash operations, and a commit row context menu with branch/tag/cherry-pick/revert actions, surfaced through a quick actions toolbar.

- [ ] **Phase 11: Stash Operations** - User can create, pop, apply, and drop stashes; stash entries appear in the commit graph as synthetic square-dot rows; right-click on stash rows exposes pop/apply/drop actions
- [ ] **Phase 12: Commit Context Menu** - User can right-click any commit row for copy, checkout, branch, tag, cherry-pick, and revert actions
- [ ] **Phase 13: Remote Operations** - User can fetch, pull, and push with progress feedback and actionable error messages
- [ ] **Phase 14: Toolbar + Tracking** - Quick actions bar visible at top; branch sidebar shows live ahead/behind counts; undo/redo last commit

## Phase Details

### Phase 11: Stash Operations
**Goal**: Users can manage their stash stack without touching the terminal, and stash entries are visible and actionable in the commit graph at their parent commit
**Depends on**: Phase 10 (v0.2 complete)
**Requirements**: STASH-01, STASH-02, STASH-03, STASH-04, STASH-05, STASH-06, STASH-07
**Success Criteria** (what must be TRUE):
  1. User can create a stash (with or without a name) and see it appear immediately in both the sidebar stash list and the commit graph
  2. Stash entries appear in the commit graph as synthetic rows with square dots and dashed connectors, positioned at their parent commit (same visual pattern as WIP row)
  3. User can pop a stash entry and see their working tree restored with the stash removed from the list and graph
  4. User can apply a stash entry and see their working tree restored while the stash entry remains in the list and graph
  5. User can drop a stash entry and see it removed from the list and graph without any working tree changes
  6. User can right-click a stash row in the commit graph to get a context menu with pop, apply, and drop actions
**Plans**: 6 plans

Plans:
- [x] 11-01: Stash commands backend — `stash_save`, `stash_list` (with parent OID), `stash_pop`, `stash_apply`, `stash_drop` Tauri commands (inner-fn + git2); stash list response includes parent OID for graph positioning
- [x] 11-02: Stash graph rendering (FAILED — removed during UAT)
- [x] 11-03: Stash sidebar UI — stash list section in sidebar with create form (optional name) and pop/apply/drop actions per entry; wired to backend commands (STASH-01, STASH-03, STASH-04, STASH-05, STASH-06)
- [x] 11-04: UAT gap closure — cursor fix, click-to-diff, UI refresh, drop permission
- [ ] 11-05: Stash graph rendering (gap closure) — re-implement stash rows in commit graph with hollow square dots and right-click context menu (STASH-02, STASH-07)
- [ ] 11-06: UAT gap closure — fix double-refresh white flash and auto-expand stash section on create

### Phase 12: Commit Context Menu
**Goal**: Users can act on any commit directly from the graph without typing git commands
**Depends on**: Phase 11
**Requirements**: MENU-01, MENU-02, MENU-03, MENU-04, MENU-05, MENU-06, MENU-07
**Success Criteria** (what must be TRUE):
  1. Right-clicking any commit row opens a native context menu with all available actions
  2. User can copy a commit SHA or message to the clipboard from the context menu
  3. User can checkout a commit in detached HEAD mode, create a branch from it (with optional auto-checkout), or create a tag from it
  4. Cherry-pick and revert actions are available for non-merge commits and disabled (greyed out) for merge commits
  5. After any graph-mutating action (checkout, branch, tag, cherry-pick, revert), the commit graph refreshes to reflect the change
**Plans**: 2 plans

Plans:
- [ ] 12-01: Commit action backend — `checkout_commit`, `create_tag`, `cherry_pick`, `revert_commit` commands; extend `create_branch` with optional `from_oid` parameter; all graph-mutating commands repopulate CommitCache before emitting `repo-changed`
- [ ] 12-02: Commit context menu UI — right-click handler on CommitRow, native Tauri Menu wired to all actions, cherry-pick/revert disabled for merge commits, confirmation dialogs for destructive actions

### Phase 13: Remote Operations
**Goal**: Users can synchronize with remote repositories with clear progress feedback and actionable errors
**Depends on**: Phase 11
**Requirements**: REMOTE-01, REMOTE-02, REMOTE-03, REMOTE-04
**Success Criteria** (what must be TRUE):
  1. User can fetch all remotes and see per-line progress output while the operation runs
  2. User can pull the current branch and see the commit graph update when complete
  3. User can push the current branch (including new branches without an upstream) and see the commit graph update when complete
  4. Auth failures show a clear, actionable message (not raw git stderr); non-fast-forward push rejections show a "Pull first" prompt
**Plans**: 2 plans

Plans:
- [ ] 13-01: Remote commands backend — `git_fetch`, `git_pull`, `git_push` via `tokio::process::Command`; `remote-progress` Tauri event emitted per stderr line; `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND=ssh -o BatchMode=yes` set on all child processes; structured error taxonomy for auth failures and non-fast-forward rejections
- [ ] 13-02: Remote UI — fetch/pull/push buttons wired to commands; inline `remote-progress` event listener with live output display; actionable error message surfaces for auth and rejection cases

### Phase 14: Toolbar + Tracking
**Goal**: Quick actions are one click away from anywhere in the app and branch tracking state is always visible
**Depends on**: Phase 12, Phase 13
**Requirements**: TRACK-01, TRACK-02, TOOLBAR-01, TOOLBAR-02, TOOLBAR-03
**Success Criteria** (what must be TRUE):
  1. A toolbar is visible at the top of the window at all times with Pull, Push, Branch, Stash, and Pop buttons
  2. The branch sidebar displays ahead/behind counts next to each branch that has a remote tracking branch
  3. Ahead/behind counts update automatically after any fetch, pull, or push operation completes
  4. Undo soft-resets the last commit and restores its changes as staged; Redo re-commits with the original message
**Plans**: 2 plans

Plans:
- [ ] 14-01: Ahead/behind counts — extend `list_refs` response or add separate command to compute `ahead`/`behind` per branch via `git rev-list --count`; update triggered after remote ops emit `repo-changed`
- [ ] 14-02: Toolbar UI + undo/redo — toolbar component with Pull, Push, Branch, Stash, Pop, Undo, Redo buttons wired to existing commands; `undo_commit` (soft reset HEAD~1) and `redo_commit` (re-commit with stashed message) Tauri commands

## Progress

**Execution Order:** 11 → 12 → 13 → 14

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v0.1 | 3/3 | Complete | 2026-03-03 |
| 2. Repository Open + Commit Graph | v0.1 | 8/9 | Complete | 2026-03-09 |
| 3. Branch Sidebar + Checkout | v0.1 | 5/5 | Complete | 2026-03-04 |
| 4. Working Tree + Staging | v0.1 | 4/4 | Complete | 2026-03-07 |
| 5. Commit Creation | v0.1 | 3/3 | Complete | 2026-03-07 |
| 6. Diff Display | v0.1 | 3/3 | Complete | 2026-03-07 |
| 7. Lane Algorithm Hardening | v0.2 | 2/2 | Complete | 2026-03-09 |
| 8. Straight Rail Rendering | v0.2 | 1/1 | Complete | 2026-03-09 |
| 9. WIP Row + Visual Polish | v0.2 | 1/1 | Complete | 2026-03-09 |
| 10. Differentiators | v0.2 | 5/5 | Complete | 2026-03-10 |
| 11. Stash Operations | v0.3 | 4/6 | In progress | - |
| 12. Commit Context Menu | v0.3 | 0/2 | Not started | - |
| 13. Remote Operations | v0.3 | 0/2 | Not started | - |
| 14. Toolbar + Tracking | v0.3 | 0/2 | Not started | - |
