---
phase: 11-stash-operations
verified: 2026-03-11T21:00:00Z
status: gaps_found
score: 14/21 must-haves verified
re_verification:
  previous_status: human_needed
  previous_score: 17/17
  gaps_closed:
    - "Hovering stash entries shows default cursor, not context-menu icon"
    - "Clicking a stash entry in the sidebar shows the stash diff in the right pane"
    - "After creating/popping/applying/dropping a stash, the UI refreshes immediately"
    - "Stash Drop from sidebar shows confirmation dialog and removes the stash"
  gaps_remaining:
    - "STASH-02: Stash entries visible in commit graph as synthetic rows"
    - "STASH-07: Right-click stash row in commit graph for Pop/Apply/Drop context menu"
  regressions:
    - "Truths 8-14 from plan 11-02 regressed: stash graph rendering code was entirely removed by user during UAT"
gaps:
  - truth: "STASH-02: User can see stash entries in commit graph as synthetic rows with square dots"
    status: failed
    reason: "Stash graph rendering was entirely removed by user during UAT (reported: 'We ended up removing this completely because you just couldn't get it right'). No stash-related code remains in CommitGraph.svelte or LaneSvg.svelte."
    artifacts:
      - path: "src/components/CommitGraph.svelte"
        issue: "No makeStashItem, no __stash_ sentinel, no stash context menu handler — all removed"
      - path: "src/components/LaneSvg.svelte"
        issue: "No __stash_ branch for hollow square rendering — removed"
    missing:
      - "Reimplement stash row injection in CommitGraph.svelte (makeStashItem, displayItems splice)"
      - "Reimplement hollow square dot rendering in LaneSvg.svelte"
      - "Reimplement stash column placement (rightmost column)"
      - "Optionally add dashed connectors per REQUIREMENTS.md"
  - truth: "STASH-07: User can right-click stash row in commit graph for Pop/Apply/Drop context menu"
    status: failed
    reason: "Depends on STASH-02 stash graph rendering which was removed. No showStashContextMenu or stash right-click handler in CommitGraph.svelte."
    artifacts:
      - path: "src/components/CommitGraph.svelte"
        issue: "No showStashContextMenu handler, no oncontextmenu binding for stash rows"
    missing:
      - "Reimplement showStashContextMenu with Pop/Apply/Drop menu items"
      - "Wire oncontextmenu on stash rows to the handler"
      - "Include ask() confirmation for Drop action"
---

# Phase 11: Stash Operations Verification Report

**Phase Goal:** Users can manage their stash stack without touching the terminal, and stash entries are visible and actionable in the commit graph at their parent commit
**Verified:** 2026-03-11
**Status:** gaps_found -- stash graph rendering (STASH-02, STASH-07) was removed during UAT; sidebar operations fully functional
**Re-verification:** Yes -- after gap closure plan 11-04

## Goal Achievement

### Plan 11-04 Gap Closure (Re-verification Focus)

| # | Truth (from 11-04 must_haves) | Status | Evidence |
|---|-------------------------------|--------|----------|
| 1 | Hovering stash entries shows default cursor, not context-menu icon | VERIFIED | BranchSidebar.svelte line 417: `cursor: default;` on `.stash-row` |
| 2 | Clicking a stash entry in the sidebar shows the stash diff in the right pane | VERIFIED | BranchSidebar.svelte line 371: `onclick={() => onstashselect?.(stash.oid)}`; App.svelte line 334: `onstashselect={handleCommitSelect}` wires to diff loader |
| 3 | After creating/popping/applying/dropping a stash, the UI refreshes immediately | VERIFIED | All 4 handlers call `onrefreshed?.()` after `loadRefs`: lines 150, 181, 193, 211 in BranchSidebar.svelte |
| 4 | Stash Drop from sidebar shows confirmation dialog and removes the stash | VERIFIED | `dialog:allow-ask` in capabilities/default.json line 9; `handleStashDrop` calls `ask()` at line 202; menu callbacks have `.catch()` at lines 168-170 |

**Plan 11-04 Score:** 4/4 gap closures verified

### Plan 11-01 Observable Truths (Quick Regression Check)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | stash_save creates a stash entry and repopulates the commit cache | VERIFIED | `stash_save_inner` in stash.rs; `stash_save_creates_entry` test passes (8/8 total) |
| 2 | stash_save on a clean workdir returns a nothing_to_stash error | VERIFIED | `stash_save_clean_workdir` test passes; error code `"nothing_to_stash"` |
| 3 | list_stashes returns each entry with its parent_oid and oid | VERIFIED | `list_stashes_returns_parent_oid` test passes; StashEntry now includes `oid` field (line 35 stash.rs) |
| 4 | stash_pop restores the working tree and removes the stash entry | VERIFIED | `stash_pop_removes_entry` test passes |
| 5 | stash_apply restores the working tree and keeps the stash entry | VERIFIED | `stash_apply_keeps_entry` test passes |
| 6 | stash_drop removes the stash entry without touching the working tree | VERIFIED | `stash_drop_removes_entry` test passes |
| 7 | All stash mutation commands emit repo-changed after cache repopulation | VERIFIED | Lines 152-153, 174-175, 196-197, 218-219 in stash.rs: `cache.0.lock()...insert()` then `app.emit("repo-changed", path)` |

