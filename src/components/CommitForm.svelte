<script lang="ts">
import { untrack } from "svelte";
import { safeInvoke } from "../lib/invoke.js";
import { showToast } from "../lib/toast.svelte.js";
import type { HeadCommitMessage } from "../lib/types.js";

interface Props {
	repoPath: string;
	stagedCount: number;
	initialSubject?: string;
	initialBody?: string;
	onsubjectchange?: (value: string) => void;
	onbodychange?: (value: string) => void;
	clearRedoStack: () => void;
}

let {
	repoPath,
	stagedCount,
	initialSubject,
	initialBody,
	onsubjectchange,
	onbodychange,
	clearRedoStack,
}: Props = $props();

let draftSubject = $state(untrack(() => initialSubject) ?? "");
let draftBody = $state(untrack(() => initialBody) ?? "");
let amendSubject = $state("");
let amendBody = $state("");
let mode = $state<"commit" | "amend" | "stash">("commit");
let committing = $state(false);
let subjectError = $state("");
let stagedError = $state("");

function getSubject() {
	return mode === "amend" ? amendSubject : draftSubject;
}

function setSubject(value: string) {
	if (subjectError) subjectError = "";
	if (mode === "amend") {
		amendSubject = value;
	} else {
		draftSubject = value;
		onsubjectchange?.(value);
	}
}

function getBody() {
	return mode === "amend" ? amendBody : draftBody;
}

function setBody(value: string) {
	if (mode === "amend") {
		amendBody = value;
	} else {
		draftBody = value;
		onbodychange?.(value);
	}
}

function clearDraft() {
	draftSubject = "";
	onsubjectchange?.("");
	draftBody = "";
	onbodychange?.("");
}

let counterVisible = $derived(getSubject().length >= 60);
let subjectOverLimit = $derived(getSubject().length > 72);

let buttonLabel = $derived.by(() => {
	if (committing) {
		return mode === "commit"
			? "Committing..."
			: mode === "amend"
				? "Amending..."
				: "Stashing...";
	}
	return mode === "commit" ? "Commit" : mode === "amend" ? "Amend" : "Stash";
});

// Clear stagedError when stagedCount changes or mode changes
$effect(() => {
	// access reactive values to track them
	const _staged = stagedCount;
	const _mode = mode;
	stagedError = "";
});

async function handleModeSwitch(newMode: "commit" | "amend" | "stash") {
	if (newMode === mode) return;
	mode = newMode;
	subjectError = "";

	// Entering amend with an empty amend buffer: seed it from HEAD. A non-empty
	// buffer holds kept amend edits — leave them alone. The draft is never read
	// or written here, so it survives untouched.
	if (newMode === "amend" && amendSubject === "" && amendBody === "") {
		try {
			const msg = await safeInvoke<HeadCommitMessage>(
				"get_head_commit_message",
				{
					path: repoPath,
				},
			);
			// Guard the stale prefill: only apply if we're still in amend with an
			// untouched buffer. Leaving amend or typing during the fetch invalidates it.
			if (mode === "amend" && amendSubject === "" && amendBody === "") {
				amendSubject = msg.subject;
				amendBody = msg.body ?? "";
			}
		} catch (e) {
			console.error("Failed to get HEAD commit message:", e);
		}
	}
}

