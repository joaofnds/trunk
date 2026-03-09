---
phase: 05-commit-creation
verified: 2026-03-07T00:00:00Z
status: human_needed
score: 12/12 automated must-haves verified
re_verification: false
human_verification:
  - test: "Empty subject shows inline error"
    expected: "Clicking Commit with empty subject field shows 'Subject is required' below the subject input; typing any character clears the error immediately"
    why_human: "DOM rendering and reactive error clearing requires visual/interaction verification"
  - test: "Empty staged area shows inline error (non-amend)"
    expected: "With no files staged and non-empty subject, clicking Commit shows 'No files staged' near the commit button"
    why_human: "UI rendering and conditional display logic requires visual verification"
  - test: "Create commit updates graph immediately"
    expected: "After a successful commit, the commit form clears (subject empty, body empty, amend unchecked) and the new commit appears at the top of the commit graph within the same interaction"
    why_human: "End-to-end timing of repo-changed event -> graphKey bump -> CommitGraph remount requires running app"
  - test: "Amend checkbox pre-populates fields"
    expected: "Checking 'Amend previous commit' populates subject and body with the HEAD commit's message; unchecking clears them"
    why_human: "Live IPC call to get_head_commit_message and field population requires running app"
  - test: "Commit button shows loading state during in-flight invoke"
    expected: "Button text changes to 'Committing...' and is disabled while the invoke is in progress"
    why_human: "Transient UI state during async operation requires manual observation"
---

# Phase 5: Commit Creation Verification Report

**Phase Goal:** Implement commit creation (new commits and amend) with UI form, validation, and immediate graph refresh
**Verified:** 2026-03-07
**Status:** human_needed — all automated checks pass; 5 items require running-app verification
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from Plan must_haves)

#### Plan 01 Truths (Rust backend)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `create_commit_inner` creates a readable commit in the repository | VERIFIED | Test `create_commit_creates_commit` passes; HEAD summary matches input |
| 2 | `create_commit_inner` handles unborn HEAD (first commit in a fresh repo) | VERIFIED | Test `create_commit_unborn_head` passes; `ErrorCode::UnbornBranch` branch returns empty parents vec |
| 3 | `amend_commit_inner` updates HEAD commit message | VERIFIED | Test `amend_commit_updates_message` passes; HEAD summary matches new subject |
| 4 | `amend_commit_inner` includes currently staged changes in the amended tree | VERIFIED | Test `amend_commit_includes_staged` passes; staged_file.txt found in amended commit tree |
| 5 | `get_head_commit_message_inner` returns subject and optional body of HEAD | VERIFIED | Test `get_head_commit_message_returns_message` passes; subject="Subject", body=Some("Body text") |

#### Plan 02 Truths (Frontend form)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 6 | A commit form is always visible at the bottom of the staging panel | VERIFIED | StagingPanel.svelte: file sections in `flex:1; overflow-y:auto` wrapper; CommitForm is last child outside scrollable region |
| 7 | Subject field and optional body field are present | VERIFIED | CommitForm.svelte: `<input type="text">` for subject, `<textarea rows=3>` for body |
| 8 | Amend checkbox pre-populates subject and body with HEAD commit message when checked | VERIFIED (code path) | `handleAmendToggle(true)` calls `safeInvoke('get_head_commit_message')` and sets `subject`/`body`; needs human for runtime |
| 9 | Submitting with empty subject shows an inline error below the subject field | VERIFIED (code path) | `handleSubmit` sets `subjectError = 'Subject is required'` when `!subject.trim()`; error rendered conditionally below input; needs human for runtime |
| 10 | Submitting with empty staged area (non-amend) shows inline error near commit button | VERIFIED (code path) | `handleSubmit` sets `stagedError = 'No files staged'` when `!amend && stagedCount === 0`; rendered below amend row; needs human for runtime |
| 11 | Subject and body errors clear when user edits relevant field | VERIFIED (code path) | `oninput` on subject clears `subjectError`; `$effect` tracking `stagedCount`/`amend` clears `stagedError` |
| 12 | Commit button shows disabled/loading state during in-flight invoke | VERIFIED (code path) | `disabled={committing}`, `opacity: {committing ? 0.6 : 1}`, text = `committing ? 'Committing...' : ...`; needs human for runtime |