**Plan 11-01 Score:** 7/7 verified

### Plan 11-02 Observable Truths (Graph Rendering -- REMOVED)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 8 | Stash entries appear as synthetic rows in commit graph above parent commit | FAILED | No `makeStashItem`, `__stash_`, or stash-related code in CommitGraph.svelte. Grep returns zero matches. Feature removed by user during UAT. |
| 9 | Each stash row has a hollow square dot (SVG rect) | FAILED | No `__stash_` branch in LaneSvg.svelte. Grep returns zero matches. |
| 10 | Each stash row's color cycles through the 8-color palette | FAILED | No stash column color computation in CommitGraph.svelte. |
| 11 | The stash column is to the right of all active branch lanes | FAILED | No `stashColumn` derived in CommitGraph.svelte. |
| 12 | Right-clicking a stash row shows Pop/Apply/Drop context menu | FAILED | No `showStashContextMenu` in CommitGraph.svelte. |
| 13 | Drop from context menu shows native confirmation dialog | FAILED | No graph-based stash drop handler exists. |
| 14 | After pop/apply/drop from graph, the graph refreshes | FAILED | No graph stash handlers exist. |

**Plan 11-02 Score:** 0/7 -- entire feature removed

### Plan 11-03 Observable Truths (Sidebar -- Quick Regression Check)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 15 | Stash section always shows a '+' button and create form | VERIFIED | BranchSidebar.svelte line 337: `<BranchSection>` with `showCreateButton={true}`, not gated on stash count |
| 16 | Inline nothing_to_stash error shown in sidebar | VERIFIED | `handleStashSave` catches `err.code === 'nothing_to_stash'` (line 153), renders `<p class="stash-error">` (line 363) |
| 17 | Per-entry right-click in sidebar with pop/apply/drop and inline errors | VERIFIED | `showStashEntryMenu` on line 163, `stashEntryErrors` rendered per entry on line 378 |

**Plan 11-03 Score:** 3/3 verified

### Combined Score: 14/21 truths verified (7 failed due to graph removal)

---

## Required Artifacts

### Plan 11-04 Artifacts (Gap Closure)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/types.rs` | StashEntry with oid field | VERIFIED | Line 46: `pub oid: String` present in StashEntry struct |
| `src/lib/types.ts` | StashEntry with oid field | VERIFIED | Line 60: `oid: string;` present in StashEntry interface |
| `src-tauri/capabilities/default.json` | dialog:allow-ask permission | VERIFIED | Line 9: `"dialog:allow-ask"` in permissions array |
| `src/components/BranchSidebar.svelte` | onclick handler, onrefreshed calls, cursor fix | VERIFIED | onclick at line 371, onrefreshed calls at lines 150/181/193/211, cursor: default at line 417 |
| `src/App.svelte` | onstashselect prop wired to handleCommitSelect | VERIFIED | Line 334: `onstashselect={handleCommitSelect}` |

### Plan 11-01 Artifacts (Regression Check)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/types.rs` | StashEntry struct | VERIFIED | Lines 41-48: complete struct with index, name, short_name, oid, parent_oid |
| `src-tauri/src/commands/stash.rs` | All 5 commands + tests | VERIFIED | 339 lines; 5 inner fns, 5 Tauri wrappers, 7 unit tests (8/8 pass) |
| `src-tauri/src/commands/branches.rs` | list_refs_inner with StashEntry including oid | VERIFIED | Lines 120-141: stash enumeration with oid field populated |

### Plan 11-02 Artifacts (REMOVED)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/components/CommitGraph.svelte` | makeStashItem + stash rows + context menu | FAILED | All stash rendering code removed. Zero grep matches for stash-related patterns. |
| `src/components/LaneSvg.svelte` | Hollow square SVG rect for stash rows | FAILED | No `__stash_` branch. Zero grep matches. |

### Plan 11-03 Artifacts (Regression Check)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/components/BranchSidebar.svelte` | Stash section with create form, context menu, error UX | VERIFIED | Lines 337-381: complete stash section with form, entries, context menu, error display |

---

## Key Link Verification

### Plan 11-04 Key Links

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| BranchSidebar.svelte | App.svelte | onstashselect callback prop | VERIFIED | Line 11: `onstashselect?: (oid: string) => void` in Props; line 334 App.svelte: `onstashselect={handleCommitSelect}` |
| BranchSidebar.svelte | onrefreshed | `onrefreshed?.()` after loadRefs | VERIFIED | Lines 150, 181, 193, 211: `onrefreshed?.()` called after every stash mutation |

