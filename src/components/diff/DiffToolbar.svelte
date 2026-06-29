<script lang="ts">
import {
	Columns2,
	FoldVertical,
	Pilcrow,
	Rows2,
	Space,
	TextWrap,
	UnfoldVertical,
} from "@lucide/svelte";
import type { ContentMode, LayoutMode } from "../../lib/types.js";

interface Props {
	contentMode: ContentMode;
	layoutMode: LayoutMode;
	oncontentmodechange: (mode: ContentMode) => void;
	onlayoutmodechange: (mode: LayoutMode) => void;
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
	oncontentmodechange,
	onlayoutmodechange,
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
</script>

<div class="toolbar">
  <span class="filename">
    {#if selectedPath}{selectedPath}{/if}
  </span>

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
    title="Show invisible characters"
    onclick={() => onshowinvisibleschange(!showInvisibles)}
  >
    <Pilcrow size={14} />
  </button>
  <button
    class="toggle-btn"
    class:active={wordWrap}
    title="Toggle word wrap"
    onclick={() => onwordwrapchange(!wordWrap)}
  >
    <TextWrap size={14} />
  </button>

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
  .toolbar {
    height: 32px;
    border-bottom: 1px solid var(--color-border);
    padding: 0 8px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: 4px;
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
    border-radius: 3px;
    font-size: 11px;
    font-family: var(--font-sans, sans-serif);
    padding: 2px 8px;
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
    padding: 2px 4px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .toggle-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--color-text-muted);
    padding: 2px 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .toggle-btn.active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-border);
  }
</style>
