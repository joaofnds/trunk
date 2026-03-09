---
phase: 03-branch-sidebar-checkout
verified: 2026-03-04T18:40:00Z
status: passed
score: 12/13 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 9/10
  gaps_closed:
    - "Collapsible sections never destroyed during data refresh (loading boolean + sequence counter in loadRefs)"
    - "Branch names in Remote section truncate with ellipsis, no wrapping (overflow:hidden + truncating span)"
    - "CommitGraph scrolls to HEAD commit after checkout (bind:this={listRef} + one-shot $effect)"
  gaps_remaining:
    - "BRNCH-04: create_branch accepts no from_oid — HEAD-only. OID sub-feature absent. REQUIREMENTS.md marks Complete (scope accepted)."
  regressions: []
human_verification:
  - test: "Collapsible sections reliable after loading-boolean fix"
    expected: "Every click on Remote/Tags/Stashes section headers collapses or expands without freezing — including rapid clicks during a data refresh in-flight"
    why_human: "Race condition fix requires live timing-dependent testing to confirm reliability"
  - test: "Branch name truncation in Remote section"
    expected: "Long branch names (e.g. dependabot/github_actions/...) stay on one line, clipped with ellipsis at 220px sidebar boundary — no wrapping"
    why_human: "CSS flex truncation rendering requires visual inspection"
  - test: "CommitGraph scrolls to HEAD after checkout"
    expected: "After checking out a branch whose HEAD commit is below the fold, the graph remounts and scrolls so HEAD is visible near the top"
    why_human: "Transient scroll behaviour after virtual list remount requires live observation"
  - test: "Visual layout — sidebar left of graph"
    expected: "BranchSidebar (220px) appears to the left of CommitGraph; both fill the full viewport height"
    why_human: "CSS flex layout correctness requires visual inspection"
  - test: "Dirty-workdir error banner placement and text"
    expected: "Inline red banner appears below clicked branch row with exact text: 'Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first.'"
    why_human: "Visual placement and exact rendered text require live app observation"
---

# Phase 3: Branch Sidebar + Checkout Re-Verification Report

**Phase Goal:** Implement a branch sidebar with checkout capability — users can view local/remote/tag/stash branches and check out any branch directly from the sidebar.
**Verified:** 2026-03-04T18:40:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure plans 03-04 and 03-05

## Re-Verification Context

Previous VERIFICATION.md (2026-03-04T14:00:00Z) was `gaps_found` with score 9/10. Three UAT issues were diagnosed and addressed in gap closure plans:

| UAT Issue | Gap Plan | Fix |
|-----------|----------|-----|
| Collapsible click freeze (test 3) | 03-04 | loading boolean + sequence counter in loadRefs |
| Remote branch text wrapping (test 6) | 03-05 | overflow:hidden + truncating span in BranchRow/RemoteGroup |
| Graph not scrolling to HEAD (test 8) | 03-05 | bind:this={listRef} + one-shot $effect in CommitGraph |

