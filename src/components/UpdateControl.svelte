<script lang="ts">
import Download from "@lucide/svelte/icons/download";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import RotateCw from "@lucide/svelte/icons/rotate-cw";
import { type Snippet, tick } from "svelte";
import Button from "../lib/ui/Button.svelte";
import type { UpdateStatus } from "../lib/updates.js";

interface Props {
	status: UpdateStatus | null;
	busy: boolean;
	frozen: boolean;
	waiting: boolean;
	open: boolean;
	children: Snippet<[() => void]>;
	onclose(): void;
	oncheck(): void;
	ondownload(version: string): void;
	onrestart(version: string): void;
}
let {
	status,
	busy,
	frozen,
	waiting,
	open = $bindable(),
	children,
	onclose,
	oncheck,
	ondownload,
	onrestart,
}: Props = $props();
let trigger: HTMLDivElement;
let popup: HTMLDivElement | undefined;
let hovered = $state(false);
const visible = $derived(open || hovered);
let suppressFocusOpen = false;
const eligible = $derived(status?.eligible && status.adopted);
const checking = $derived(status?.phase === "checking");
const downloading = $derived(status?.phase === "downloading");
const ready = $derived(eligible && status?.phase === "ready");
const available = $derived(status?.phase === "available");
const percent = $derived(
	status?.total
		? Math.min(100, Math.round((status.downloaded / status.total) * 100))
		: null,
);
const label = $derived.by(() => {
	if (waiting) return "Waiting to restart…";
	if (checking) return "Checking for updates…";
	if (downloading)
		return `Downloading update${percent === null ? "…" : `: ${percent}%`}`;
	if (ready) return `Restart to update to ${status?.version}`;
	if (available) return `Download update ${status?.version}`;
	return "Check for updates";
});
function activate() {
	hovered = false;
	if (busy && !downloading) open = true;
	else if (available && status?.version) ondownload(status.version);
	else if (ready && status?.version) onrestart(status.version);
	else if (status && ["idle", "manual"].includes(status.phase)) oncheck();
	else open = true;
}
function close() {
	if (frozen) return;

	if (popup?.contains(document.activeElement)) focusTrigger();
	hovered = false;
	open = false;
	onclose();
}
function leave(event: MouseEvent | FocusEvent) {
	if (event.type === "mouseleave" && hasFocus()) return;

	const next = event.relatedTarget;
	if (next instanceof Node && (trigger.contains(next) || popup?.contains(next)))
		return;

	hovered = false;
}
function outside(event: MouseEvent | FocusEvent) {
	if (event.type === "pointermove" && hasFocus()) return;

	const target = event.target;
	if (
		!(target instanceof Node) ||
		trigger.contains(target) ||
		popup?.contains(target)
	)
		return;

	if (event.type === "pointerdown") close();
	else hovered = false;
}
function hasFocus(): boolean {
	return (
		trigger.contains(document.activeElement) ||
		Boolean(popup?.contains(document.activeElement))
	);
}

function place(node: HTMLDivElement) {
	popup = node;
	document.body.appendChild(node);

	const rect = trigger.getBoundingClientRect();

	node.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - node.offsetWidth))}px`;
	if (rect.top > window.innerHeight / 2) {
		node.style.bottom = `${window.innerHeight - rect.top}px`;
		node.style.maxHeight = `${rect.top}px`;
	} else {
		node.style.top = `${rect.bottom}px`;
		node.style.maxHeight = `${window.innerHeight - rect.bottom}px`;
	}

	return {
		destroy() {
			node.remove();
			popup = undefined;
		},
	};
}
function focusTrigger() {
	suppressFocusOpen = true;
	trigger.querySelector("button")?.focus();
	suppressFocusOpen = false;
}
async function key(event: KeyboardEvent) {
	if (!visible || frozen) return;

	const target = event.target;
	const fromTrigger = target instanceof Node && trigger.contains(target);
	const fromPopup = target instanceof Node && popup?.contains(target);

	if (event.key === "Escape") {
		event.preventDefault();
		event.stopImmediatePropagation();
		close();
	} else if (event.key === "Tab" && !event.shiftKey && fromTrigger) {
		event.preventDefault();
		await tick();
		popup
			?.querySelector<HTMLElement>("button:not(:disabled), a[href]")
			?.focus();
	} else if (
		event.key === "Tab" &&
		event.shiftKey &&
		fromPopup &&
		target === popup?.querySelector("button:not(:disabled), a[href]")
	) {
		event.preventDefault();
		focusTrigger();
	} else if (
		event.key === "Tab" &&
		!event.shiftKey &&
		fromPopup &&
		target ===
			Array.from(
				popup?.querySelectorAll("button:not(:disabled), a[href]") ?? [],
			).at(-1)
	) {
		// Resume the app's tab order after the portaled panel.
		focusTrigger();
		close();
	}
}
$effect(() => {
	window.addEventListener("keydown", key, true);
	return () => window.removeEventListener("keydown", key, true);
});
</script>

<svelte:window
	onpointermove={outside}
	onpointerdown={outside}
	onfocusin={outside}
	onresize={close}
/>
<div bind:this={trigger} class="flex items-center">
	<Button
		icon
		aria-label={label}
		aria-expanded={visible}
		disabled={frozen}
		onclick={activate}
		onmouseenter={() => (hovered = true)}
		onfocus={() => {
			if (!suppressFocusOpen) hovered = true;
		}}
		onblur={leave}
		onmouseleave={leave}
	>
		<span
			class="flex items-center"
			class:text-accent={available || ready || downloading}
		>
			{#if downloading}
				<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
					<circle
						cx="12"
						cy="12"
						r="9"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-opacity="0.25"
					/>
					<circle
						cx="12"
						cy="12"
						r="9"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						pathLength="100"
						stroke-dasharray={`${percent ?? 25} 100`}
						transform="rotate(-90 12 12)"
					/>
				</svg>
			{:else if available}
				<Download size={14} />
			{:else if ready}
				<RotateCw size={14} />
			{:else}
				<span class:checking><RefreshCw size={14} /></span>
			{/if}
		</span>
	</Button>
</div>
{#if visible}
	<div use:place class="fixed z-1000 w-dialog-min max-w-full overflow-auto">
		{@render children(close)}
	</div>
{/if}
<style>
.checking {
	animation: update-check-spin 1s linear infinite;
}
@keyframes update-check-spin {
	to {
		transform: rotate(360deg);
	}
}
@media (prefers-reduced-motion: reduce) {
	.checking {
		animation: none;
	}
}
</style>