#### Plan 03 Truths (Wiring)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 13 | User can create a commit and see it appear at the top of the graph immediately | VERIFIED (code path) | Commands registered; `repo-changed` emitted after cache repopulate; App.svelte listener bumps `graphKey`; `{#key graphKey}` remounts CommitGraph; needs human for runtime |
| 14 | User can amend the most recent commit and see the graph update | VERIFIED (code path) | Same wiring as create; `amend_commit` emits `repo-changed` after cache repopulate; needs human for runtime |
| 15 | After a successful commit, form fields clear and the amend checkbox unchecks | VERIFIED (code path) | `handleSubmit` success branch: `subject = ''`, `body = ''`, `amend = false`; needs human for runtime |

**Score:** 15/15 code paths verified; 5 truths also require human runtime confirmation

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/commands/commit.rs` | create_commit, amend_commit, get_head_commit_message + inner fns | VERIFIED | 332 lines; all 6 exported functions present; 6 unit tests all pass |
| `src-tauri/src/git/types.rs` | HeadCommitMessage DTO with Serialize+Deserialize | VERIFIED | Lines 131-135: `#[derive(Debug, Clone, Serialize, Deserialize)] pub struct HeadCommitMessage` with `subject: String` and `body: Option<String>` |
| `src-tauri/src/lib.rs` | commit commands in generate_handler! | VERIFIED | Lines 30-32: `commands::commit::create_commit`, `amend_commit`, `get_head_commit_message` all present |
| `src/components/CommitForm.svelte` | Complete form with state, validation, amend, submit | VERIFIED | 166 lines; all required state ($state runes), handlers, and markup present |
| `src/components/StagingPanel.svelte` | Scrollable layout with CommitForm mounted at bottom | VERIFIED | Imports CommitForm (line 6); scrollable wrapper at line 125; CommitForm mounted at line 251 |
| `src/lib/types.ts` | HeadCommitMessage TypeScript interface | VERIFIED | Lines 89-92: `export interface HeadCommitMessage { subject: string; body: string \| null; }` |

### Key Link Verification

| From | To | Via | Plan Pattern | Status | Details |
|------|----|-----|--------------|--------|---------|
| `create_commit` Tauri wrapper | CommitCache | `cache.insert` after `refresh_commit_cache` | `cache.*remove.*path` | VERIFIED (evolved) | Plan expected `remove`; actual impl uses repopulate-then-insert (superior pattern per 05-03-SUMMARY); cache is always populated before emit |
| `create_commit` Tauri wrapper | `app.emit` | `repo-changed` event | `emit.*repo-changed` | VERIFIED | Line 117: `let _ = app.emit("repo-changed", path);` |
| `amend_commit` Tauri wrapper | CommitCache | `cache.insert` after `refresh_commit_cache` | `cache.*remove.*path` | VERIFIED (evolved) | Line 140: `cache.0.lock().unwrap().insert(path.clone(), commits)` |
| `StagingPanel.svelte` | `CommitForm.svelte` | import + mount with props | `CommitForm.*repoPath.*stagedCount` | VERIFIED | Line 6: import; line 251: `<CommitForm {repoPath} stagedCount={status?.staged.length ?? 0} />` |
| `CommitForm.svelte` | `safeInvoke('create_commit')` | handleSubmit when !amend | `safeInvoke.*create_commit` | VERIFIED | Lines 66-70: `safeInvoke('create_commit', { path, subject, body })` in non-amend branch |
| `CommitForm.svelte` | `safeInvoke('amend_commit')` | handleSubmit when amend | `safeInvoke.*amend_commit` | VERIFIED | Lines 60-64: `safeInvoke('amend_commit', { path, subject, body })` in amend branch |
| `CommitForm.svelte` | `safeInvoke('get_head_commit_message')` | amend checkbox oninput handler | `safeInvoke.*get_head_commit_message` | VERIFIED | Line 31: `safeInvoke<HeadCommitMessage>('get_head_commit_message', { path: repoPath })` |
| `src/App.svelte` | CommitGraph (via graphKey) | `listen('repo-changed')` -> `handleRefresh()` -> `graphKey += 1` | `listen.*repo-changed.*handleRefresh` | VERIFIED | Lines 23-29: `$effect` with `listen<string>('repo-changed', ...)` calling `handleRefresh()`; line 53: `{#key graphKey}` wraps CommitGraph |
| `src-tauri/src/lib.rs generate_handler!` | commands::commit module | three commands registered | `commands::commit` | VERIFIED | Lines 30-32 in lib.rs |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| COMIT-01 | 05-01, 05-03 | User can create a commit with subject and optional body; author from gitconfig `repo.signature()` | SATISFIED | `create_commit_inner` uses `repo.signature()`; test `create_commit_uses_signature` verifies author name; `create_commit` registered in `generate_handler!`; `CommitForm.svelte` calls `safeInvoke('create_commit')` |
| COMIT-02 | 05-02, 05-03 | App refuses to create commit if subject empty or staged area empty, with visible validation message | SATISFIED | `handleSubmit` enforces both guards; `subjectError`/`stagedError` rendered conditionally in CommitForm markup |
| COMIT-03 | 05-01, 05-03 | User can amend most recent commit, updating message or adding staged changes | SATISFIED | `amend_commit_inner` calls `head_commit.amend(...)` with current index tree; `handleAmendToggle` pre-populates fields; `amend_commit` registered in `generate_handler!` |

