<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronUp from "@lucide/svelte/icons/chevron-up";
import { BODY_CLAMP_LINES, bodyOverflows } from "../lib/commit-body-clamp.js";

interface Props {
	summary: string;
	body: string | null;
	/** Read by the reset below, so selecting another commit re-clamps. */
	oid: string;
}

let { summary, body, oid }: Props = $props();

// A long body used to push the file list past the bottom of the panel, since
// the body, the notes and the file list share one scroller. The body is clamped
// to a fixed number of lines and the reader opens it when they want it.
//
// Expansion belongs to the reading rather than to the commit. Reading the OID
// below subscribes the reset to it, so moving away clamps again, and so does
// coming back to a commit expanded earlier. Remembering it per commit instead
// put the file list back below the fold on a second visit.
let bodyExpanded = $state(false);
$effect(() => {
	oid;
	bodyExpanded = false;
});
let bodyExpandable = $derived(bodyOverflows(body));
let bodyClamped = $derived(bodyExpandable && !bodyExpanded);
</script>

<div style="
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-border);
">
  <div class="select-text" style="
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.4;
    margin-bottom: {body ? 'var(--space-2)' : '0'};
  ">
    {summary}
  </div>
  {#if body}
    <div
      class="select-text commit-body"
      class:clamped={bodyClamped}
      data-testid="commit-body"
      data-clamped={bodyClamped}
      style="--body-clamp-lines: {BODY_CLAMP_LINES};"
    >{body}</div>
    {#if bodyExpandable}
      <button
        type="button"
        class="body-toggle"
        aria-expanded={!bodyClamped}
        onclick={() => {
          bodyExpanded = !bodyExpanded;
        }}
      >
        {#if bodyClamped}
          <ChevronDown size={12} />
        {:else}
          <ChevronUp size={12} />
        {/if}
        <span>{bodyClamped ? 'Show more' : 'Show less'}</span>
      </button>
    {/if}
  {/if}
</div>

<style>
  /* Commit body. Clamped to a line count rather than given its own scrollbar:
     an inline scroll area inside the panel's own scroller is content readers
     skip past, and it would leave the file list just as far down. */
  .commit-body {
    font-size: 12px;
    color: var(--fg-2);
    line-height: 1.6;
    margin-top: var(--space-2);
    /* Bodies arrive hard-wrapped at the author's terminal width, and some carry
       indented code or lists, so the newlines and the leading spaces are both
       content: `pre-wrap` rather than `pre-line`. The cost is that a line longer
       than this pane wraps a second time and leaves a short remainder under it.
       Narrowing the type and opening the leading keeps that remainder rare at
       the widths this panel is actually used at. */
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .commit-body.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: var(--body-clamp-lines);
    line-clamp: var(--body-clamp-lines);
    overflow: hidden;
    /* Fade the cut so the clamp reads as text continuing rather than as a
       paragraph that happens to end mid-sentence. */
    mask-image: linear-gradient(to bottom, #000 calc(100% - 1.6em), transparent);
  }

  .body-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-sm-h);
    margin-top: var(--space-1);
    padding: 0 var(--space-2) 0 var(--space-1);
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: var(--bg-2);
    color: var(--fg-2);
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
  }
  .body-toggle:hover,
  .body-toggle:focus-visible {
    background: var(--bg-3);
    color: var(--fg-0);
  }
</style>
