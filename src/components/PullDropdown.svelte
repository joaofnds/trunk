<script lang="ts">
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import { runRemoteOp } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";

interface Props {
	repoPath: string;
	disabled: boolean;
	remoteState: RemoteState;
}

let { repoPath, disabled, remoteState }: Props = $props();
let open = $state(false);

interface PullOption {
	label: string;
	action: () => Promise<void>;
}

const options: PullOption[] = [
	{
		label: "Fetch",
		action: () =>
			runRemoteOp(remoteState, repoPath, "git_fetch", "Fetched successfully"),
	},
	{
		label: "Fast-forward if possible",
		action: () =>
			runRemoteOp(remoteState, repoPath, "git_pull", "Pulled successfully", {
				strategy: "ff",
			}),
	},
	{
		label: "Fast-forward only",
		action: () =>
			runRemoteOp(remoteState, repoPath, "git_pull", "Pulled successfully", {
				strategy: "ff-only",
			}),
	},
	{
		label: "Pull (rebase)",
		action: () =>
			runRemoteOp(
				remoteState,
				repoPath,
				"git_pull",
				"Pulled successfully (rebase)",
				{ strategy: "rebase" },
			),
	},
];

function handleOptionClick(opt: PullOption) {
	open = false;
	opt.action();
}

function toggle() {
	if (!disabled) open = !open;
}

// Close on outside click
function handleWindowClick(e: MouseEvent) {
	const target = e.target as HTMLElement;
	if (!target.closest(".pull-dropdown")) {
		open = false;
	}
}

$effect(() => {
	if (open) {
		window.addEventListener("click", handleWindowClick, true);
		return () => window.removeEventListener("click", handleWindowClick, true);
	}
});
</script>

<style>
  .pull-dropdown {
    position: relative;
    display: inline-flex;
  }

  .chevron-btn {
    background: none;
    border: none;
    /* Paint, not length: a border here would take a pixel out of the declared
       width, the same way it did out of the group's height. */
    box-shadow: inset 1px 0 0 var(--line);
    border-radius: 0 var(--radius) var(--radius) 0;
    color: var(--fg-2);
    cursor: pointer;
    font-size: 10px;
    /* Narrower than the button it hangs off: this is that button's dropdown,
       not a peer of it. Declared rather than derived from padding. */
    width: var(--control-sm-h);
    padding: 0;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .chevron-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .chevron-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--fg-1);
  }
  .chevron-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .dropdown-panel {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 100;
    margin-top: var(--space-1);
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
    min-width: 180px;
    padding: var(--space-1) 0;
  }

  .dropdown-option {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--fg-1);
    font-size: 12px;
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
  }
  .dropdown-option:hover {
    background: var(--accent);
    color: var(--accent-fg);
  }
</style>

<div class="pull-dropdown">
  <button class="chevron-btn" onclick={toggle} disabled={disabled} title="Pull options">
    <ChevronDown size={12} />
  </button>

  {#if open}
    <div class="dropdown-panel">
      {#each options as opt}
        <button class="dropdown-option" onclick={() => handleOptionClick(opt)}>
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