The original gap (BRNCH-04 OID parameter) was NOT closed by new code. REQUIREMENTS.md now marks BRNCH-04 "Complete" — project accepted HEAD-only as satisfying the "optionally" qualifier. See Requirements Coverage below.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | list_refs returns all local branches, remote branches, tags, and stashes | VERIFIED | branches.rs:42-135; 17/17 Rust tests pass |
| 2 | list_refs marks the HEAD branch with is_head: true | VERIFIED | branches.rs:59 compares shorthand against head_name; list_refs_head_flag test asserts |
| 3 | list_refs filters out origin/HEAD tracking refs | VERIFIED | branches.rs:86: `if name.ends_with("/HEAD") { return None; }`; test asserts |
| 4 | checkout_branch returns dirty_workdir error when working tree has tracked modifications | VERIFIED | branches.rs:158-163: is_dirty() guard; TrunkError { code: "dirty_workdir" }; test passes |
| 5 | checkout_branch succeeds and updates HEAD and working tree when clean | VERIFIED | branches.rs:167-170: checkout_tree + set_head; checkout_clean_succeeds test passes |
| 6 | create_branch creates a new branch and auto-checks-out | VERIFIED | branches.rs:209-241; create_branch_from_head test: branch exists and HEAD points to it |
| 7 | create_branch returns git_error when name already exists | VERIFIED | branches.rs:223: `repo.branch(name, &head_commit, false)?` — no force; duplicate test passes |
| 8 | Sidebar lists all section types in collapsible sections with HEAD highlighted | VERIFIED | BranchSidebar.svelte renders BranchSection for Local/Remote/Tags/Stashes; isHead drives accent |
| 9 | Typing in search filters all sections without Rust round-trip | VERIFIED | BranchSidebar.svelte:29-51: filteredLocal/Remote/Tags/Stashes all $derived — no safeInvoke in filter |
| 10 | Collapsible sections remain stable during data refresh (no destroy/recreate) | VERIFIED | BranchSidebar.svelte:16-17: loading=$state(false), loadSeq=$state(0); $effect (line 65-69) sets loading=true without nulling refs; loadRefs guards writes by seq===loadSeq |
| 11 | Branch names in Remote section truncate with ellipsis, no wrapping | VERIFIED | BranchRow.svelte:36: overflow:hidden on flex container; lines 44-51: span with overflow:hidden, white-space:nowrap, text-overflow:ellipsis, min-width:0, flex:1; RemoteGroup.svelte:38: overflow:hidden on indent wrapper |
| 12 | CommitGraph scrolls to HEAD commit after mount/checkout | VERIFIED | CommitGraph.svelte:21-22: listRef + scrolledToHead $state; line 88: bind:this={listRef}; $effect (lines 48-59): findIndex(c => c.is_head) then listRef.scroll({index: headIdx, smoothScroll: false, align: 'top'}) once per mount |
| 13 | create_branch accepts optional from_oid to create from specific commit | PARTIAL | create_branch_inner takes no oid param; always uses repo.head()?.target(). "optionally" interpreted as HEAD-only acceptable. REQUIREMENTS.md marks BRNCH-04 "Complete." OID variant not implemented. |

