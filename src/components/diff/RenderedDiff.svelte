<script lang="ts">
import { externalLinks } from "../../lib/external-links.js";
import {
	afterRev,
	beforeRev,
	hunkMarkdown,
	type RevSpec,
	renderMarkdown,
	renderMarkdownText,
} from "../../lib/markdown.js";
import type { CommitDetail, ContentMode, FileDiff } from "../../lib/types.js";

// Rendered markdown view of a `.md` diff.
//   • full mode → renders the whole document at each side's rev.
//   • hunk mode → renders ONLY the changed hunks' markdown (context + added
//     lines for the "after" side, context + deleted for "before"), so the
//     preview scopes to what changed, matching the hunk/full toggle.
// `inline` renders the "after" side; `split` renders before (HEAD/parent) and
// after side-by-side (grill §2 rev fidelity). Each column renders independently:
// a side absent at its rev (added → no before, deleted → no after) shows a muted
// placeholder — it must NOT abort the other column. V1 has no prose-level change
// highlighting.
interface Props {
	layoutMode: "inline" | "split";
	contentMode: ContentMode;
	selectedPath: string;
	diffKind: "unstaged" | "staged" | "commit";
	commitOid: string;
	repoPath: string;
	commitDetail: CommitDetail | null;
	fileDiffs: FileDiff[];
}

let {
	layoutMode,
	contentMode,
	selectedPath,
	diffKind,
	commitOid,
	repoPath,
	commitDetail,
	fileDiffs,
}: Props = $props();

type SideState =
	| { kind: "loading" }
	| { kind: "html"; html: string }
	| { kind: "absent" }
	| { kind: "error"; message: string };

let after = $state<SideState>({ kind: "loading" });
let before = $state<SideState>({ kind: "loading" });

// Per-run token: each effect run bumps it, and a render's async result is only
// applied if its run is still the latest. Without this, toggling hunk↔full while
// a render is in flight lets the slower stale request clobber the fresh one.
let seq = 0;

const parentOid = $derived(commitDetail?.parent_oids[0] ?? null);

function renderSide(
	repo: string,
	path: string,
	rev: RevSpec,
	side: "before" | "after",
	fd: FileDiff | undefined,
	hunkScoped: boolean,
): Promise<string> {
	if (hunkScoped && fd) {
		return renderMarkdownText(repo, path, rev, hunkMarkdown(fd, side));
	}
	return renderMarkdown(repo, path, rev);
}

function loadSide(promise: Promise<string>, set: (s: SideState) => void) {
	set({ kind: "loading" });
	promise
		.then((html) => set({ kind: "html", html }))
		.catch((e) => {
			// A file absent at this rev (added/deleted, whole-file mode) is expected.
			const code = (e as { code?: string })?.code;
			if (code === "not_found") {
				set({ kind: "absent" });
			} else {
				set({
					kind: "error",
					message:
						(e as { message?: string })?.message ?? "Failed to render markdown",
				});
			}
		});
}

$effect(() => {
	// Snapshot every dependency up front so the async resolves aren't racing a
	// later reactive change.
	const my = ++seq;
	const repo = repoPath;
	const path = selectedPath;
	const kind = diffKind;
	const oid = commitOid;
	const parent = parentOid;
	const split = layoutMode === "split";
	const hunkScoped = contentMode === "hunk";
	const fd = fileDiffs.find((f) => f.path === path);

	loadSide(
		renderSide(repo, path, afterRev(kind, oid), "after", fd, hunkScoped),
		(s) => {
			if (my === seq) after = s;
		},
	);
	if (split) {
		loadSide(
			renderSide(repo, path, beforeRev(kind, parent), "before", fd, hunkScoped),
			(s) => {
				if (my === seq) before = s;
			},
		);
	}
});
</script>

{#snippet column(side: SideState)}
  {#if side.kind === "html"}
    <div class="rendered-col markdown-body" use:externalLinks>{@html side.html}</div>
  {:else if side.kind === "absent"}
    <div class="rendered-col rendered-note">Not present at this revision</div>
  {:else if side.kind === "error"}
    <div class="rendered-col rendered-error">{side.message}</div>
  {:else}
    <div class="rendered-col"></div>
  {/if}
{/snippet}

<div class="rendered-diff" class:split={layoutMode === "split"}>
  {#if layoutMode === "split"}
    {@render column(before)}
    {@render column(after)}
  {:else}
    {@render column(after)}
  {/if}
</div>

<style>
  .rendered-diff {
    height: 100%;
    overflow: auto;
    box-sizing: border-box;
  }
  .rendered-diff.split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--color-border);
    overflow: hidden;
  }
  .rendered-col {
    padding: 16px 20px;
    overflow: auto;
    background: var(--bg-0);
    min-width: 0;
  }
  .rendered-diff:not(.split) .rendered-col {
    height: 100%;
  }
  .rendered-note {
    color: var(--color-text-muted);
    font-size: 13px;
    font-style: italic;
  }
  .rendered-error {
    color: var(--color-danger);
    font-size: 13px;
  }
</style>
