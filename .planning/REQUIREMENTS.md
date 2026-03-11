# Requirements: Trunk

**Defined:** 2026-03-10
**Core Value:** A developer can open any Git repository, browse its full commit history as a visual graph, stage files, and create commits — all without touching the terminal.

## v0.3 Requirements

Requirements for the Actions milestone. Each maps to roadmap phases.

### Stash

- [x] **STASH-01**: User can create a stash with an optional name
- [x] **STASH-02**: User can see stash entries in the commit graph as synthetic rows with square dots and dashed connectors, positioned at their parent commit (same sentinel pattern as WIP row)
- [x] **STASH-03**: User can view the stash list in the sidebar
- [x] **STASH-04**: User can pop a stash entry (apply and remove)
- [x] **STASH-05**: User can apply a stash entry without removing it
- [x] **STASH-06**: User can drop a stash entry without applying it
- [x] **STASH-07**: User can right-click a stash row in the commit graph to see a context menu with pop, apply, and drop actions

### Commit Menu

- [ ] **MENU-01**: User can copy a commit SHA to clipboard from the context menu
- [ ] **MENU-02**: User can copy a commit message to clipboard from the context menu
- [ ] **MENU-03**: User can checkout a commit in detached HEAD mode from the context menu
- [ ] **MENU-04**: User can create a branch from a commit with optional auto-checkout
- [ ] **MENU-05**: User can create a tag from a commit
- [ ] **MENU-06**: User can cherry-pick a commit (menu item disabled for merge commits)
- [ ] **MENU-07**: User can revert a commit (menu item disabled for merge commits)

### Remote

- [ ] **REMOTE-01**: User can fetch all remotes with per-line progress feedback
- [ ] **REMOTE-02**: User can pull the current branch (merge strategy)
- [ ] **REMOTE-03**: User can push the current branch (auto-sets upstream for new branches)
- [ ] **REMOTE-04**: User sees actionable error messages for auth failures and non-fast-forward rejections

### Tracking

- [ ] **TRACK-01**: Branch sidebar shows ahead/behind counts relative to upstream
- [ ] **TRACK-02**: Ahead/behind counts update after fetch, pull, and push

### Toolbar

- [ ] **TOOLBAR-01**: A quick actions bar is visible at the top of the window with Pull, Push, Branch, Stash, and Pop buttons
- [ ] **TOOLBAR-02**: Undo button performs a soft reset of the last commit (restores changes as staged)
- [ ] **TOOLBAR-03**: Redo button re-commits with the original message after an undo

## Future Requirements (v0.4+)

### Staging

- **STAGE-01**: User can stage individual diff hunks (not just whole files)

### UI Polish

- **UI-01**: Left and right panels are resizable via drag splitter
- **UI-02**: Keyboard shortcuts for common operations (stage, commit, fetch, checkout)
- **UI-03**: StagingPanel refreshes deterministically after checkout/create-branch

### Remote (advanced)

- **REMOTE-05**: User can push with --force-with-lease after explicit confirmation
- **REMOTE-06**: Pull supports rebase strategy (in addition to merge)

### Stash (advanced)

- **STASH-08**: User can preview stash diff before applying

## Out of Scope

| Feature | Reason |
|---------|--------|
| Conflict resolution UI | Enormous scope; explicitly deferred to v0.4+ per PROJECT.md |
| Interactive rebase | High correctness bar; high complexity (Tower-level scope) |
| SSH key / credential manager UI | Platform-specific; multi-week scope per platform; rely on system git auth |
| In-app HTTPS credential manager | Rely on git's configured credential helper |
| Cherry-pick series (multi-select) | Requires multi-select graph first |
| Force push (--force) | Force-with-lease deferred; plain --force never exposed in GUI without undo system |
| Multi-repo functional tabs | Tab bar visible but non-functional (established v0.1 decision) |
| Syntax highlighting in diffs | Deferred to v0.4 |
| Settings/preferences UI | Deferred to v1.0 |
| Commit signing | Deferred to v1.0 |
| Auto-updates | Deferred to v1.0 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Plan | Status |
|-------------|-------|------|--------|
| STASH-01 | Phase 11 | 11-03 | Pending |
| STASH-02 | Phase 11 | 11-02 | Pending |
| STASH-03 | Phase 11 | 11-03 | Pending |
| STASH-04 | Phase 11 | 11-03 | Pending |
| STASH-05 | Phase 11 | 11-03 | Pending |
| STASH-06 | Phase 11 | 11-03 | Pending |
| STASH-07 | Phase 11 | 11-02 | Pending |
| MENU-01 | Phase 12 | 12-02 | Pending |
| MENU-02 | Phase 12 | 12-02 | Pending |
| MENU-03 | Phase 12 | 12-01 | Pending |
| MENU-04 | Phase 12 | 12-01 | Pending |
| MENU-05 | Phase 12 | 12-01 | Pending |
| MENU-06 | Phase 12 | 12-01 | Pending |
| MENU-07 | Phase 12 | 12-01 | Pending |
| REMOTE-01 | Phase 13 | 13-01 | Pending |
| REMOTE-02 | Phase 13 | 13-01 | Pending |
| REMOTE-03 | Phase 13 | 13-01 | Pending |
| REMOTE-04 | Phase 13 | 13-01 | Pending |
| TRACK-01 | Phase 14 | 14-01 | Pending |
| TRACK-02 | Phase 14 | 14-01 | Pending |
| TOOLBAR-01 | Phase 14 | 14-02 | Pending |
| TOOLBAR-02 | Phase 14 | 14-02 | Pending |
| TOOLBAR-03 | Phase 14 | 14-02 | Pending |

**Coverage:**
- v0.3 requirements: 23 total
- Mapped to phases: 23
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-10*
*Last updated: 2026-03-10 — traceability complete; all 23 requirements mapped across phases 11-14; plan-level traceability added*
