<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import { runRemoteOp } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import Button from "../lib/ui/Button.svelte";
import ButtonGroup from "../lib/ui/ButtonGroup.svelte";

interface Props {
	repoPath: string;
	disabled: boolean;
	remoteState: RemoteState;
	/** The plain pull, run from the main button; the menu holds the other strategies. */
	onpull: () => void;
}

let { repoPath, disabled, remoteState, onpull }: Props = $props();
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

.dropdown-panel {
	position: absolute;
	top: 100%;
	left: 0;
	z-index: 100;
	margin-top: var(--space-1);
	background: var(--color-surface-raised);
	border: 1px solid var(--color-border);
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
	color: var(--color-text);
	font-size: var(--text-callout);
	padding: var(--space-2) var(--space-3);
	cursor: pointer;
}
.dropdown-option:hover {
	background: var(--color-accent);
	color: var(--color-on-accent);
}
</style>

<div class="pull-dropdown">
	<ButtonGroup>
		<Button
			icon
			joined
			{disabled}
			onclick={onpull}
			aria-label="Pull"
			tooltip="Pull"
		>
			<ArrowDown size={14} />
		</Button>
		<!-- Narrower than the button it hangs off: this is that button's menu,
		     not a peer of it. -->
		<Button
			icon
			joined
			size="sm"
			variant="ghost"
			{disabled}
			onclick={toggle}
			aria-label="Pull options"
			aria-expanded={open}
			tooltip="Pull options"
		>
			<ChevronDown size={12} />
		</Button>
	</ButtonGroup>

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