async function handleSubmit() {
	subjectError = "";
	stagedError = "";

	const subject = mode === "amend" ? amendSubject : draftSubject;
	const body = mode === "amend" ? amendBody : draftBody;

	// Stash mode: subject is optional (stash name). Commit/amend: subject required.
	if (mode !== "stash" && !subject.trim()) {
		subjectError = "Subject is required";
		return;
	}

	// All modes require staged files (except amend which can amend message-only)
	if (mode !== "amend" && stagedCount === 0) {
		stagedError = "No files staged";
		return;
	}

	// clearRedoStack only for commit/amend (modifies history), not stash
	if (mode !== "stash") {
		clearRedoStack();
	}

	committing = true;
	try {
		if (mode === "amend") {
			await safeInvoke("amend_commit", {
				path: repoPath,
				subject: subject.trim(),
				body: body.trim() || null,
			});
			// Amend never touches the WIP draft: clear only the amend buffer so the
			// next amend re-fetches fresh HEAD, and leave the draft (and its parent
			// callbacks) alone.
			amendSubject = "";
			amendBody = "";
		} else if (mode === "stash") {
			await safeInvoke("stash_save", {
				path: repoPath,
				message: subject.trim(),
			});
			showToast("Stash created", "success");
			clearDraft();
		} else {
			await safeInvoke("create_commit", {
				path: repoPath,
				subject: subject.trim(),
				body: body.trim() || null,
			});
			clearDraft();
		}
		mode = "commit"; // Always reset to commit mode after any successful operation
	} catch (e) {
		const err = e as { message?: string };
		const action =
			mode === "commit" ? "Commit" : mode === "amend" ? "Amend" : "Stash";
		console.error(`${action} failed:`, e);
		if (mode === "stash") {
			showToast(err.message ?? "Stash failed", "error");
		}
	} finally {
		committing = false;
	}
}
</script>

<div style="
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
">
  <!-- Mode tab selector -->
  <div style="display: flex; gap: 0; border-bottom: 1px solid var(--color-border); margin-bottom: 2px;">
    {#each [['commit', 'Commit'], ['amend', 'Amend'], ['stash', 'Stash']] as [tab, label]}
      <button
        onclick={() => handleModeSwitch(tab as 'commit' | 'amend' | 'stash')}
        disabled={committing}
        style="
          flex: 1;
          padding: 6px 0 4px;
          font-size: 12px;
          background: none;
          border: none;
          border-bottom: 2px solid {mode === tab ? 'var(--color-accent)' : 'transparent'};
          color: {mode === tab ? 'var(--fg-0)' : 'var(--fg-3)'};
          cursor: {committing ? 'default' : 'pointer'};
          text-transform: none;
        "
      >
        {label}
      </button>
    {/each}
  </div>

  <!-- Subject field -->
  <div style="position: relative;">
    <input
      data-testid="commit-form-subject"
      type="text"
      bind:value={getSubject, setSubject}
      placeholder={mode === 'stash' ? 'Stash name (optional)' : 'Summary (required)'}
      style="
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--line);
        background: var(--bg-0);
        color: var(--fg-1);
        border-radius: var(--radius-m);
        padding: 8px 44px 8px 10px;
        font-size: 12px;
      "
    />
    {#if counterVisible}
      <span
        data-testid="subject-counter"
        data-over={subjectOverLimit}
        style="
          position: absolute;
          top: 50%;
          right: 10px;
          transform: translateY(-50%);
          pointer-events: none;
          font-family: var(--font-mono);
          font-size: 10.5px;
          color: {subjectOverLimit ? 'var(--color-danger)' : 'var(--fg-3)'};
        "
      >{getSubject().length}/72</span>
    {/if}
  </div>
  {#if subjectError}
    <span class="error-text" style="font-size: 11px;">{subjectError}</span>
  {/if}

  <!-- Body field -->
  <textarea
    bind:value={getBody, setBody}
    rows={3}
    placeholder="Description (optional)"
    style="
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--line);
      background: var(--bg-0);
      color: var(--fg-1);
      border-radius: var(--radius-m);
      padding: 8px 10px;
      font-size: 12px;
      resize: vertical;
    "
  ></textarea>

  <!-- Staged error -->
  {#if stagedError}
    <span class="error-text" style="font-size: 11px;">{stagedError}</span>
  {/if}

  <!-- Commit button -->
  <button
    data-testid="commit-form-submit"
    onclick={handleSubmit}
    disabled={committing}
    style="
      width: 100%;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--accent);
      color: var(--accent-fg);
      border: 0;
      border-radius: var(--radius-m);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      opacity: {committing ? 0.6 : 1};
    "
  >{buttonLabel}</button>
</div>

<style>
  .error-text {
    color: var(--color-danger);
  }
</style>
