---
phase: 10-differentiators
verified: 2026-03-09T23:55:00Z
status: passed
score: 9/9 must-haves verified
re_verification:
  previous_status: passed
  previous_score: 9/9
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 10: Differentiators Verification Report

**Phase Goal:** Branch/tag labels integrate visually with the graph, and users can control graph column width
**Verified:** 2026-03-09T23:55:00Z
**Status:** passed
**Re-verification:** Yes -- previous verification existed with status passed; full re-verification performed independently

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Branch and tag ref pills display with their lane color as background and white text | VERIFIED | RefPill.svelte line 21: `background: var(--lane-${ref.color_index % 8})` and `color: white` in `pillStyle()` |
| 2 | Remote-only refs appear dimmed; remote refs sharing a commit with a local ref stay full opacity | VERIFIED | RefPill.svelte lines 27-31: `isRemoteOnly()` checks `ref.ref_type !== 'RemoteBranch'` and sibling check; line 23: `opacity: 0.5` |
| 3 | A horizontal connector line links the ref pill column to the commit dot in the graph | VERIFIED | LaneSvg.svelte lines 82-92: SVG `<line>` from x1=0 to x2=cx(commit.column), gated on `commit.refs.length > 0 && commit.oid !== '__wip__' && cx(commit.column) > laneWidth` |
| 4 | Tags use the same lane color as their commit (distinguished by icon prefix only) | VERIFIED | RefPill.svelte: `pillStyle()` uses `ref.color_index % 8` for all ref types uniformly; line 35: tags get diamond prefix only |
| 5 | User sees a fixed header row with column labels: branch/tag, graph, commit message, author, date, sha | VERIFIED | CommitGraph.svelte lines 163-193: header div with all 6 labeled columns (Branch/Tag, Graph, Message, Author, Date, SHA) |
| 6 | User can drag resize handles between column headers to change column widths | VERIFIED | CommitGraph.svelte lines 38-64: `startColumnResize()` with mousedown/mousemove/mouseup pattern; 4 resize handle divs (ref, graph, author, date) at lines 170, 175, 183, 188 |
| 7 | Column widths persist across page refreshes and app restarts | VERIFIED | store.ts lines 78-84: `getColumnWidths`/`setColumnWidths` using LazyStore with `store.save()`; CommitGraph.svelte line 57: persist on mouseup; line 35: load on mount via `$effect` |
| 8 | Commit rows align perfectly with header columns at all widths | VERIFIED | CommitRow.svelte lines 37-68 use identical `columnWidths.ref/graph/author/date/sha` prop widths as CommitGraph.svelte header lines 167-190 |
| 9 | Message column fills remaining space when other columns are resized | VERIFIED | CommitRow.svelte line 52: `class="flex-1"` on message div; CommitGraph.svelte line 177: `class="flex-1 relative pl-1"` on Message header |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/types.rs` | RefLabel with color_index field | VERIFIED | Line 38: `pub color_index: usize` in RefLabel struct |
| `src-tauri/src/git/graph.rs` | color_index populated on RefLabels during output assembly | VERIFIED | Lines 262-264: `let mut refs = ...`; `for r in &mut refs { r.color_index = color_index; }` |
| `src/lib/types.ts` | RefLabel interface with color_index | VERIFIED | Line 21: `color_index: number` in RefLabel interface |
| `src/components/RefPill.svelte` | Lane-colored pill rendering with remote dimming | VERIFIED | 51 lines; `pillStyle()` with lane color (line 21), `isRemoteOnly()` with opacity (lines 27-31), `pillPrefix()` for icons (lines 34-38) |
| `src/components/LaneSvg.svelte` | Horizontal connector line from pill edge to commit dot | VERIFIED | Lines 82-92: conditional `<line>` element with 3 guard conditions |
| `src/lib/store.ts` | ColumnWidths interface and LazyStore persistence | VERIFIED | Lines 59-66: interface with 5 fields; lines 70-76: DEFAULT_WIDTHS; lines 78-84: get/set async functions |
| `src/components/CommitGraph.svelte` | Header row with resize handles above virtual list | VERIFIED | Lines 163-193: header row with 6 columns; lines 38-64: startColumnResize with min/max constraints; lines 271-283: CSS for resize handles |
| `src/components/CommitRow.svelte` | 6-column layout matching header | VERIFIED | Lines 37-70: 6 column divs; line 11: `columnWidths: ColumnWidths` prop; lines 16-26: `relativeDate()` formatter; line 28: WIP detection |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src-tauri/src/git/graph.rs` | `src-tauri/src/git/types.rs` | RefLabel.color_index set from commit color_index | WIRED | Line 264: `r.color_index = color_index` assigns each ref the commit's lane color |
| `src/components/RefPill.svelte` | `src/lib/types.ts` | RefLabel.color_index for lane color CSS variable | WIRED | Line 2: `import type { RefLabel } from '../lib/types.js'`; line 21: `ref.color_index % 8` |
| `src/components/LaneSvg.svelte` | commit.refs | conditional connector line rendering | WIRED | Line 82: `commit.refs.length > 0` gates connector; line 88: `laneColor(commit.color_index)` for stroke |
| `src/components/CommitGraph.svelte` | `src/lib/store.ts` | getColumnWidths/setColumnWidths for persistence | WIRED | Line 6: import statement; line 35: `getColumnWidths().then(...)` on mount; line 57: `setColumnWidths(columnWidths)` on mouseup |
| `src/components/CommitGraph.svelte` | `src/components/CommitRow.svelte` | columnWidths prop passed to each row | WIRED | Line 230: `<CommitRow ... {columnWidths} />` in renderItem snippet |
| `src/components/CommitGraph.svelte` | header row | identical width styles as CommitRow for alignment | WIRED | Header uses `columnWidths.ref/graph/author/date/sha` (lines 167-190) matching CommitRow (lines 37-68) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| DIFF-01 | 10-01-PLAN | User sees branch/tag ref pills colored to match their lane color | SATISFIED | color_index flows end-to-end: Rust graph.rs:264 sets it on RefLabel, types.ts:21 declares it in TS, RefPill.svelte:21 renders `var(--lane-N)` background |
| DIFF-02 | 10-02-PLAN | User can resize the graph column width via drag handle | SATISFIED | 4 resize handles in CommitGraph.svelte header (lines 170/175/183/188); startColumnResize drag handler (lines 38-64); LazyStore persistence (store.ts:78-84) |

