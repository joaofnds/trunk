---
phase: 04-working-tree-staging
verified: 2026-03-05T00:00:00Z
status: human_needed
score: 11/11 must-haves verified
human_verification:
  - test: "Visual staging panel end-to-end"
    expected: "Panel appears as third column; files show colored icons; hover reveals +/- button; Stage All / Unstage All work; terminal file-edit triggers refresh within ~300ms; clean repo shows both sections at (0); branch sidebar and commit graph still work"
    why_human: "UI appearance, hover interactions, real-time filesystem watcher behavior, and workflow completion cannot be verified programmatically"
---

# Phase 4: Working Tree Staging Verification Report

**Phase Goal:** Deliver a working staging panel — users can view working-tree status, stage/unstage individual files and all files at once, with automatic refresh on filesystem changes.
**Verified:** 2026-03-05
**Status:** human_needed — all automated checks pass; one blocking human checkpoint remains (end-to-end visual/interactive verification)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `get_status_inner` returns files split into unstaged and staged lists | VERIFIED | staging.rs:38-89 iterates `repo.statuses()`, classifies via INDEX_*/WT_* bitflags into separate vecs |
| 2 | `stage_file_inner` moves a file from unstaged to staged | VERIFIED | staging.rs:91-101 calls `index.add_path` + `index.write()`; Test 4 confirms behavior |
| 3 | `unstage_file_inner` moves a file from staged to unstaged | VERIFIED | staging.rs:110-132 uses `reset_default` for committed repos; Test 5 confirms |
| 4 | `unstage_file_inner` on unborn HEAD does not panic — clears index entry instead | VERIFIED | staging.rs:117-121 checks `is_head_unborn`, uses `index.remove_path` path; Test 6 passes |
| 5 | `stage_all_inner` stages every unstaged file at once | VERIFIED | staging.rs:134-143 uses `index.add_all(["*"])` + `index.write()`; Test 7 confirms |
| 6 | `unstage_all_inner` clears every staged file at once | VERIFIED | staging.rs:145-172 uses `index.clear` (unborn) or `reset_default` on all staged paths; Test 8 confirms |
| 7 | All 8 unit tests pass | VERIFIED | `cargo test -- staging::tests`: 8 passed; 0 failed |
| 8 | Filesystem watcher starts on `open_repo` and emits 'repo-changed' after 300ms debounce | VERIFIED | watcher.rs:18-40 `new_debouncer(300ms, app.emit("repo-changed", ...))` stored in WatcherState; repo.rs:30 calls `start_watcher` |
| 9 | Watcher stops on `close_repo` | VERIFIED | repo.rs:44 calls `stop_watcher(&path, &watcher_state)` which removes Debouncer from map (drop = stop) |
| 10 | StagingPanel is wired into App.svelte as the third pane | VERIFIED | App.svelte:6 imports StagingPanel; App.svelte:48 mounts `<StagingPanel repoPath={repoPath!} />` alongside BranchSidebar and CommitGraph |
| 11 | StagingPanel listens for 'repo-changed' event and auto-refreshes | VERIFIED | StagingPanel.svelte:71-81 `listen('repo-changed', handler)` in `$effect` with unlisten cleanup |

**Score:** 11/11 truths verified (automated)

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/commands/staging.rs` | 5 inner fns + 5 Tauri command wrappers + 8 unit tests | VERIFIED | 404 lines; all 10 pub functions present; `#[cfg(test)]` block with 8 named tests |
| `src-tauri/src/watcher.rs` | `WatcherState` + `start_watcher` + `stop_watcher` | VERIFIED | 44 lines; `WatcherState(pub Mutex<WatcherMap>)` with `Default` impl; both fns pub |
| `src-tauri/src/commands/repo.rs` | `open_repo` starts watcher; `close_repo` stops watcher | VERIFIED | `open_repo` takes `watcher_state: State<'_, WatcherState>` + `app: AppHandle`, calls `start_watcher` at line 30; `close_repo` calls `stop_watcher` at line 44 |
| `src-tauri/src/lib.rs` | `WatcherState` managed + all 5 staging commands registered | VERIFIED | `.manage(WatcherState(Default::default()))` at line 17; all 5 staging commands in `generate_handler!` at lines 25-29 |
| `src-tauri/src/commands/mod.rs` | `pub mod staging` declared | VERIFIED | Line 6: `pub mod staging;` |
| `src/components/FileRow.svelte` | File row with status icon, filename, hover action button, loading state | VERIFIED | 93 lines; all 6 status types mapped with colors; `{#if hovered && !isLoading}` action button; loading state mutes colors |
| `src/components/StagingPanel.svelte` | Full panel with header, two collapsible sections, staging actions, event listener | VERIFIED | 242 lines; header with count + branch pill; two collapsible sections with Stage All / Unstage All; FileRow used; `listen('repo-changed')` in `$effect` |
| `src/App.svelte` | StagingPanel mounted as third pane; phase 4 comment removed | VERIFIED | Line 6 imports `StagingPanel`; line 48 mounts it; no `<!-- Phase 4 adds StagingPanel here -->` comment present |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `staging.rs` inner fns | git2 index/status API | `open_repo_from_state` | WIRED | `open_repo_from_state` at line 9; called in all 5 inner functions |
| `watcher.rs start_watcher` | notify-debouncer-mini Debouncer | `new_debouncer(Duration::from_millis(300), ...)` | WIRED | watcher.rs:20 — 300ms debouncer confirmed |
| `watcher closure` | Tauri frontend | `app.emit("repo-changed", path_clone...)` | WIRED | watcher.rs:24 — `app.emit("repo-changed", ...)` with `use tauri::Emitter` in scope |
| `open_repo` | WatcherState | `start_watcher` call | WIRED | repo.rs:30 `watcher::start_watcher(path_buf, app, &watcher_state)` |
| `close_repo` | WatcherState | `stop_watcher` / remove | WIRED | repo.rs:44 `watcher::stop_watcher(&path, &watcher_state)` |
| `StagingPanel.svelte` | `get_status` Tauri command | `safeInvoke<WorkingTreeStatus>('get_status', { path: repoPath })` | WIRED | StagingPanel.svelte:31 |
| `StagingPanel.svelte` | `stage_file` / `unstage_file` / `stage_all` / `unstage_all` | `safeInvoke(...)` in action handlers | WIRED | StagingPanel.svelte:39, 48, 56, 61 |
| `StagingPanel $effect` | 'repo-changed' Tauri event | `listen('repo-changed', handler)` with unlisten cleanup | WIRED | StagingPanel.svelte:71-81 |
| `App.svelte` | `StagingPanel.svelte` | `<StagingPanel repoPath={repoPath!} />` | WIRED | App.svelte:6 (import) + App.svelte:48 (mount) |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| STAGE-01 | 04-01, 04-03, 04-04 | User can see working tree status with files split into unstaged/staged lists, including status type | SATISFIED | `get_status_inner` classifies all file types; StagingPanel renders two sections with colored status icons in FileRow |
| STAGE-02 | 04-01, 04-03, 04-04 | User can stage or unstage individual files | SATISFIED | `stage_file_inner` / `unstage_file_inner` Tauri commands; StagingPanel hover action button calls `stageFile`/`unstageFile` |
| STAGE-03 | 04-01, 04-03, 04-04 | User can stage all unstaged / unstage all staged with dedicated buttons | SATISFIED | `stage_all_inner` / `unstage_all_inner` commands; StagingPanel "Stage All Changes" and "Unstage All" buttons call `stageAll`/`unstageAll` |
| STAGE-04 | 04-02, 04-04 | Working tree status refreshes automatically on filesystem changes via 300ms debounce watcher | SATISFIED | `watcher.rs` implements 300ms debouncer emitting 'repo-changed'; StagingPanel listens and calls `loadStatus()` — manual verification still required per VALIDATION.md |

