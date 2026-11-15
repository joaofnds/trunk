<script lang="ts">
import Check from "@lucide/svelte/icons/check";
import Download from "@lucide/svelte/icons/download";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import RotateCw from "@lucide/svelte/icons/rotate-cw";
import { tick } from "svelte";
import Button from "../lib/ui/Button.svelte";
import type { UpdateStatus } from "../lib/updates.js";

interface Props {
	status: UpdateStatus | null;
	busy: boolean;
	oncheck(): void;
	ondetails(): void;
	ondownload(version: string): void;
	onrestart(version: string): void;
}
let { status, busy, oncheck, ondetails, ondownload, onrestart }: Props =
	$props();
let trigger: HTMLDivElement;
let popup: HTMLDivElement | undefined;
let notesOpen = $state(false);
let suppressFocusOpen = false;
const eligible = $derived(status?.eligible && status.adopted);
const checking = $derived(status?.phase === "checking");
const downloading = $derived(status?.phase === "downloading");
const ready = $derived(eligible && status?.phase === "ready");
const available = $derived(eligible && status?.phase === "available");
const percent = $derived(
	status?.total
		? Math.min(100, Math.round((status.downloaded / status.total) * 100))
		: null,
);
const label = $derived(
	checking
		? "Checking for updates…"
		: downloading
			? `Downloading update${percent === null ? "…" : `: ${percent}%`}`
			: ready
				? `Restart to update to ${status?.version}`
				: available
					? `Download update ${status?.version}`
					: "Check for updates",
);
const showNotes = $derived(
	Boolean(eligible && status?.notes && (available || ready || downloading)),
);

function activate() {
	notesOpen = false;
	if (busy && !downloading) return;

	if (available && status?.version) ondownload(status.version);
	else if (ready && status?.version) onrestart(status.version);
	else if (eligible && status?.phase === "idle") oncheck();
	else ondetails();
}
function leave(event: MouseEvent | FocusEvent) {
	const next = event.relatedTarget;
	if (next instanceof Node && (trigger.contains(next) || popup?.contains(next)))
		return;

	notesOpen = false;
}
function outside(event: MouseEvent | FocusEvent) {
	const target = event.target;
	if (
		target instanceof Node &&
		!trigger.contains(target) &&
		!popup?.contains(target)
	)
		notesOpen = false;
}
function place(node: HTMLDivElement) {
	popup = node;
	document.body.appendChild(node);

	const rect = trigger.getBoundingClientRect();

	node.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - node.offsetWidth))}px`;
	if (rect.top > window.innerHeight / 2)
		node.style.bottom = `${window.innerHeight - rect.top}px`;
	else node.style.top = `${rect.bottom}px`;

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
	if (!notesOpen || !showNotes) return;

	const target = event.target;
	const fromTrigger = target instanceof Node && trigger.contains(target);
	const fromPopup = target instanceof Node && popup?.contains(target);

	if (event.key === "Escape") {
		event.preventDefault();
		event.stopImmediatePropagation();
		notesOpen = false;
		if (popup?.contains(document.activeElement)) focusTrigger();
	} else if (event.key === "Tab" && !event.shiftKey && fromTrigger) {
		event.preventDefault();
		await tick();
		popup?.querySelector("button")?.focus();
	} else if (event.key === "Tab" && event.shiftKey && fromPopup) {
		event.preventDefault();
		focusTrigger();
	} else if (event.key === "Tab" && fromPopup) {
		// Resume the app's normal tab order after the portaled notes.
		focusTrigger();
		notesOpen = false;
	}
}
$effect(() => {
	window.addEventListener("keydown", key, true);
	return () => window.removeEventListener("keydown", key, true);
});
</script>

<svelte:window
	onpointermove={outside}
	onfocusin={outside}
	onresize={() => (notesOpen = false)}
/>
<div bind:this={trigger} class="flex items-center">
	<Button
		icon
		variant={available || ready ? "accent" : "ghost"}
		aria-label={label}
		tooltip={showNotes ? undefined : (status?.message ?? label)}
		disabled={checking || (busy && !downloading)}
		onclick={activate}
		onmouseenter={() => (notesOpen = showNotes)}
		onfocus={() => {
			if (!suppressFocusOpen) notesOpen = showNotes;
		}}
		onblur={leave}
		onmouseleave={leave}
	>
		{#if downloading}
			<span class="grid size-6"
				><span class="col-start-1 row-start-1 place-self-center"
					><Download size={12} /></span
				>
				<svg
					class="col-start-1 row-start-1 place-self-center"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
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
				</svg></span
			>
		{:else if available}
			<span class="grid size-6"
				><span class="col-start-1 row-start-1 place-self-center"
					><Download size={18} /></span
				><span
					class="col-start-1 row-start-1 self-start justify-self-end h-1 w-1 rounded-full bg-accent"
				></span></span
			>
		{:else if ready}
			<span class="grid size-6"
				><span class="col-start-1 row-start-1 place-self-center"
					><RotateCw size={18} /></span
				><span
					class="col-start-1 row-start-1 self-start justify-self-end bg-surface rounded-full"
					><Check size={10} /></span
				></span
			>
		{:else}
			<span class:checking><RefreshCw size={18} /></span>
		{/if}
	</Button>
</div>
{#if notesOpen && showNotes && status}
	<div use:place class="fixed z-50 w-dialog-min max-w-full">
		<section
			aria-label={`Trunk ${status.version} release notes`}
			class="rounded border border-border p-4 text-text shadow-lg flex flex-col gap-3 bg-surface text-body"
		>
			<h3 class="text-callout font-semibold">Trunk {status.version}</h3>
			<p class="text-text-muted">{label}</p>
			<p
				class="whitespace-pre-wrap break-words max-h-dialog-lg-max overflow-auto"
				>{status.notes}</p
			>
			<Button
				size="sm"
				onclick={() => {
					notesOpen = false;
					ondetails();
				}}
				>Update details</Button
			>
		</section>
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
