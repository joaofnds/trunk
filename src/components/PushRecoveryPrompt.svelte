<script lang="ts">
import { safeInvoke, type TrunkError } from "../lib/invoke.js";
import { remoteErrorMessage } from "../lib/remote-error.js";
import { runRemoteOp } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import type { OperationInfo, PushTarget } from "../lib/types.js";

interface Props {
	repoPath: string;
	remoteState: RemoteState;
	refreshSignal: number;
}

let { repoPath, remoteState, refreshSignal }: Props = $props();

type Target = { remote: string; branch: string };

type Display =
	| { kind: "none" }
	| ({ kind: "recovery" } & Target)
	| ({ kind: "force_refused" } & Target)
	| { kind: "message"; text: string };

// Snapshotted when the failure arrives, never re-read: the banner describes the push
// that failed, so a checkout while it is up must not relabel it.
let pushTarget = $state<PushTarget | null>(null);
let repoOperation = $state<"unknown" | "clean" | "busy">("unknown");

function settleIfCurrent<T>(
	probe: Promise<T>,
	ok: (value: T) => void,
	failed: () => void,
): () => void {
	let cancelled = false;
	probe
		.then((value) => {
			if (!cancelled) ok(value);
		})
		.catch(() => {
			if (!cancelled) failed();
		});
	return () => {
		cancelled = true;
	};
}

$effect(() => {
	if (!remoteState.error) {
		pushTarget = null;
		return;
	}
	return settleIfCurrent(
		safeInvoke<PushTarget>("get_push_target", { path: repoPath }),
		(target) => {
			pushTarget = target;
		},
		() => {
			pushTarget = null;
		},
	);
});

// A pull whose rebase stopped on a conflict. The failure is the stop itself, so
// it stays true only for as long as that rebase is in progress, unlike a refused
// push, which stays true until the user acts on it.
function reportsAStoppedOperation(error: TrunkError | null): boolean {
	return error?.code === "rebase_conflict";
}

// Reading refreshSignal is what re-probes on every repo change rather than sampling
// once: the user can finish or start a merge while the banner is up. Only "clean"
// opens the destructive path, so a failed probe withholds it rather than assuming.
$effect(() => {
	refreshSignal;
	if (!remoteState.error) {
		repoOperation = "unknown";
		return;
	}
	const stoppedOp = reportsAStoppedOperation(remoteState.error);
	return settleIfCurrent(
		safeInvoke<OperationInfo>("get_operation_state", { path: repoPath }),
		(info) => {
			repoOperation = info.op_type === "None" ? "clean" : "busy";
			// A pull that stopped mid-rebase reports the stop as its failure. Once
			// that rebase is over, however it ended, the report describes nothing
			// the user can still act on and the bar has no reason to stay up.
			if (stoppedOp && repoOperation === "clean") remoteState.error = null;
		},
		() => {
			repoOperation = "unknown";
		},
	);
});

let display = $derived.by((): Display => {
	const err = remoteState.error;
	if (!err) return { kind: "none" };

	const message: Display = {
		kind: "message",
		text: remoteErrorMessage(err, remoteState.lastOp),
	};
	if (
		(err.code !== "non_fast_forward" && err.code !== "push_lease_refused") ||
		remoteState.lastOp !== "push"
	) {
		return message;
	}
	if (repoOperation !== "clean") return message;

	const remote = pushTarget?.remote;
	const branch = pushTarget?.branch;
	if (!remote || !branch) return message;

	return err.code === "push_lease_refused"
		? { kind: "force_refused", remote, branch }
		: { kind: "recovery", remote, branch };
});

function dismiss() {
	remoteState.error = null;
}

// Refnames arrive by clone and git permits what looks unremarkable here: U+2028/U+2029
// and the bidi overrides, which the native dialog lays out as hard breaks. Left in, a
// branch name adds its own lines to the question and can answer it.
const MAX_REFNAME_CHARS = 60;
const RENDER_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function forDisplay(name: string): string {
	const flattened = name.replace(RENDER_UNSAFE, "�");
	const points = Array.from(flattened);
	return points.length <= MAX_REFNAME_CHARS
		? flattened
		: `${points.slice(0, MAX_REFNAME_CHARS).join("")}…`;
}

async function handleForcePush(target: Target) {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Force push? This overwrites the remote branch.\n\nBranch: ${forDisplay(target.branch)}\nRemote: ${forDisplay(target.remote)}`,
		{ title: "Force Push", kind: "warning" },
	);
	if (!confirmed) return;
	await runRemoteOp(
		remoteState,
		repoPath,
		"git_push_force",
		"Force pushed successfully",
		{ remote: target.remote, branch: target.branch },
	);
}
</script>

<style>
  .recovery-surface {
    flex-shrink: 0;
    /* No declared height: this one wraps to several lines by design. The rules
       are still paint, so they cost it no space of its own. */
    min-height: var(--banded-lg-h);
    padding: var(--space-1) var(--space-3);
    box-shadow:
      inset 0 -1px 0 var(--color-border),
      inset 3px 0 0 var(--color-banner-warning-border);
    background: var(--color-banner-warning-bg);
  }
  .recovery-body {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .recovery-text {
    font-size: 12px;
    color: var(--color-text);
    flex: 1;
    min-width: 0;
  }
  .recovery-actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    border-radius: var(--radius);
    cursor: pointer;
    height: var(--control-sm-h);
    padding: 0 var(--space-2);
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
