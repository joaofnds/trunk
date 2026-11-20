<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import LoaderCircle from "@lucide/svelte/icons/loader-circle";
import { autofetchSummary } from "../lib/autofetch-status.js";
import { focusInEditable } from "../lib/keyboard.js";
import { runRemoteOp } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import Button from "../lib/ui/Button.svelte";
import ButtonGroup from "../lib/ui/ButtonGroup.svelte";
import ListOption from "../lib/ui/ListOption.svelte";

interface Props {
	repoPath: string;
	disabled: boolean;
	remoteState: RemoteState;
	/** The plain pull, run from the main button; the menu holds the other strategies. */
	onpull: () => void;
}

let { repoPath, disabled, remoteState, onpull }: Props = $props();
let open = $state(false);
const statusId = $props.id();
const fetchStatus = $derived(autofetchSummary(remoteState.autofetch));
const pulling = $derived(
	remoteState.isRunning && remoteState.lastOp !== "push",
);
const pullTooltip = $derived.by(() => {
	if (!pulling) return fetchStatus;
	return remoteState.lastOp === "fetch" ? "Fetching…" : "Pulling…";
});

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

let menu: HTMLElement | undefined = $state();
let optionsButton: HTMLButtonElement | undefined;

// Claimed on the window before anything below it, so the view behind the menu
// neither clears its diff's selected lines nor closes the diff.
function closeOnEscape(e: KeyboardEvent) {
	if (e.key !== "Escape") return;
	if (focusInEditable(document.activeElement)) return;

	e.preventDefault();
	e.stopPropagation();
	const focusInMenu = menu?.contains(document.activeElement) ?? false;
	open = false;
	// Focus on an option would fall to the page as the menu goes, so it returns to
	// the button that opened the menu. Focus anywhere else stays where it is.
	if (focusInMenu) optionsButton?.focus();
}

$effect(() => {
	if (open) {
		window.addEventListener("click", handleWindowClick, true);
		window.addEventListener("keydown", closeOnEscape, true);
		return () => {
			window.removeEventListener("click", handleWindowClick, true);
			window.removeEventListener("keydown", closeOnEscape, true);
		};
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
	min-width: calc(45 * var(--u));
	padding: var(--space-1) 0;
	font-size: var(--text-callout);
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
			aria-busy={pulling || undefined}
			aria-describedby={remoteState.autofetch ? statusId : undefined}
			tooltip={pullTooltip}
		>
			{#if pulling}
				<LoaderCircle size={14} class="animate-spin" />
			{:else}
				<ArrowDown size={14} />
			{/if}
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
			{@attach (el: HTMLButtonElement) => {
				optionsButton = el;
			}}
		>
			<ChevronDown size={12} />
		</Button>
	</ButtonGroup>
	{#if remoteState.autofetch}
		<span id={statusId} class="sr-only">{fetchStatus}</span>
	{/if}

	{#if open}
		<div
			class="dropdown-panel"
			role="menu"
			aria-label="Pull options"
			bind:this={menu}
		>
			{#each options as opt}
				<ListOption role="menuitem" onclick={() => handleOptionClick(opt)}>
					{opt.label}
				</ListOption>
			{/each}
		</div>
	{/if}
</div>
