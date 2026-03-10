---
phase: 10-differentiators
verified: 2026-03-09T23:59:00Z
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
**Verified:** 2026-03-09T23:59:00Z
**Status:** passed
**Re-verification:** Yes -- previous verification existed with status passed; independent full re-verification performed against actual codebase

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Branch and tag ref pills display with their lane color as background and white text | VERIFIED | RefPill.svelte line 21: `background: var(--lane-${ref.color_index % 8})` and `color: white` in `pillStyle()` |
| 2 | Remote-only refs appear dimmed; remote refs sharing a commit with a local ref stay full opacity | VERIFIED | RefPill.svelte lines 27-31: `isRemoteOnly()` returns false when sibling is LocalBranch or Tag; line 23: `opacity: 0.5` conditional |
| 3 | A horizontal connector line links the ref pill column to the commit dot in the graph | VERIFIED | CommitRow.svelte lines 37-41: absolute-positioned div spanning `columnWidths.ref + commit.column * 12 + 6 + 8` px, with `background: var(--lane-{commit.color_index % 8})`, gated on `commit.refs.length > 0 && commit.oid !== '__wip__'`. Old SVG connector removed from LaneSvg (confirmed absent via grep). |
| 4 | Tags use the same lane color as their commit (distinguished by icon prefix only) | VERIFIED | RefPill.svelte: `pillStyle()` uses `ref.color_index % 8` uniformly for all ref types; line 35: tags get diamond prefix only |
| 5 | User sees a fixed header row with column labels: branch/tag, graph, commit message, author, date, sha | VERIFIED | CommitGraph.svelte lines 163-193: header div with all 6 labeled columns (Branch/Tag, Graph, Message, Author, Date, SHA) above the flex-1 content area |
| 6 | User can drag resize handles between column headers to change column widths | VERIFIED | CommitGraph.svelte lines 38-64: `startColumnResize()` with mousedown/mousemove/mouseup; 4 resize handle divs at lines 170, 175, 183, 188; linear-gradient default background makes handles visible at rest (lines 280-281) |
| 7 | Column widths persist across page refreshes and app restarts | VERIFIED | store.ts lines 78-84: `getColumnWidths`/`setColumnWidths` via LazyStore with `store.save()`; CommitGraph.svelte line 57: persist on mouseup; line 35: load on mount via `$effect` |
| 8 | Commit rows align perfectly with header columns at all widths | VERIFIED | CommitRow.svelte lines 45-78 use identical `columnWidths.ref/graph/author/date/sha` prop widths as CommitGraph.svelte header lines 167-192 |
| 9 | Message column fills remaining space when other columns are resized | VERIFIED | CommitRow.svelte lines 56/60: `class="flex-1"` on message div; CommitGraph.svelte line 177: `class="flex-1 relative pl-1"` on Message header |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/types.rs` | RefLabel with color_index field | VERIFIED | Line 38: `pub color_index: usize` in RefLabel struct |
| `src-tauri/src/git/graph.rs` | color_index populated on RefLabels during output assembly | VERIFIED | Lines 261-264: `let mut refs = ref_map.get(&oid).cloned()...`; `for r in &mut refs { r.color_index = color_index; }` |
| `src-tauri/src/git/repository.rs` | color_index: 0 initialized in RefLabel construction | VERIFIED | Lines 44 and 55: `color_index: 0` in both construction sites |
| `src/lib/types.ts` | RefLabel interface with color_index | VERIFIED | Line 21: `color_index: number` in RefLabel interface |
| `src/components/RefPill.svelte` | Lane-colored pill rendering with remote dimming | VERIFIED | 51 lines; `pillStyle()` line 21 for lane color, `isRemoteOnly()` lines 27-31 for opacity, `pillPrefix()` lines 34-38 for icons |
| `src/components/LaneSvg.svelte` | SVG lane rendering; WIP dotted line with overflow visible | VERIFIED | 121 lines; WIP dotted line at lines 59-66; SVG has `overflow: visible` (line 55); old connector line code removed |
| `src/components/CommitRow.svelte` | 6-column layout with connector line div | VERIFIED | 79 lines; 6 columns (lines 45-78); connector line div (lines 37-41); graph column without overflow-hidden (line 50); columnWidths prop (line 11) |
| `src/lib/store.ts` | ColumnWidths interface and LazyStore persistence | VERIFIED | Lines 59-66: ColumnWidths with 5 fields; lines 70-76: DEFAULT_WIDTHS; lines 78-84: get/set async functions |
| `src/components/CommitGraph.svelte` | Header row with resize handles above virtual list | VERIFIED | Lines 163-193: header with 6 columns; lines 38-64: startColumnResize handler; lines 272-285: CSS with linear-gradient for visible dividers |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `graph.rs` line 264 | `types.rs` RefLabel | `r.color_index = color_index` | WIRED | Each ref inherits its commit's lane color during output assembly |
| `repository.rs` lines 44, 55 | `types.rs` RefLabel | `color_index: 0` initialization | WIRED | Both RefLabel construction sites initialize field |
| `RefPill.svelte` line 2 | `types.ts` RefLabel | `import type { RefLabel }` + `ref.color_index % 8` | WIRED | Color index used to select CSS variable for background |
| `CommitRow.svelte` line 37 | commit.refs | `commit.refs.length > 0` gates connector div | WIRED | Connector line renders only for commits with refs, excludes WIP |
| `CommitGraph.svelte` line 6 | `store.ts` | `import { getColumnWidths, setColumnWidths }` | WIRED | Load on mount (line 35), persist on mouseup (line 57) |
| `CommitGraph.svelte` line 230 | `CommitRow.svelte` | `{columnWidths}` prop in renderItem snippet | WIRED | Column widths flow from header state to each row |
| `CommitGraph.svelte` header | `CommitRow` columns | Identical `columnWidths.*` width styles | WIRED | Header lines 167-192 and CommitRow lines 45-78 use same width expressions |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| DIFF-01 | 10-01-PLAN, 10-03-PLAN | User sees branch/tag ref pills colored to match their lane color | SATISFIED | color_index flows end-to-end: Rust graph.rs:264 sets it, types.ts:21 declares it, RefPill.svelte:21 renders `var(--lane-N)` background. Connector line restored in CommitRow.svelte via absolute div (10-03 gap closure). |
| DIFF-02 | 10-02-PLAN, 10-03-PLAN | User can resize the graph column width via drag handle | SATISFIED | 4 resize handles in CommitGraph.svelte header with linear-gradient visibility; startColumnResize drag handler; LazyStore persistence. Column dividers visible at rest (10-03 gap closure). |

**Orphaned Requirements:** The REQUIREMENTS.md traceability table has mapping discrepancies (VIS-01/02/03 mapped to "Phase 10", DIFF-01/02 mapped to "Phase 11"). These are documentation errors only. ROADMAP.md and PLAN frontmatter correctly assign DIFF-01 and DIFF-02 to Phase 10. No actual orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No TODOs, FIXMEs, stubs, placeholders, console.logs, or empty implementations found |

**Pre-existing note:** A type error exists in CommitGraph.svelte line 222 (SvelteVirtualList `align` parameter type mismatch). Confirmed pre-existing from Phase 9 (present in commit `725d898`). Not a Phase 10 regression.

### Test Verification

- **Rust tests:** `cargo test ref_label` -- 2 passed, 0 failed. Tests `ref_label_color_index` (graph.rs:989) and `ref_label_no_refs_no_panic` (graph.rs:1014) both pass.
- **Build:** Phase files compile without new errors (pre-existing type error only).

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

**Test:** Scroll through commits with refs in a multi-branch repository. Check that a horizontal colored line connects from the left edge of the row through the ref pill area to the commit dot in the graph.
**Expected:** Connector line visible for all commits with refs (including column 0). No connector for WIP row.
**Why human:** Cross-column div rendering and alignment with SVG commit dots require visual inspection.

### 4. Column resize interaction and visible dividers

**Test:** Observe column dividers at rest (subtle vertical lines between columns). Drag each resize handle (Branch/Tag, Graph, Author, Date) left and right.
**Expected:** Dividers visible without hovering. On hover, dividers brighten to accent color. Column widths change smoothly during drag. Header and row columns stay aligned. Message column absorbs remaining space.
**Why human:** Drag interaction smoothness, visual alignment, and divider visibility require real-time interaction testing.

### 5. Column width persistence

**Test:** Resize columns, then close and reopen the application.
**Expected:** Column widths are restored to the values set before close.
**Why human:** Requires app restart cycle to verify LazyStore persistence.

### 6. WIP dotted line continuity

**Test:** In a repository with uncommitted changes, check the WIP row's dotted line extends downward to connect to the HEAD commit dot.
**Expected:** Dashed vertical line from WIP circle extends below the WIP row into the HEAD commit row.
**Why human:** Overflow rendering across row boundaries requires visual inspection.

### Gaps Summary

No gaps found. All 9 observable truths verified against actual codebase with line-number evidence. All 9 required artifacts exist, are substantive, and are properly wired. All 7 key links confirmed. Both requirements (DIFF-01, DIFF-02) satisfied. No anti-patterns detected. UAT gap closure (10-03-PLAN) successfully addressed connector line and column divider visibility issues reported during user acceptance testing.

---

_Verified: 2026-03-09T23:59:00Z_
_Verifier: Claude (gsd-verifier)_
