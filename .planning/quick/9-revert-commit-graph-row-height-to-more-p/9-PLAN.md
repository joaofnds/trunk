---
phase: quick-9
plan: 9
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/graph-constants.ts
  - src/lib/graph-constants.test.ts
  - src/lib/overlay-paths.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "Commit graph rows are more compact (26px height, not 36px)"
    - "Lane width remains 16px (unchanged)"
    - "Commit dots are 2px larger (radius 8, not 6)"
    - "All tests pass with updated constant values"
  artifacts:
    - path: "src/lib/graph-constants.ts"
      provides: "ROW_HEIGHT=26, LANE_WIDTH=16 (unchanged), DOT_RADIUS=8"
    - path: "src/lib/graph-constants.test.ts"
      provides: "Tests asserting updated constant values"
    - path: "src/lib/overlay-paths.test.ts"
      provides: "Mirror constants updated to ROW=26, DOT_R=8"
  key_links:
    - from: "src/lib/graph-constants.ts"
      to: "src/components/CommitGraph.svelte"
      via: "import { ROW_HEIGHT, DOT_RADIUS }"
      pattern: "ROW_HEIGHT|DOT_RADIUS"
    - from: "src/lib/graph-constants.ts"
      to: "src/lib/overlay-paths.ts"
      via: "import { ROW_HEIGHT, DOT_RADIUS }"
      pattern: "ROW_HEIGHT|DOT_RADIUS"
---

<objective>
Revert commit graph row height from 36px back to the original 26px packed style, keep LANE_WIDTH at 16px, and increase DOT_RADIUS from 6 to 8 (up 2px).

Purpose: Restore the denser, more compact commit history layout while retaining the wider lanes from the v0.5 overlay work and making commit dots slightly larger.
Output: Updated constants + test values.
</objective>

<execution_context>
@/Users/joaofnds/.config/Claude/get-shit-done/workflows/execute-plan.md
@/Users/joaofnds/.config/Claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

<!-- Key constants file (the single source of truth) -->
<!-- src/lib/graph-constants.ts current values:
  LANE_WIDTH = 16   ← keep
  ROW_HEIGHT = 36   ← revert to 26
  DOT_RADIUS = 6    ← increase to 8
-->

<!-- overlay-paths.test.ts mirrors constants with hardcoded locals:
  const LANE = 16;   ← keep
  const ROW  = 36;   ← update to 26
  const DOT_R = 6;   ← update to 8
  (these drive all path assertion math; they must match graph-constants.ts)
-->
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Update constants and fix all tests</name>
  <files>src/lib/graph-constants.ts, src/lib/graph-constants.test.ts, src/lib/overlay-paths.test.ts</files>
  <behavior>
    - LANE_WIDTH remains 16 (no change)
    - ROW_HEIGHT changes from 36 → 26
    - DOT_RADIUS changes from 6 → 8
    - graph-constants.test.ts assertions reflect new values
    - overlay-paths.test.ts mirror locals reflect new values (ROW=26, DOT_R=8)
  </behavior>
  <action>
    1. In `src/lib/graph-constants.ts`:
       - Change `ROW_HEIGHT = 36` → `ROW_HEIGHT = 26`
       - Change `DOT_RADIUS = 6` → `DOT_RADIUS = 8`
       - Leave `LANE_WIDTH = 16` untouched

    2. In `src/lib/graph-constants.test.ts`:
       - Update assertion: `it('ROW_HEIGHT is 36', ...)` → `it('ROW_HEIGHT is 26', () => expect(ROW_HEIGHT).toBe(26))`
       - Update assertion: `it('DOT_RADIUS is 6', ...)` → `it('DOT_RADIUS is 8', () => expect(DOT_RADIUS).toBe(8))`

    3. In `src/lib/overlay-paths.test.ts`:
       - Update `const ROW = 36;` → `const ROW = 26;`
       - Update `const DOT_R = 6;` → `const DOT_R = 8;`
       (These locals are used in all path math assertions — they will automatically
        recalculate correct expected values; no individual assertion strings need
        manual editing since they use the locals arithmetically)

    No changes needed to:
    - `src/lib/overlay-paths.ts` (uses ROW_HEIGHT/DOT_RADIUS from import — automatically updated)
    - `src/components/CommitGraph.svelte` (uses DOT_RADIUS from import — automatically updated)
    - `src/components/CommitRow.svelte` (uses ROW_HEIGHT from import — automatically updated)
    - `src/lib/ref-pill-data.test.ts` (uses ROW_HEIGHT constant directly — automatically updated)
  </action>
  <verify>
    <automated>cd /Users/joaofnds/code/trunk && npx vitest run src/lib/graph-constants.test.ts src/lib/overlay-paths.test.ts src/lib/ref-pill-data.test.ts</automated>
  </verify>
  <done>
    All three test files pass. ROW_HEIGHT=26, LANE_WIDTH=16, DOT_RADIUS=8 in graph-constants.ts.
  </done>
</task>

</tasks>

<verification>
Run full test suite to confirm no regressions:

```bash
cd /Users/joaofnds/code/trunk && npx vitest run
```

All tests pass. Visual result: rows are tighter (26px), dots are bigger (r=8), lanes unchanged (16px wide).
</verification>

<success_criteria>
- `ROW_HEIGHT = 26` in graph-constants.ts
- `LANE_WIDTH = 16` in graph-constants.ts (unchanged)
- `DOT_RADIUS = 8` in graph-constants.ts
- `npx vitest run` exits 0
</success_criteria>

<output>
After completion, create `.planning/quick/9-revert-commit-graph-row-height-to-more-p/9-SUMMARY.md`
</output>
