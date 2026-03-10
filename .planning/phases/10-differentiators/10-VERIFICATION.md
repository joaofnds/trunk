---
phase: 10-differentiators
verified: 2026-03-10T03:00:19Z
status: passed
score: 9/9 must-haves verified
re_verification:
  previous_status: passed
  previous_score: 9/9
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Lane-colored ref pills match graph lane colors visually"
    expected: "Each pill background matches the vertical lane line of its branch"
    why_human: "Color matching between SVG lane lines and CSS-styled pills requires visual inspection"
  - test: "Remote-only ref pills and connector lines are dimmed"
    expected: "Remote-only pills and their connector lines render at 50% opacity"
    why_human: "Opacity distinction requires visual comparison"
  - test: "Connector line spans from pill end to commit dot"
    expected: "Line starts after the last pill and ends at the commit dot position"
    why_human: "Pixel-level alignment across absolute-positioned elements requires visual inspection"
  - test: "Column resize drag interaction feels smooth"
    expected: "Dragging resize handles changes widths in real time without jank"
    why_human: "Interactive drag behavior and alignment during resize require manual testing"
  - test: "Column widths survive app restart"
    expected: "Close app, reopen, column widths restored"
    why_human: "Requires app restart cycle"
  - test: "Native context menu appears on header right-click with column checkboxes"
    expected: "OS-native context menu with checked/unchecked items per column; Message disabled"
    why_human: "Native menu rendering and behavior require manual interaction"
---

# Phase 10: Differentiators Verification Report

**Phase Goal:** Branch/tag labels integrate visually with the graph, and users can control graph column width
**Verified:** 2026-03-10T03:00:19Z
**Status:** passed
**Re-verification:** Yes -- independent full re-verification of actual codebase (previous passed at 9/9)

## Goal Achievement

### Observable Truths

