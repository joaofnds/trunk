<script lang="ts">
import Code2 from "@lucide/svelte/icons/code-2";
import Columns2 from "@lucide/svelte/icons/columns-2";
import Eye from "@lucide/svelte/icons/eye";
import FoldVertical from "@lucide/svelte/icons/fold-vertical";
import Pilcrow from "@lucide/svelte/icons/pilcrow";
import Rows2 from "@lucide/svelte/icons/rows-2";
import Space from "@lucide/svelte/icons/space";
import TextWrap from "@lucide/svelte/icons/text-wrap";
import UnfoldVertical from "@lucide/svelte/icons/unfold-vertical";
import { onMount } from "svelte";
import { isMarkdownPath } from "../../lib/markdown.js";
import { DIFF_ROW_FONT, measureRowMetrics } from "../../lib/row-metrics.js";
import type { ContentMode, LayoutMode, RenderMode } from "../../lib/types.js";

interface Props {
	contentMode: ContentMode;
	layoutMode: LayoutMode;
	renderMode: RenderMode;
	oncontentmodechange: (mode: ContentMode) => void;
	onlayoutmodechange: (mode: LayoutMode) => void;
	onrendermodechange: (mode: RenderMode) => void;
	selectedPath: string | null;
	diffKind: "unstaged" | "staged" | "commit";
	hunkOperationInFlight: boolean;
	ignoreWhitespace: boolean;
	showInvisibles: boolean;
	wordWrap: boolean;
	showInlineComments?: boolean;
	onignorewhitespacechange: (value: boolean) => void;
	onshowinvisibleschange: (value: boolean) => void;
	onwordwrapchange: (value: boolean) => void;
	onstagefile: () => void;
	onunstagefile: () => void;
	ondiscardfile: () => void;
	oncommentfile: () => void;
	onclose: () => void;
}

let {
	contentMode,
	layoutMode,
	renderMode,
	oncontentmodechange,
	onlayoutmodechange,
	onrendermodechange,
	selectedPath,
	diffKind,
	hunkOperationInFlight,
	ignoreWhitespace,
	showInvisibles,
	wordWrap,
	showInlineComments = true,
	onignorewhitespacechange,
	onshowinvisibleschange,
	onwordwrapchange,
	onstagefile,
	onunstagefile,
	ondiscardfile,
	oncommentfile,
	onclose,
}: Props = $props();

// Rendered prose collapses whitespace by nature, so the invisibles toggle
// cannot mean anything while the preview is the active view (renderMode only
// takes effect for markdown files — DiffViewer's routing gate).
// Wrapped-row heights are derived from a column count, which only describes the
// layout when every glyph advances the same width. A toggle that reads as on
// while its effect is off is a lie the UI tells, so the toggle goes away
// instead (P-8).
let fontProbe = $state<HTMLSpanElement | null>(null);
let fixedPitch = $state(true);

onMount(() => {
	if (fontProbe) fixedPitch = measureRowMetrics(fontProbe).monospace;
});

const renderedActive = $derived(
	renderMode === "rendered" &&
		selectedPath !== null &&
		isMarkdownPath(selectedPath),
);
</script>

