<script lang="ts">
import { safeInvoke, type TrunkError } from "../lib/invoke.js";
import {
	autostashConflictError,
	isForcePushRefusal,
	remoteErrorMessage,
} from "../lib/remote-error.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type { OperationInfo } from "../lib/types.js";

interface Props {
	repoPath: string;
	remoteState: RemoteState;
	branch: string;
	remote: string;
	onclear: () => void;
}

let { repoPath, remoteState, branch, remote, onclear }: Props = $props();

type Display =
	| { kind: "none" }
	| { kind: "recovery" }
	| { kind: "force_refused" }
	| { kind: "message"; text: string };

let display = $state<Display>({ kind: "none" });

// Decide what the surface shows from the current error. A non_fast_forward offers the
// three recovery choices, but only when the repo is Clean: a push that fails while a
// rebase/merge is already in progress must not offer "Pull & Rebase" (grilled D6), so
// it falls back to the persistent message. A lease/if-includes refusal also arrives as
// non_fast_forward, but Force Push would be a guaranteed no-op there, so it gets its own
// state that steers to Pull & Rebase and drops the Force Push button (grilled D7, reversed).
$effect(() => {
	const err = remoteState.error;
	if (!err) {
		display = { kind: "none" };
		return;
	}
	if (err.code !== "non_fast_forward") {
		display = { kind: "message", text: remoteErrorMessage(err) };
		return;
	}
	const clean: Display = isForcePushRefusal(err)
		? { kind: "force_refused" }
		: { kind: "recovery" };
	let cancelled = false;
	safeInvoke<OperationInfo>("get_operation_state", { path: repoPath })
		.then((info) => {
			if (cancelled) return;
			display =
				info.op_type === "None"
					? clean
					: { kind: "message", text: remoteErrorMessage(err) };
		})
		.catch(() => {
			if (!cancelled) display = clean;
		});
	return () => {
		cancelled = true;
	};
});

function dismiss() {
	remoteState.error = null;
	onclear();
}

// Pull-rebase then push as one chain. isRunning is held across BOTH legs and cleared
// only at a terminal outcome, so the background-fetch suppression (grilled R1) never
// reopens mid-chain.
async function handlePullRebasePush() {
	remoteState.isRunning = true;
	remoteState.error = null;
	remoteState.progressLine = "";
	try {
		await safeInvoke("git_pull", { path: repoPath, strategy: "rebase" });
	} catch (e) {
		remoteState.isRunning = false;
		// A rebase that stops on conflicts leaves the repo mid-rebase: OperationBanner
		// and the merge editor own the screen, so clear our surface and just explain
		// that the push did not happen (grilled D6, C7). A clean pull failure (repo
		// still Clean) keeps the persistent error surface instead.
		const info = await safeInvoke<OperationInfo>("get_operation_state", {
			path: repoPath,
		}).catch(() => null);
		if (info && info.op_type !== "None") {
			remoteState.error = null;
			showToast(
				"Rebase stopped on conflicts — resolve them, then push again",
				"error",
			);
			return;
		}
		remoteState.error = e as TrunkError;
		return;
	}
	// Without this probe a conflicted autostash restore is invisible — the pull exited 0,
	// no rebase remains, and the push would publish conflict markers as a success.
	const counts = await safeInvoke<{ conflicted: number }>("get_dirty_counts", {
		path: repoPath,
	}).catch(() => null);
	if (counts && counts.conflicted > 0) {
		remoteState.isRunning = false;
		remoteState.error = autostashConflictError();
		return;
	}
	try {
		await safeInvoke("git_push", { path: repoPath });
		remoteState.isRunning = false;
		remoteState.error = null;
		showToast("Pushed successfully", "success");
	} catch (e) {
		// A push rejected here (the remote moved again during the rebase) re-opens the
		// same three choices via the error effect (C9); no second auto-retry.
		remoteState.isRunning = false;
		remoteState.error = e as TrunkError;
	}
}

// Lease-protected force push behind one confirmation naming branch and remote (C10).
// The backend command always pairs --force-with-lease with --force-if-includes (C11).
async function handleForcePush() {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Force push ${branch} to ${remote}? This overwrites the remote branch.`,
		{ title: "Force Push", kind: "warning" },
	);
	if (!confirmed) return;
	remoteState.isRunning = true;
	remoteState.error = null;
	remoteState.progressLine = "";
	try {
		await safeInvoke("git_push_force", { path: repoPath });
		remoteState.isRunning = false;
		remoteState.error = null;
		showToast("Force pushed successfully", "success");
	} catch (e) {
		// An if-includes refusal classifies as non_fast_forward and re-opens the three
		// choices via the error effect (C12); no dead end.
		remoteState.isRunning = false;
		remoteState.error = e as TrunkError;
	}
}
</script>

<style>
  .recovery-surface {
    flex-shrink: 0;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-banner-warning-bg);
    border-left: 3px solid var(--color-banner-warning-border);
  }
  .recovery-body {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .recovery-text {
    font-size: 12px;
    color: var(--color-text);
    flex: 1;
    min-width: 0;
  }
  .recovery-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .btn {
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
    padding: 2px 8px;
    white-space: nowrap;
    border: 1px solid transparent;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn-primary {
    background: var(--color-success-bg);
    color: var(--color-success);
    border-color: var(--color-success-border);
  }
  .btn-danger {
    background: var(--color-danger-bg);
    color: var(--color-danger);
    border-color: var(--color-danger-border);
  }
  .btn-neutral {
    background: transparent;
    color: var(--color-text-muted);
    border-color: var(--color-border);
  }
</style>

{#if display.kind !== "none"}
  <div class="recovery-surface" role="alert">
    <div class="recovery-body">
      {#if display.kind === "recovery"}
        <span class="recovery-text">
          Push to <strong>{remote}</strong> rejected &mdash; <strong>{branch}</strong> has diverged from the remote.
        </span>
        <div class="recovery-actions">
          <button class="btn btn-primary" onclick={handlePullRebasePush} disabled={remoteState.isRunning}>Pull &amp; Rebase, then Push</button>
          <button class="btn btn-danger" onclick={handleForcePush} disabled={remoteState.isRunning}>Force Push</button>
          <button class="btn btn-neutral" onclick={dismiss} disabled={remoteState.isRunning}>Cancel</button>
        </div>
      {:else if display.kind === "force_refused"}
        <span class="recovery-text">
          Force push to <strong>{remote}</strong> refused &mdash; <strong>{branch}</strong> has remote commits you haven&rsquo;t integrated. Pull &amp; Rebase to include them, then push.
        </span>
        <div class="recovery-actions">
          <button class="btn btn-primary" onclick={handlePullRebasePush} disabled={remoteState.isRunning}>Pull &amp; Rebase, then Push</button>
          <button class="btn btn-neutral" onclick={dismiss} disabled={remoteState.isRunning}>Cancel</button>
        </div>
      {:else}
        <span class="recovery-text">{display.text}</span>
        <div class="recovery-actions">
          <button class="btn btn-neutral" onclick={dismiss}>Dismiss</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
