<script lang="ts">
// The changed-first fuzzy file finder (D11, plan §3). It is how a user reaches a
// file no pending change touches, which is the entry point Trunk has never had.
//
// The source list is the backend's tracked-file enumeration, so untracked and
// ignored files cannot appear here at all. The finder never reads the filesystem
// itself; picking a row reports the path and the host opens it.

import { rankFiles } from "../lib/file-finder.js";
import type { ReviewTone, TrackedFile } from "../lib/types.js";

interface Props {
	files: TrackedFile[];
	// How many current-file comments each path already carries, so a user sees
	// where the discussion already is before opening anything.
	commentCounts?: Map<string, number>;
	commentTones?: Map<string, ReviewTone>;
	onselect: (path: string) => void;
	onclose: () => void;
}

let {
	files,
	commentCounts = new Map<string, number>(),
	commentTones = new Map<string, ReviewTone>(),
	onselect,
	onclose,
}: Props = $props();

let query = $state("");
let selectedIndex = $state(0);

const matches = $derived(rankFiles(files, query));

function handleInput(e: Event) {
	query = (e.currentTarget as HTMLInputElement).value;
	// A narrowed list makes the old index meaningless, and the top row is the
	// one the new query ranked best.
	selectedIndex = 0;
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		onclose();
	} else if (e.key === "ArrowDown") {
		e.preventDefault();
		selectedIndex = Math.min(selectedIndex + 1, matches.length - 1);
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		selectedIndex = Math.max(selectedIndex - 1, 0);
	} else if (e.key === "Enter") {
		e.preventDefault();
		const chosen = matches[selectedIndex];
		if (chosen) onselect(chosen.path);
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}

function rowLabel(file: TrackedFile): string {
	const parts = [file.path];
	if (file.changed) parts.push("changed");

	const count = commentCounts.get(file.path) ?? 0;
	if (count > 0) parts.push(`${count} comment${count === 1 ? "" : "s"}`);

	return parts.join(", ");
}
</script>

<div
  class="fixed inset-0 flex flex-col items-center"
  style="z-index: 9999; background: var(--color-backdrop);"
>
  <!-- The palette sits a little above centre, where the eye already is. The
       spacer takes that share of the free height so the box needs no offset of
       its own, which is what keeps this a flex layout rather than a padding
       hack. -->
  <div style="flex: 1 1 0;" aria-hidden="true"></div>
  <button
    type="button"
    class="fixed inset-0"
    aria-label="Close the file finder"
    tabindex="-1"
    onclick={onclose}
    style="background: transparent; border: none; cursor: default;"
  ></button>
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Comment on a file"
    class="flex flex-col rounded"
    style="
      background: var(--bg-2);
      border: 1px solid var(--line);
      box-shadow: var(--shadow-2);
      width: 520px;
      max-height: 60vh;
      overflow: hidden;
      position: relative;
      flex: 0 1 auto;
    "
  >
    <input
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="file-finder-list"
      aria-label="Find a tracked file to comment on"
      placeholder="Comment on a file…"
      value={query}
      oninput={handleInput}
      onkeydown={handleKeydown}
      use:autofocus
      style="
        background: var(--color-bg);
        border: none;
        border-bottom: 1px solid var(--color-border);
        color: var(--color-text);
        padding: var(--space-3);
        font-size: 13px;
        outline: none;
      "
    />

    <ul
      id="file-finder-list"
      role="listbox"
      aria-label="Tracked files"
      style="flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 0; list-style: none;"
    >
      {#each matches as file, i (file.path)}
        <li role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={i === selectedIndex}
            aria-label={rowLabel(file)}
            class="flex items-center w-full"
            onclick={() => onselect(file.path)}
            style="
              gap: var(--space-2);
              padding: var(--space-2) var(--space-3);
              font-size: 12px;
              cursor: pointer;
              text-align: left;
              border: none;
              color: var(--color-text);
              background: {i === selectedIndex ? 'var(--color-selected-row)' : 'transparent'};
            "
          >
            {#if file.changed}
              <span
              aria-hidden="true"
              style="
                width: 6px;
                height: 6px;
                border-radius: 50%;
                flex-shrink: 0;
                background: var(--color-accent);
              "
              ></span>
            {:else}
              <span aria-hidden="true" style="width: 6px; flex-shrink: 0;"></span>
            {/if}
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              {file.path}
            </span>
            {#if (commentCounts.get(file.path) ?? 0) > 0}
              <span
                class="finder-comment-count"
                aria-label="{commentCounts.get(file.path)} {commentTones.get(file.path) ?? 'open'} review comments"
                style="
                  margin-left: auto;
                  flex-shrink: 0;
                  padding: 0 var(--space-1);
                  border-radius: var(--radius);
                  background: var(--color-thread-{commentTones.get(file.path) ?? 'open'});
                  color: var(--accent-fg);
                  font-size: 11px;
                "
              >{commentCounts.get(file.path)}</span>
            {/if}
          </button>
        </li>
      {/each}

      {#if matches.length === 0}
        <li role="presentation" style="padding: var(--space-3); font-size: 12px; color: var(--color-text-muted);">
          No tracked file matches
        </li>
      {/if}
    </ul>
  </div>
  <div style="flex: 3 1 0;" aria-hidden="true"></div>
</div>