<div class="toolbar">
  <span class="filename">
    {#if selectedPath}{selectedPath}{/if}
  </span>

  {#if selectedPath && isMarkdownPath(selectedPath)}
    <button
      class="toggle-btn"
      class:active={renderMode === "rendered"}
      title={renderMode === "source" ? "Show rendered markdown" : "Show source"}
      onclick={() => onrendermodechange(renderMode === "source" ? "rendered" : "source")}
    >
      {#if renderMode === "source"}
        <Eye size={14} />
      {:else}
        <Code2 size={14} />
      {/if}
    </button>
  {/if}

  <button
    class="toggle-btn"
    title={contentMode === "hunk" ? "Show full file" : "Show hunks"}
    onclick={() => oncontentmodechange(contentMode === "hunk" ? "full" : "hunk")}
  >
    {#if contentMode === "hunk"}
      <UnfoldVertical size={14} />
    {:else}
      <FoldVertical size={14} />
    {/if}
  </button>

  <button
    class="toggle-btn"
    title={layoutMode === "inline" ? "Side-by-side view" : "Inline view"}
    onclick={() => onlayoutmodechange(layoutMode === "inline" ? "split" : "inline")}
  >
    {#if layoutMode === "inline"}
      <Columns2 size={14} />
    {:else}
      <Rows2 size={14} />
    {/if}
  </button>

  <button
    class="toggle-btn"
    class:active={ignoreWhitespace}
    title="Ignore whitespace changes"
    onclick={() => onignorewhitespacechange(!ignoreWhitespace)}
  >
    <Space size={14} />
  </button>
  <button
    class="toggle-btn"
    class:active={showInvisibles}
    disabled={renderedActive}
    title={renderedActive
      ? "Invisible characters aren't rendered in preview"
      : "Show invisible characters"}
    onclick={() => onshowinvisibleschange(!showInvisibles)}
  >
    <Pilcrow size={14} />
  </button>
  <button
    class="toggle-btn"
    class:active={wordWrap}
    disabled={!fixedPitch}
    title={fixedPitch
      ? "Toggle word wrap"
      : "Word wrap needs a fixed-pitch diff font"}
    onclick={() => onwordwrapchange(!wordWrap)}
  >
    <TextWrap size={14} />
  </button>
  <span class="font-probe" bind:this={fontProbe} style="{DIFF_ROW_FONT};"></span>

  <!-- One-click whole-file Comment (260531-l02e/l02f): comments every change in the
       file in one click. Available for every diff kind — commit diffs as well as the
       dirty tree (selectedPath is always set when this toolbar renders). Gated on
       review mode (showInlineComments) like the hunk toolbar's Comment buttons, so a
       clean read-only diff shows no comment affordances; never gated on
       whitespace-ignore since it never stages. -->
  {#if showInlineComments}
  <button
    class="action-btn comment-btn"
    onclick={oncommentfile}
  >
    Comment File
  </button>
  {/if}

  {#if diffKind === 'unstaged'}
    <button
      class="action-btn discard-btn"
      disabled={hunkOperationInFlight}
      style="
        cursor: {hunkOperationInFlight ? 'not-allowed' : 'pointer'};
        opacity: {hunkOperationInFlight ? 0.4 : 1};
      "
      onclick={ondiscardfile}
    >
      Discard File
    </button>
    <button
      class="action-btn stage-btn"
      disabled={hunkOperationInFlight || ignoreWhitespace}
      title={ignoreWhitespace ? "Staging is disabled while whitespace changes are ignored" : undefined}
      style="
        cursor: {(hunkOperationInFlight || ignoreWhitespace) ? 'not-allowed' : 'pointer'};
        opacity: {(hunkOperationInFlight || ignoreWhitespace) ? 0.4 : 1};
      "
      onclick={onstagefile}
    >
      Stage File
    </button>
  {:else if diffKind === 'staged'}
    <button
      class="action-btn unstage-btn"
      disabled={hunkOperationInFlight || ignoreWhitespace}
      title={ignoreWhitespace ? "Staging is disabled while whitespace changes are ignored" : undefined}
      style="
        cursor: {(hunkOperationInFlight || ignoreWhitespace) ? 'not-allowed' : 'pointer'};
        opacity: {(hunkOperationInFlight || ignoreWhitespace) ? 0.4 : 1};
      "
      onclick={onunstagefile}
    >
      Unstage File
    </button>
  {/if}

  <button
    onclick={onclose}
    aria-label="Close diff"
    class="close-btn"
  >&#x2715;</button>
</div>

<style>
  .font-probe {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
  }

  .toolbar {
    height: var(--bar-h);
    box-shadow: inset 0 -1px 0 var(--color-border);
    padding: 0 var(--space-2);
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: var(--space-1);
  }

  .filename {
    flex: 1;
    font-size: 11px;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius);
    font-size: 11px;
    font-family: var(--font-sans, sans-serif);
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .stage-btn {
    background: var(--color-success-bg);
    border: 1px solid var(--color-success-border);
    color: var(--color-success);
  }

  .discard-btn {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
  }

  .comment-btn {
    background: var(--color-accent-bg, var(--color-surface));
    border: 1px solid var(--color-accent-border);
    color: var(--color-accent);
    cursor: pointer;
  }

  .unstage-btn {
    background: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    color: var(--color-warning);
  }

  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 16px;
    line-height: 1;
    padding: var(--space-1);
    border-radius: var(--radius);
    flex-shrink: 0;
  }

  .toggle-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--color-text-muted);
    padding: var(--space-1);
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .toggle-btn.active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-border);
  }

  .toggle-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