**Orphaned Requirements:** The REQUIREMENTS.md traceability table contains two mapping errors:
- VIS-01, VIS-02, VIS-03 are mapped to "Phase 10" but were actually implemented and verified in Phase 9 (09-01-PLAN declares them; 09-VERIFICATION confirms them).
- DIFF-01, DIFF-02 are mapped to "Phase 11" but are actually Phase 10 requirements (ROADMAP.md Phase 10 declares them; 10-01-PLAN and 10-02-PLAN claim them).
- Net result: no actual orphaned requirements for Phase 10. All planned requirements are covered.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | - |

No TODOs, FIXMEs, stubs, placeholders, console.logs, or empty implementations found in any phase 10 modified files.

### Test Verification

- **Rust tests:** Two new tests added and substantive: `ref_label_color_index` (graph.rs:989) asserts every ref's color_index matches its commit's color_index; `ref_label_no_refs_no_panic` (graph.rs:1014) asserts commits without refs have empty vec.
- **Commits:** All 4 task commits verified in git log: `41c517a`, `f533784`, `2e4ee7b`, `93d19b4`.

### Human Verification Required

### 1. Lane-colored ref pills visual correctness

**Test:** Open a repository with multiple branches and tags. Check that ref pills next to commits use the same color as their lane line in the graph.
**Expected:** Each pill's background color matches the vertical lane line of its branch. Tags show a diamond prefix. HEAD pill is bold.
**Why human:** Color matching between SVG lane lines and CSS-styled pills requires visual inspection.

### 2. Remote-only ref dimming

**Test:** Open a repository that has remote-tracking branches without corresponding local branches. Check that those ref pills appear dimmed.
**Expected:** Remote-only branch pills render at 50% opacity. Remote branches that share a commit with a local branch render at full opacity.
**Why human:** Opacity distinction requires visual comparison.

### 3. Connector line rendering

**Test:** Scroll through commits with refs in a multi-branch repository. Check that a horizontal line connects from the left edge to the commit dot.
**Expected:** Horizontal connector line visible for commits with refs whose dot is not in column 0. No connector for WIP row or column-0 commits.
**Why human:** SVG rendering accuracy requires visual inspection.

### 4. Column resize interaction

**Test:** Drag each resize handle (Branch/Tag, Graph, Author, Date) left and right.
**Expected:** Column widths change smoothly during drag. Header and row columns stay aligned. Message column absorbs remaining space.
**Why human:** Drag interaction smoothness and visual alignment require real-time interaction testing.

### 5. Column width persistence

**Test:** Resize columns, then reload the application.
**Expected:** Column widths are restored to the values set before reload.
**Why human:** Requires app restart cycle to verify LazyStore persistence.

### 6. Six-column layout completeness

**Test:** Open a repository and inspect commit rows.
**Expected:** Each row shows: ref pills | graph SVG | commit message | author name | relative date | short SHA. WIP row shows empty author/date/sha columns.
**Why human:** Layout completeness and text truncation behavior require visual inspection.

### Gaps Summary

No gaps found. All 9 observable truths verified against the actual codebase with line-number evidence. All 8 required artifacts exist, are substantive (not stubs), and are properly wired. All 6 key links confirmed. Both requirements (DIFF-01, DIFF-02) satisfied. No anti-patterns detected. All 4 commits verified.

---

_Verified: 2026-03-09T23:55:00Z_
_Verifier: Claude (gsd-verifier)_