No orphaned requirements: all 4 STAGE-0x IDs declared in plan frontmatter map to Phase 4, and all are accounted for above.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/components/CommitGraph.svelte` | 93 | Pre-existing type error (`SvelteVirtualListScrollOptions` align type mismatch) | Warning | Pre-existing before phase 4 (created in phase 2, commit `20c8fd9`); no impact on staging feature |

No anti-patterns found in any phase 4 files. No stubs, placeholder comments, empty handlers, or unwired connections detected in `staging.rs`, `watcher.rs`, `repo.rs`, `lib.rs`, `FileRow.svelte`, `StagingPanel.svelte`, or `App.svelte`.

The `index.remove_path` call in `unstage_file_inner` (staging.rs:120) is correctly gated behind `is_head_unborn` — not an anti-pattern, this is the correct behavior for unborn-HEAD repos.

---

### Human Verification Required

#### 1. End-to-End Staging Workflow

**Test:** Run `bun run tauri dev`, open a local git repository with uncommitted changes.

**Expected:**
1. Staging panel visible as the rightmost of three columns (branch sidebar | commit graph | staging panel)
2. Files appear in "Unstaged Files (N)" section with colored icons: green `+` for new, orange pencil for modified, red `-` for deleted, blue `->` for renamed
3. Hover over an unstaged file — small `+` action button appears. Click it. File moves to "Staged Files" section.
4. Hover over a staged file — small `-` button appears. Click it. File moves back to "Unstaged Files".
5. Click "Stage All Changes" — all unstaged files move to staged. Click "Unstage All" — all staged files return to unstaged.
6. In a terminal, run `echo "test" >> <some-tracked-file>`. Within ~300ms the staging panel updates automatically without user action.
7. On a clean repository (no changes): both "Unstaged Files (0)" and "Staged Files (0)" sections are visible with empty lists.
8. Branch sidebar still lists branches; commit graph still scrolls and renders commits correctly.

**Why human:** Visual layout, hover interaction, real-time filesystem watcher behavior (timing and OS FSEvents), and end-to-end workflow completion cannot be verified without a running Tauri app. The 04-04-SUMMARY.md documents that a human approved all 7 checks, but this verification must independently confirm or re-confirm that state.

---

### Gaps Summary

No automated gaps. All 11 observable truths are verified against the actual codebase. All artifacts are substantive and fully wired. All 4 requirements are satisfied.

One item requires human confirmation: the full interactive workflow was human-approved during plan 04-04 execution (documented in 04-04-SUMMARY.md: "Human verified all 7 end-to-end checks"), but because this is the independent verification pass, the human checkpoint is re-listed for awareness rather than as a gap.

The pre-existing CommitGraph.svelte type error (`SvelteVirtualListScrollAlign` mismatch) is out of scope for phase 4 and was present before this phase began.

---

## Test Results

```
cargo test -- staging::tests
# result: ok. 8 passed; 0 failed

cargo test (full suite)
# result: ok. 25 passed; 0 failed
```

---

## Commit Verification

All documented commits confirmed present in git history:

| Commit | Description |
|--------|-------------|
| `941072d` | test(04-01): add failing tests for staging commands |
| `fb7f916` | feat(04-01): implement staging commands backend |
| `05c573e` | feat(04-02): wire watcher into open_repo/close_repo and manage WatcherState |
| `466c6ce` | feat(04-03): create FileRow.svelte component |
| `2da4982` | feat(04-03): create StagingPanel.svelte component |
| `d6c3ac0` | feat(04-04): wire StagingPanel into App.svelte as third pane |

---

_Verified: 2026-03-05_
_Verifier: Claude (gsd-verifier)_