Consolidated from ROADMAP success criteria and all 5 plan must_haves (deduplicated).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Branch and tag ref pills display with their lane color as background and white text | VERIFIED | RefPill.svelte:21 `background: var(--lane-${ref.color_index % 8})` and `color: white` in pillStyle() |
| 2 | Remote-only refs appear dimmed; remote refs sharing a commit with a local ref stay full opacity | VERIFIED | RefPill.svelte:23 `opacity: 0.5` conditional via isRemoteOnly() (lines 28-32) |
| 3 | A horizontal connector line links the ref pill column to the commit dot in the graph column | VERIFIED | CommitRow.svelte:46-50 absolute-positioned div with dynamic left/width, gated on `commit.refs.length > 0 && commit.oid !== '__wip__' && columnVisibility.graph` |
| 4 | User sees a fixed header row with column labels: Branch/Tag, Graph, Message, Author, Date, SHA | VERIFIED | CommitGraph.svelte:199-243 header div with all 6 labeled columns above flex-1 content area |
| 5 | User can drag resize handles between column headers to change column widths | VERIFIED | CommitGraph.svelte:44-70 startColumnResize() with mousedown/mousemove/mouseup; 5 resize handle divs with col-resize-handle CSS class and linear-gradient default background |
| 6 | Column widths persist across page refreshes and app restarts | VERIFIED | store.ts:78-85 getColumnWidths/setColumnWidths via LazyStore with store.save(); CommitGraph.svelte:63 persists on mouseup; line 37 loads on mount |
| 7 | Message column fills remaining space when other columns are resized | VERIFIED | CommitRow.svelte:78,82 class="flex-1" on message div; CommitGraph.svelte:219 class="flex-1 relative px-2" on Message header |
| 8 | Right-clicking header shows context menu with column visibility toggles | VERIFIED | CommitGraph.svelte:81-99 showHeaderContextMenu() using native Tauri Menu + CheckMenuItem API; line 202 oncontextmenu handler; line 88 Message disabled |
| 9 | Column visibility persists across app restarts | VERIFIED | store.ts:107-114 getColumnVisibility/setColumnVisibility via LazyStore; CommitGraph.svelte:41 loads on mount; line 92 persists on change |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/types.rs` | RefLabel with color_index field | VERIFIED | Line 38: `pub color_index: usize` in RefLabel struct |
| `src-tauri/src/git/graph.rs` | color_index populated on RefLabels during output assembly | VERIFIED | Lines 262-264: `let mut refs = ref_map.get(&oid).cloned()...`; `for r in &mut refs { r.color_index = color_index; }` |
| `src-tauri/src/git/repository.rs` | color_index: 0 initialized in RefLabel construction | VERIFIED | Lines 44 and 55: `color_index: 0` in both construction sites |
| `src/lib/types.ts` | RefLabel interface with color_index | VERIFIED | Line 21: `color_index: number` in RefLabel interface |
| `src/components/RefPill.svelte` | Lane-colored pill rendering with remote dimming | VERIFIED | 45 lines; pillStyle():21 for lane color, isRemoteOnly():28-32 for opacity, pillPrefix():35-38 for icons |
| `src/components/LaneSvg.svelte` | SVG lane rendering with WIP dotted line and overflow visible | VERIFIED | 121 lines; WIP dotted line at lines 59-66; SVG has `overflow: visible` (line 55); old connector line code confirmed absent |
| `src/components/CommitRow.svelte` | 6-column layout with connector line, column visibility, and cell padding | VERIFIED | 107 lines; 6 conditional columns; connector line div (lines 46-50) with allRemoteOnly opacity and refContainerWidth positioning; columnWidths and columnVisibility props |
| `src/lib/store.ts` | ColumnWidths and ColumnVisibility with LazyStore persistence | VERIFIED | Lines 59-85: ColumnWidths with getter/setter; lines 87-114: ColumnVisibility with getter/setter |
| `src/components/CommitGraph.svelte` | Header row with resize handles, context menu, column visibility | VERIFIED | Lines 199-243: header with conditional columns; lines 44-70: startColumnResize; lines 81-99: native Tauri context menu; lines 322-336: CSS for visible dividers |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| graph.rs:264 | types.rs RefLabel | `r.color_index = color_index` | WIRED | Each ref inherits its commit's lane color during output assembly |
| repository.rs:44,55 | types.rs RefLabel | `color_index: 0` initialization | WIRED | Both RefLabel construction sites initialize the field |
| RefPill.svelte:2 | types.ts RefLabel | `import type { RefLabel }` + `ref.color_index % 8` | WIRED | Color index used to select CSS variable for background |
| CommitRow.svelte:46 | commit.refs | `commit.refs.length > 0` gates connector div | WIRED | Connector line renders only for commits with refs, excludes WIP |
| CommitRow.svelte:54 | refContainerWidth | `bind:clientWidth={refContainerWidth}` | WIRED | Pill container measured dynamically, connector left offset calculated from measurement |
| CommitRow.svelte:31-33 | allRemoteOnly | `commit.refs.every(r => r.ref_type === 'RemoteBranch')` | WIRED | Connector opacity tied to remote-only status |
| CommitGraph.svelte:6 | store.ts | `import { getColumnWidths, setColumnWidths, getColumnVisibility, setColumnVisibility }` | WIRED | Load on mount (lines 37,41), persist on change (lines 63,92) |
| CommitGraph.svelte:281 | CommitRow.svelte | `{columnWidths} {columnVisibility}` props in renderItem | WIRED | Both width and visibility state flow from header to each row |
| CommitGraph.svelte:7,81-99 | Tauri Menu API | `Menu.new()` + `CheckMenuItem.new()` + `menu.popup()` | WIRED | Native context menu created with per-column toggle actions |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| DIFF-01 | 10-01, 10-03, 10-04 | User sees branch/tag ref pills colored to match their lane color | SATISFIED | color_index flows end-to-end: Rust graph.rs:264 sets it, types.ts:21 declares it, RefPill.svelte:21 renders `var(--lane-N)` background. Connector line in CommitRow with dynamic positioning, remote-only dimming on both pill and line. |
| DIFF-02 | 10-02, 10-03, 10-05 | User can resize the graph column width via drag handle | SATISFIED | 5 resize handles with linear-gradient visible dividers; startColumnResize drag handler with min/max constraints; LazyStore persistence. Column visibility toggle via native Tauri context menu. |

**Orphaned Requirements:** REQUIREMENTS.md traceability table maps DIFF-01/DIFF-02 to "Phase 11" and VIS-01/02/03 to "Phase 10" -- both are documentation errors. ROADMAP.md and plan frontmatter correctly assign DIFF-01/DIFF-02 to Phase 10. No actual orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No TODOs, FIXMEs, stubs, placeholders, console.logs, or empty implementations found in any Phase 10 artifact |

### Test Verification

- **Rust tests:** `cargo test ref_label` -- 2 passed, 0 failed. Tests `ref_label_color_index` (graph.rs:989) and `ref_label_no_refs_no_panic` (graph.rs:1014) both pass.
- **Commits verified:** f3b9591, bf5ba50, 9fdfcdf, 4bb1282, 0665b5d all exist in git history with correct descriptions.

### User-Driven Deviations from Plans (Not Gaps)

Two deviations from plan-specified truths were made by the user during development:

1. **Data row column dividers removed (10-04 truth):** Commit bf5ba50 intentionally removed `border-right` from CommitRow column cells. The user decided dividers belong only in the header, not data rows. This was a conscious design refinement, not a missing implementation.

2. **HeaderContextMenu.svelte replaced with native Tauri menus (10-05 artifact):** Commit 0665b5d replaced the custom Svelte context menu component with Tauri's native `Menu` + `CheckMenuItem` API. This provides OS-native look-and-feel and automatic cursor positioning. The planned component was created and then deliberately replaced with a superior approach.

Both deviations represent improvements over the original plans, not regressions.

### Human Verification Required

### 1. Lane-colored ref pills visual correctness

**Test:** Open a repository with multiple branches and tags. Check that ref pills next to commits use the same color as their lane line in the graph.
**Expected:** Each pill's background color matches the vertical lane line of its branch. Tags show a diamond prefix. HEAD pill is bold.
**Why human:** Color matching between SVG lane lines and CSS-styled pills requires visual inspection.

### 2. Remote-only ref dimming (pill and connector line)

**Test:** Open a repository that has remote-tracking branches without corresponding local branches. Check that those ref pills AND their connector lines appear dimmed.
**Expected:** Remote-only branch pills and their connector lines render at 50% opacity. Remote branches sharing a commit with a local branch stay at full opacity.
**Why human:** Opacity distinction requires visual comparison.

### 3. Connector line positioning

**Test:** Scroll through commits with refs. Check that the horizontal colored line starts after the pill content and extends to the commit dot.
**Expected:** Line starts right after the pill(s), not from the left edge. For commits with 2+ refs, the overflow +N pill is readable. No connector for WIP row.
**Why human:** Dynamic positioning via bind:clientWidth requires visual inspection.

### 4. Column resize interaction and header dividers

**Test:** Observe header dividers at rest (subtle vertical lines). Drag each resize handle left and right.
**Expected:** Dividers visible without hovering. On hover, dividers brighten. Widths change smoothly. Header and rows stay aligned. Message absorbs remaining space.
**Why human:** Drag interaction smoothness and alignment require manual testing.

### 5. Column width persistence

**Test:** Resize columns, close and reopen the application.
**Expected:** Column widths are restored to the values set before close.
**Why human:** Requires app restart cycle.

### 6. Native context menu for column visibility

**Test:** Right-click on the header row. An OS-native context menu should appear.
**Expected:** Checkboxes for each column. Message is disabled. Unchecking hides column in header and rows. Visibility persists after app restart.
**Why human:** Native menu rendering and toggle behavior require manual interaction.

### Gaps Summary

No gaps found. All 9 observable truths verified against actual codebase with line-number evidence. All required artifacts exist, are substantive, and are properly wired. All 9 key links confirmed. Both requirements (DIFF-01, DIFF-02) satisfied. No anti-patterns detected. Five UAT issues were diagnosed and resolved across plans 10-03 through 10-05, with two user-driven refinements (data row dividers removal, native context menu adoption) representing improvements over original plans.

---

_Verified: 2026-03-10T03:00:19Z_
_Verifier: Claude (gsd-verifier)_