### Plan 11-01 Key Links (Regression Check)

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| stash.rs | CommitCache | `cache.0.lock()` | VERIFIED | Lines 152, 174, 196, 218: cache insert in all mutation wrappers |
| stash.rs | `app.emit("repo-changed")` | AppHandle.emit | VERIFIED | Lines 153, 175, 197, 219: emit after every cache insert |

### Plan 11-02 Key Links (REMOVED)

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| CommitGraph.svelte | stash commands | safeInvoke in handlers | FAILED | No stash handlers in CommitGraph.svelte |
| LaneSvg.svelte | `__stash_` sentinel | OID prefix check | FAILED | No stash rendering code |

### Plan 11-03 Key Links (Regression Check)

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| BranchSidebar.svelte | stash_save | safeInvoke | VERIFIED | Line 146: `safeInvoke('stash_save', ...)` |
| BranchSidebar.svelte | stash_pop/apply/drop | safeInvoke | VERIFIED | Lines 179, 191, 209 |
| BranchSidebar.svelte | list_stashes reload | loadRefs() | VERIFIED | Lines 149, 180, 192, 210 |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| STASH-01 | 11-01, 11-03 | User can create a stash with an optional name | SATISFIED | `stash_save` Tauri command + sidebar form with optional name input + `nothing_to_stash` inline error |
| STASH-02 | 11-02 | User can see stash entries in commit graph as synthetic rows with square dots and dashed connectors | NOT SATISFIED | Feature was entirely removed during UAT. No stash rendering code exists in CommitGraph.svelte or LaneSvg.svelte. |
| STASH-03 | 11-01, 11-03, 11-04 | User can view the stash list in the sidebar | SATISFIED | `list_stashes` command + `filteredStashes` derived; click-to-diff via onstashselect now works |
| STASH-04 | 11-01, 11-03 | User can pop a stash entry (apply and remove) | SATISFIED | `stash_pop` command (test passes) + sidebar Pop menu item + UI refresh via onrefreshed |
| STASH-05 | 11-01, 11-03, 11-04 | User can apply a stash entry without removing it | SATISFIED | `stash_apply` command (test passes) + sidebar Apply menu item + UI refresh |
| STASH-06 | 11-01, 11-03, 11-04 | User can drop a stash entry without applying it | SATISFIED | `stash_drop` command (test passes) + sidebar Drop with `ask()` confirmation dialog (permission now granted) |
| STASH-07 | 11-02 | User can right-click stash row in commit graph for Pop/Apply/Drop context menu | NOT SATISFIED | Feature was removed along with all graph stash rendering. No stash context menu in CommitGraph.svelte. |

**Requirements: 5/7 satisfied, 2 not satisfied (STASH-02, STASH-07)**

---

## Test Results

| Suite | Result |
|-------|--------|
| `cargo test -p trunk stash` | 8/8 passed |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None found | - | - | - | - |

No TODO/FIXME/placeholder/stub patterns found in any stash-related files.

---

## Human Verification Required

### 1. Sidebar stash click-to-diff (new in 11-04)

**Test:** Open app, create a stash, click the stash entry in the sidebar.
**Expected:** The right pane loads the stash diff (same as clicking a commit in the graph). CommitDetail panel shows stash commit info and file list.
**Why human:** Requires runtime verification that handleCommitSelect correctly loads diff for stash OIDs.

### 2. UI refresh after stash operations (fixed in 11-04)

**Test:** Create a stash from the sidebar '+' button. Pop/apply/drop stashes.
**Expected:** The stash list and commit graph update immediately after each operation (no need to manually refresh).
**Why human:** onrefreshed timing and visual update speed require runtime observation.

### 3. Stash drop confirmation dialog (fixed in 11-04)

**Test:** Right-click a stash entry in sidebar, choose Drop.
**Expected:** Native OS confirmation dialog appears. Confirming removes the stash. Cancelling keeps it.
**Why human:** Tauri dialog:allow-ask permission and ask() behavior require runtime testing.

---

## Gaps Summary

Two requirements are not satisfied: **STASH-02** (stash graph rendering) and **STASH-07** (stash graph context menu). Both were implemented in plan 11-02, but the user reported during UAT that the graph rendering was not working correctly and chose to remove the feature entirely ("We ended up removing this completely because you just couldn't get it right").

The stash graph rendering code has been fully removed from both `CommitGraph.svelte` and `LaneSvg.svelte` -- there is no dead code or partial implementation remaining.

All sidebar-based stash operations (STASH-01, STASH-03, STASH-04, STASH-05, STASH-06) are fully functional. The plan 11-04 gap closures for cursor, click-to-diff, UI refresh, and drop permission are all verified in the codebase.

**Decision needed:** The phase goal states "stash entries are visible and actionable in the commit graph at their parent commit." This is not achieved. The user may choose to:
1. Re-implement stash graph rendering with a different approach
2. Descope STASH-02 and STASH-07 from the phase and mark them as deferred
3. Accept sidebar-only stash management as sufficient for phase completion

---

_Verified: 2026-03-11_
_Verifier: Claude (gsd-verifier)_