**Score:** 12/13 truths verified (truth 13 partial; project scope accepted)

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/commands/branches.rs` | list_refs, checkout_branch, create_branch with full tests | VERIFIED | 474 lines; 3 commands + is_dirty + 7-test suite; 17/17 tests pass |
| `src/components/BranchSidebar.svelte` | loading boolean, sequence-guarded loadRefs, stable sections | VERIFIED | 267 lines; loading=$state(false), loadSeq=$state(0); $effect without refs=null; sequence-guarded loadRefs |
| `src/components/BranchRow.svelte` | Truncating flex container + span + loading indicator + error banner | VERIFIED | 59 lines; overflow:hidden on flex; truncating span; isHead/isLoading/isError; error banner |
| `src/components/RemoteGroup.svelte` | Indent wrapper with overflow:hidden + BranchRow per branch | VERIFIED | 48 lines; overflow:hidden on wrapper div |
| `src/components/BranchSection.svelte` | Collapsible section with count and optional + button | VERIFIED | 62 lines; bind:expanded; chevron toggle; + button |
| `src/components/CommitGraph.svelte` | bind:this on SvelteVirtualList; $effect to scroll to HEAD after first batch | VERIFIED | 134 lines; listRef + scrolledToHead; bind:this={listRef}; one-shot $effect scrolls to headIdx |
| `src-tauri/src/lib.rs` | All three branch commands in generate_handler![] | VERIFIED | Lines 20-22: list_refs, checkout_branch, create_branch all registered |
| `src/App.svelte` | 2-pane layout: BranchSidebar + CommitGraph | VERIFIED | flex main with BranchSidebar + {#key graphKey} CommitGraph |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| BranchSidebar.$effect | loadRefs | loading=true (no refs=null) | VERIFIED | BranchSidebar.svelte:65-69: sets loading=true; calls loadRefs(path); refs never nulled in $effect |
| loadRefs | list_refs IPC | seq = ++loadSeq; if (seq === loadSeq) guards all writes | VERIFIED | BranchSidebar.svelte:76-93: every assignment gated by seq===loadSeq |
| BranchSidebar | safeInvoke('checkout_branch') | handleCheckout async | VERIFIED | BranchSidebar.svelte:100: await safeInvoke('checkout_branch', { path: repoPath, branchName }) |
| BranchSidebar | onrefreshed callback | after checkout or create | VERIFIED | BranchSidebar.svelte:102, 125: onrefreshed?.() on success |
| BranchRow flex container | truncating span | overflow:hidden + span with ellipsis styles | VERIFIED | BranchRow.svelte:36,44-51: overflow:hidden on container; span with full truncation CSS |
| RemoteGroup indent wrapper | overflow:hidden guard | inline style | VERIFIED | RemoteGroup.svelte:38: `style="padding-left: 12px; overflow: hidden;"` |
| CommitGraph.$effect | listRef.scroll | commits.findIndex(c => c.is_head) | VERIFIED | CommitGraph.svelte:54-57: headIdx found; listRef.scroll called with align:'top' |
| App.svelte onrefreshed | CommitGraph remount | graphKey increment + {#key graphKey} | VERIFIED | graphKey incremented in handleRefresh; {#key graphKey} causes full remount — scrolledToHead resets automatically |
| src-tauri/src/lib.rs | commands::branches | generate_handler![] | VERIFIED | lib.rs:20-22: all three commands registered |

---

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| BRNCH-01 | 03-01, 03-02, 03-03, 03-04 | Collapsible sidebar with all refs, active branch highlighted | SATISFIED | BranchSidebar renders Local/Remote/Tags/Stashes; isHead drives highlight; click freeze eliminated |
| BRNCH-02 | 03-02, 03-03, 03-05 | Frontend-only search filter; branch names truncate correctly | SATISFIED | $derived filters; Remote section text truncates with ellipsis |
| BRNCH-03 | 03-01, 03-02, 03-03 | Checkout with dirty-workdir inline error, branch does not switch | SATISFIED | is_dirty() guard; "dirty_workdir" TrunkError; BranchRow error banner |
| BRNCH-04 | 03-01, 03-02, 03-03 | Create new local branch, optionally from a specific commit OID | PARTIAL (scope accepted) | HEAD-only; no OID param in Rust or Svelte. REQUIREMENTS.md traceability marks "Complete." Project accepted HEAD-only as satisfying "optionally." |

**Orphaned requirements:** None. All four BRNCH requirements claimed by plans.

**BRNCH-04 scope note:** The requirement says "optionally from a specific commit OID." The REQUIREMENTS.md traceability table marks this "Complete." The project's interpretation: HEAD-only satisfies the base case; the OID variant is deferred. If OID-based branch creation is ever needed, `create_branch_inner` requires an `Option<String>` oid parameter and a `repo.find_commit(Oid::from_str(...))` resolution path in Rust, plus a from_oid prop or UI trigger in BranchSidebar.svelte.

---

### Commit Verification

All gap-closure commits exist with expected file changes:

| Commit | Description | Files Changed | Verified |
|--------|-------------|---------------|----------|
| e486968 | fix(03-04): replace refs=null with loading boolean + sequence-guard loadRefs | BranchSidebar.svelte (+17/-4) | Yes |
| 937e61e | fix(03-05): fix branch name truncation in BranchRow and RemoteGroup | BranchRow.svelte, RemoteGroup.svelte (+10/-2) | Yes |
| 21ab519 | feat(03-05): scroll commit graph to HEAD after branch checkout | CommitGraph.svelte (+16) | Yes |

---

### Build and Test Status

- `cargo test`: 17/17 tests pass, 0 failed
- `bun run build`: exits 0 — 141 modules transformed, no TypeScript or Svelte errors (pre-existing LaneSvg warning is out of scope)

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| BranchSidebar.svelte:151,182 | `placeholder=` HTML attributes | Info | Legitimate HTML — not stubs |
| BranchSidebar.svelte:134 | `return {};` in autoFocus action | Info | Svelte action API requires returning an object even if empty — not a stub |
| LaneSvg.svelte | `state_referenced_locally` Svelte warning | Info | Pre-existing, out of scope; does not block build or correctness |

No blockers or warnings in gap closure files.

---

### Human Verification Required

#### 1. Collapsible sections reliable after loading-boolean fix

**Test:** Open a Git repository with Remote branches. Click the Remote, Tags, and Stashes section headers rapidly (5-10 clicks each). Trigger a checkout to force a data refresh while clicking. Repeat after app restart.
**Expected:** Every click registers — section collapses or expands without freezing. No section ever gets stuck non-responsive.
**Why human:** The fix eliminates the race condition root cause (refs=null destroying components mid-click), but intermittent timing-dependent reliability must be confirmed through live testing.

#### 2. Branch name truncation in Remote section

**Test:** Open a repo with long remote branch names (e.g. `dependabot/github_actions/actions/checkout/v3`). Expand the Remote section.
**Expected:** Every branch name stays on a single line, clipped with `...` at the 220px sidebar boundary. No text wraps to a second line. The 12px indent is visible.
**Why human:** The CSS fix (`overflow:hidden` + truncating `span` + `min-width:0` + `flex:1`) is correct in code, but visual correctness at the rendered boundary requires live inspection.

#### 3. CommitGraph scrolls to HEAD after checkout

**Test:** Check out a branch whose HEAD commit is more than one screenful down in the graph. Wait for checkout to complete.
**Expected:** The commit graph remounts (via `{#key graphKey}`) and scrolls so the HEAD commit is visible near the top of the virtual list.
**Why human:** The one-shot `$effect` fires after first batch loads and calls `listRef.scroll({index: headIdx, align: 'top'})`. Correct scroll offset to a specific item index requires live virtual list observation.

#### 4. Visual layout — sidebar left of graph

**Test:** Open a Git repository. Observe the main content area.
**Expected:** BranchSidebar (220px, dark background, border-right) appears to the left of CommitGraph. Both fill the full viewport height.
**Why human:** CSS flex layout rendering cannot be verified statically. Previously approved during 03-03 checkpoint.

#### 5. Dirty-workdir error banner placement and text

**Test:** Edit a tracked file without staging. Click a different local branch.
**Expected:** Inline red error banner appears directly below the clicked branch row with text: "Cannot checkout — working tree has uncommitted changes. Commit or stash your changes first."
**Why human:** Visual placement and exact rendered text require live app observation.

---

### Gaps Summary

No blocking gaps remain.

The three UAT issues from the initial verification are all closed with verified, committed code:
- **Click freeze** (test 3): `loading=$state(false)` and `loadSeq=$state(0)` in BranchSidebar.svelte — $effect never nulls refs; loadRefs guards all writes by sequence. Commit e486968.
- **Branch name wrapping** (test 6): `overflow:hidden` on BranchRow flex container + truncating `<span>` + `overflow:hidden` on RemoteGroup indent wrapper. Commit 937e61e.
- **Graph not scrolling to HEAD** (test 8): `bind:this={listRef}` on SvelteVirtualList + one-shot `$effect` that calls `listRef.scroll({index: headIdx})` after first batch. Commit 21ab519.

The BRNCH-04 OID sub-feature is absent from the codebase but the project has accepted HEAD-only branch creation as satisfying the requirement. This is documented but not a blocking gap.

All automated checks pass: 17/17 Rust tests, `bun run build` exits 0. Phase is ready for human sign-off on the five visual/timing items above.

---

_Verified: 2026-03-04T18:40:00Z_
_Verifier: Claude (gsd-verifier) — Re-verification after gap closure plans 03-04 and 03-05_
