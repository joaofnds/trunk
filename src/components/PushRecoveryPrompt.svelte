<script lang="ts">
import { safeInvoke } from "../lib/invoke.js";
import { isForcePushRefusal, remoteErrorMessage } from "../lib/remote-error.js";
import { runRemoteOp } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import type { OperationInfo, PushTarget } from "../lib/types.js";

interface Props {
	repoPath: string;
	remoteState: RemoteState;
	refreshSignal: number;
	onclear: () => void;
}

let { repoPath, remoteState, refreshSignal, onclear }: Props = $props();

type Target = { remote: string; branch: string };

type Display =
	| { kind: "none" }
	| ({ kind: "recovery" } & Target)
	| ({ kind: "force_refused" } & Target)
	| { kind: "message"; text: string };

// Snapshotted when the failure arrives, never re-read: the banner describes the push
// that failed, so a checkout while it is up must not relabel it.
let pushTarget = $state<PushTarget | null>(null);
let gate = $state<"unknown" | "clean" | "busy">("unknown");

$effect(() => {
	if (!remoteState.error) {
		pushTarget = null;
		return;
	}
	let cancelled = false;
	safeInvoke<PushTarget>("get_push_target", { path: repoPath })
		.then((target) => {
			if (!cancelled) pushTarget = target;
		})
		.catch(() => {
			if (!cancelled) pushTarget = null;
		});
	return () => {
		cancelled = true;
	};
});

// Reading refreshSignal is what re-probes on every repo change rather than sampling
// once: the user can finish or start a merge while the banner is up. A probe that
// fails leaves the gate closed — mid-operation is then unknown, not answered "no".
$effect(() => {
	refreshSignal;
	if (!remoteState.error) {
		gate = "unknown";
		return;
	}
	let cancelled = false;
	safeInvoke<OperationInfo>("get_operation_state", { path: repoPath })
		.then((info) => {
			if (!cancelled) gate = info.op_type === "None" ? "clean" : "busy";
		})
		.catch(() => {
			if (!cancelled) gate = "busy";
		});
	return () => {
		cancelled = true;
	};
});

// Every fall-through to `message` drops the destructive button, so each one is a
// claim the banner would otherwise make and cannot support.
let display = $derived.by((): Display => {
	const err = remoteState.error;
	if (!err) return { kind: "none" };

	const message: Display = { kind: "message", text: remoteErrorMessage(err) };
	if (err.code !== "non_fast_forward" || remoteState.lastOp !== "push") {
		return message;
	}
	if (gate !== "clean") return message;

	const remote = pushTarget?.remote;
	const branch = pushTarget?.branch;
	if (!remote || !branch) return message;

	return isForcePushRefusal(err)
		? { kind: "force_refused", remote, branch }
		: { kind: "recovery", remote, branch };
});

function dismiss() {
	remoteState.error = null;
	onclear();
}

async function handleForcePush(target: Target) {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Force push ${target.branch} to ${target.remote}? This overwrites the remote branch.`,
		{ title: "Force Push", kind: "warning" },
	);
	if (!confirmed) return;
	await runRemoteOp(
		remoteState,
		repoPath,
		"git_push_force",
		"Force pushed successfully",
	);
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
        {@const target = { remote: display.remote, branch: display.branch }}
        <span class="recovery-text">
          Push to <strong>{target.remote}</strong> rejected &mdash; <strong>{target.branch}</strong> has diverged from the remote.
        </span>
        <div class="recovery-actions">
          <button class="btn btn-danger" onclick={() => handleForcePush(target)} disabled={remoteState.isRunning}>Force Push</button>
          <button class="btn btn-neutral" onclick={dismiss} disabled={remoteState.isRunning}>Cancel</button>
        </div>
      {:else if display.kind === "force_refused"}
        <span class="recovery-text">
          Force push to <strong>{display.remote}</strong> refused &mdash; <strong>{display.branch}</strong> has remote commits you haven&rsquo;t integrated. Pull &amp; Rebase to include them, then push.
        </span>
        <div class="recovery-actions">
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
