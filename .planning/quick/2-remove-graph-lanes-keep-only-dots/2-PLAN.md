---
phase: quick
plan: 2
type: execute
wave: 1
depends_on: []
files_modified:
  - src/components/LaneSvg.svelte
  - src/components/CommitGraph.svelte
autonomous: true
requirements: [QUICK-2]
must_haves:
  truths:
    - "Commit dots still render at the correct column position for each row"
    - "No SVG lines or curves (edges) appear between commits"
    - "WIP row shows only the hollow circle dot, no connecting line"
    - "The graph column still scrolls and displays correctly"
  artifacts:
    - path: "src/components/LaneSvg.svelte"
      provides: "Commit dot only, no edge rendering"
    - path: "src/components/CommitGraph.svelte"
      provides: "WIP row with dot only, no connecting line"
  key_links:
    - from: "src/components/LaneSvg.svelte"
      to: "GraphCommit.column"
      via: "commit.column used for dot cx position"
      pattern: "cx.*commit\\.column"
---

<objective>
Remove all graph lane edge rendering (Straight lines, ForkLeft/ForkRight/MergeLeft/MergeRight Bezier curves) from the commit graph SVG, keeping only the commit dots. The backend Rust code and type definitions are left untouched — edges will still be computed and sent over IPC, they just won't be rendered. This is a teardown step; lanes will be rewritten from scratch later.

Purpose: Clean slate for lane rendering rewrite without breaking commit dot display.
Output: LaneSvg renders dots only; CommitGraph WIP row renders dot only.
</objective>

<execution_context>
@/Users/joaofnds/.claude/get-shit-done/workflows/execute-plan.md
@/Users/joaofnds/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/components/LaneSvg.svelte
@src/components/CommitGraph.svelte
@src/components/CommitRow.svelte
@src/lib/types.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Strip edge rendering from LaneSvg and WIP row</name>
  <files>src/components/LaneSvg.svelte, src/components/CommitGraph.svelte</files>
  <action>
In `src/components/LaneSvg.svelte`:

1. Remove the entire `{#each commit.edges as edge}` block (the comment "Edges drawn first, below the commit dot" through the closing `{/each}`) — this removes all Straight `<line>` elements and ForkLeft/ForkRight/MergeLeft/MergeRight `<path>` Bezier curves.

2. Simplify the `maxCol` derived value. It currently computes max across `commit.column` AND all edge columns. Since edges are no longer rendered, change it to just use `commit.column`:
   ```
   const svgWidth = $derived((commit.column + 1) * laneWidth);
   ```
   Remove the `maxCol` derived entirely since it is no longer needed.

3. Keep the `<circle>` element (commit dot) exactly as-is — it uses `cx(commit.column)`, `cy`, `r` (merge vs normal), `fill`, and `stroke`. Do not change any dot styling.

4. Keep all `<script>` imports, Props interface, `cx()` helper, `cy` constant, and `laneColor()` helper — they are still used by the dot.

In `src/components/CommitGraph.svelte`:

5. In the WIP row SVG (around line 108-111), remove the `<line>` element that draws a vertical line from the WIP dot down to the first commit row:
   ```svelte
   <!-- REMOVE THIS LINE: -->
   <line x1="9" y1="13" x2="9" y2="26" stroke="var(--lane-0)" stroke-width="2" />
   ```
   Keep the `<circle>` element (hollow WIP dot) exactly as-is.
  </action>
  <verify>
    <automated>cd /Users/joaofnds/code/trunk && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5</automated>
  </verify>
  <done>
    - LaneSvg.svelte contains zero `<line>` or `<path>` elements — only `<circle>`
    - CommitGraph.svelte WIP SVG contains zero `<line>` elements — only `<circle>`
    - `svelte-check` passes with no type errors
    - The `edges` property on GraphCommit type and all Rust code remain unchanged
  </done>
</task>

</tasks>

<verification>
1. `npx svelte-check --tsconfig ./tsconfig.json` — no type errors
2. `grep -c '<line\|<path' src/components/LaneSvg.svelte` — returns 0
3. `grep -c '<line' src/components/CommitGraph.svelte` — returns 0
4. `grep -c '<circle' src/components/LaneSvg.svelte` — returns 1 (commit dot preserved)
5. `grep -c '<circle' src/components/CommitGraph.svelte` — returns 1 (WIP dot preserved)
</verification>

<success_criteria>
- No SVG edge rendering (lines or curves) in LaneSvg.svelte or CommitGraph.svelte WIP row
- Commit dots still render with correct column position, size, and color
- WIP hollow circle dot still renders
- TypeScript/Svelte type checking passes
- Backend Rust code untouched
</success_criteria>

<output>
After completion, create `.planning/quick/2-remove-graph-lanes-keep-only-dots/2-SUMMARY.md`
</output>