All three requirements from REQUIREMENTS.md are accounted for. No orphaned requirements.

### Anti-Patterns Found

| File | Pattern | Severity | Notes |
|------|---------|----------|-------|
| `CommitForm.svelte:94,115` | `placeholder="..."` | INFO | HTML input placeholder attributes — these are correct UI labels, not stub code |

No actual anti-patterns found. The two `placeholder` hits are legitimate HTML attributes, not placeholder stub code.

### Human Verification Required

The following items cannot be verified from static analysis alone. Run `bun tauri dev` and test each flow.

#### 1. Empty Subject Validation

**Test:** Open a repo with staged files. Click "Commit" with the subject field empty.
**Expected:** Inline error "Subject is required" appears immediately below the subject input. Type any character — error disappears without clicking anything.
**Why human:** Reactive DOM rendering and clearing behavior requires live interaction.

#### 2. Empty Staged Area Validation (non-amend mode)

**Test:** Open a repo with no staged files. Enter a subject. Click "Commit".
**Expected:** Inline error "No files staged" appears near the commit button. The form does not invoke `create_commit`.
**Why human:** Conditional error rendering and absence of IPC call requires manual verification.

#### 3. Create Commit — Graph Refresh

**Test:** Stage at least one file. Enter subject "Test commit from Trunk". Click "Commit".
**Expected:** Button briefly shows "Committing..." then form clears (subject empty, body empty, amend unchecked). New commit "Test commit from Trunk" appears immediately at the top of the commit graph. Staged files list empties.
**Why human:** Real-time event timing (repo-changed -> graphKey bump -> CommitGraph remount) and graph update require running app.

#### 4. Amend Flow — Pre-population and Graph Update

**Test:** Check "Amend previous commit" checkbox.
**Expected:** Subject and body fields populate with the HEAD commit's message. Edit subject to "Amended: ...". Click "Amend Commit". Form clears, checkbox unchecks. Commit graph shows the amended message at the same graph position.
**Why human:** Live IPC round-trip to `get_head_commit_message` and graph update require running app.

#### 5. Loading State During Commit

**Test:** Stage a file, enter a subject, click "Commit" and observe the button before the commit completes.
**Expected:** Button shows "Committing..." text and appears visually disabled (reduced opacity) while the Rust command executes.
**Why human:** Transient async state is not observable through static analysis.

### Gaps Summary

No gaps. All automated checks pass. The only open items are the 5 human verification items above, which test real-time UX behavior and event-driven graph updates that cannot be verified statically.

Notable implementation detail: The 05-03 plan's documented `cache.*remove.*path` key link pattern was superseded by a superior "repopulate-before-emit" approach (`refresh_commit_cache` + `cache.insert` inside the same `spawn_blocking` closure). This is correctly documented in 05-03-SUMMARY.md as a bug fix that prevents a race condition between cache invalidation and graph remount. The goal — cache consistency across commit operations — is more robustly satisfied by the actual implementation than the original plan required.

---

_Verified: 2026-03-07_
_Verifier: Claude (gsd-verifier)_
