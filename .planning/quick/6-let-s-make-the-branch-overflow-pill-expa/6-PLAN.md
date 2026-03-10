---
phase: quick
plan: 6
type: execute
wave: 1
depends_on: []
files_modified:
  - src/components/CommitRow.svelte
autonomous: true
requirements: []

must_haves:
  truths:
    - "When a commit has multiple refs, only the first pill and a +N overflow pill are visible by default"
    - "Hovering the ref column expands to show all ref pills"
    - "The expanded pills overlay adjacent columns without shifting layout"
    - "Mouse leaving the ref column collapses back to the first pill + +N"
  artifacts:
    - path: "src/components/CommitRow.svelte"
      provides: "Hover-expand overflow pill in ref column"
  key_links:
    - from: "hover state (refHovered)"
      to: "expanded pill rendering block"
      via: "$derived or conditional in template"
---

<objective>
Make the branch overflow pill (+N) expand on hover to reveal all hidden ref pills.

Purpose: Users can see all branches/tags on a commit without needing to open a detail panel.
Output: CommitRow.svelte updated — ref column shows all pills in an overlay on hover.
</objective>

<execution_context>
@/Users/joaofnds/.claude/get-shit-done/workflows/execute-plan.md
@/Users/joaofnds/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/components/CommitRow.svelte
@src/components/RefPill.svelte
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add hover-expand behavior to the ref column overflow pill</name>
  <files>src/components/CommitRow.svelte</files>
  <action>
    In CommitRow.svelte, modify the ref column (lines 55-68) to support hover-expand:

    1. Add a `let refHovered = $state(false)` reactive variable.

    2. On the ref column outer div (currently `class="relative z-[1] flex items-center overflow-hidden flex-shrink-0 pl-1 pr-1"`):
       - Add `onmouseenter={() => refHovered = true}` and `onmouseleave={() => refHovered = false}`
       - Keep `overflow-hidden` when NOT hovered (clips to column width as before)
       - When hovered, switch to `overflow-visible` so the expanded pills float over adjacent content

    3. Inside the ref column, render two states:

       **Default (not hovered or only 1 ref):**
       - Show `<RefPill refs={commit.refs} />` (first pill only — unchanged)
       - Show `+N` overflow pill when `commit.refs.length > 1` (unchanged)

       **Expanded (hovered AND refs.length > 1):**
       - Replace the default content with an absolute-positioned container (`position: absolute; left: 4px; top: 50%; transform: translateY(-50%); z-index: 50; display: flex; gap: 2px; background: var(--color-surface); border-radius: 999px; padding: 1px 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.4)`)
       - Inside it, render ALL refs using the same pill markup from RefPill.svelte (inline — or pass `refs={commit.refs}` to a modified RefPill that accepts an optional `all` flag)
       - Easiest approach: inline the pill rendering loop directly in the expanded block using the same `pillClasses`/`pillStyle` logic already present in RefPill (copy the inline style approach or import a helper)

    The cleanest implementation: modify `RefPill.svelte` to accept a `showAll?: boolean` prop.
    - When `showAll` is false (default): renders only `refs[0]` (current behavior)
    - When `showAll` is true: renders all refs in a flex row with `gap-1`

    Then in CommitRow:
    ```svelte
    <div
      class="relative z-[1] flex items-center flex-shrink-0 pl-1 pr-1 {refHovered ? 'overflow-visible' : 'overflow-hidden'}"
      style="width: {columnWidths.ref}px;"
      onmouseenter={() => refHovered = true}
      onmouseleave={() => refHovered = false}
    >
      {#if refHovered && commit.refs.length > 1}
        <!-- Expanded overlay: all pills in a floating pill-shaped container -->
        <div
          class="absolute left-1 top-1/2 -translate-y-1/2 z-50 flex items-center gap-1 rounded-full px-2 py-0.5 shadow-lg"
          style="background: var(--color-surface-elevated, var(--color-surface)); border: 1px solid rgba(255,255,255,0.08);"
        >
          <RefPill refs={commit.refs} showAll={true} />
        </div>
      {:else}
        <!-- Default: first pill + overflow count -->
        <div class="flex items-center" bind:clientWidth={refContainerWidth}>
          <RefPill refs={commit.refs} />
        </div>
        {#if commit.refs.length > 1}
          <span
            class="relative z-[1] inline-flex items-center rounded-full px-1 text-[10px] leading-4 whitespace-nowrap font-medium ml-1 cursor-default"
            style="background: var(--lane-{commit.refs[0].color_index % 8}); color: white; filter: brightness(0.75);"
            title={commit.refs.slice(1).map((r) => r.short_name).join(', ')}
          >
            +{commit.refs.length - 1}
          </span>
        {/if}
      {/if}
    </div>
    ```

    In RefPill.svelte, add `showAll?: boolean = false` prop and when true render `{#each refs as ref}` instead of just `refs[0]`. Keep `max-w-[100px] truncate` on each pill but remove it when `showAll` is true (pills should show full name on expand).

    Also in RefPill when `showAll=true`, wrap pills in a `flex gap-1 items-center` container.

    The connector line left offset uses `refContainerWidth` — keep `bind:clientWidth={refContainerWidth}` on the default (non-hovered) state only so connector line positioning is unaffected during hover.
  </action>
  <verify>
    <automated>cd /Users/joaofnds/code/trunk && npm run check 2>&1 | tail -20</automated>
  </verify>
  <done>
    Hovering a commit row with multiple refs shows an expanded floating container with all ref pills. Mouse-out collapses back to first pill + +N. Commits with a single ref are unaffected. Type-check passes.
  </done>
</task>

</tasks>

<verification>
- `npm run check` passes with no type errors
- Commits with 1 ref: no change in appearance
- Commits with 2+ refs: +N pill visible at rest, all pills shown on hover in a floating overlay
- Layout of other columns is not shifted by the overlay (overflow-visible + absolute positioning)
- Connector line left offset unchanged (refContainerWidth still bound in default state)
</verification>

<success_criteria>
Hovering the ref column on any multi-ref commit reveals all hidden branch/tag pills in an overlay. Mouse-out restores the collapsed view. No layout shifts or regressions in surrounding columns.
</success_criteria>

<output>
After completion, create `.planning/quick/6-let-s-make-the-branch-overflow-pill-expa/6-SUMMARY.md`
</output>
