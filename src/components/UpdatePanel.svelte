<script lang="ts">
import Button from "../lib/ui/Button.svelte";
import type { UpdateStatus } from "../lib/updates.js";

interface Props {
	status: UpdateStatus | null;
	busy: boolean;
	frozen: boolean;
	error: string | null;
	confirmVersion: string | null;
	retry?: { label: string; run(): void };
	onclose(): void;
	onenable(): void;
	oncheck(): void;
	ondownload(version: string): void;
	onrestart(version: string): void;
	onconfirm(version: string): void;
	onconfirmcancel(): void;
	oncancel(): void;
}

let {
	status,
	busy,
	frozen,
	error,
	confirmVersion,
	retry,
	onclose,
	onenable,
	oncheck,
	ondownload,
	onrestart,
	onconfirm,
	onconfirmcancel,
	oncancel,
}: Props = $props();
const downloading = $derived(status?.phase === "downloading");
const manual = $derived(
	!status?.eligible || status.phase === "manual" || status.phase === "recovery",
);
const percent = $derived(
	status?.total
		? Math.min(100, Math.round((status.downloaded / status.total) * 100))
		: null,
);
const releaseUrl = $derived(
	!manual && status?.version
		? `https://github.com/joaofnds/trunk/releases/tag/v${encodeURIComponent(status.version)}`
		: "https://github.com/joaofnds/trunk/releases/latest",
);
let panel: HTMLElement;
$effect(() => {
	if (frozen) panel.focus({ preventScroll: true });
});
</script>

<section
	bind:this={panel}
	aria-label="Trunk updates"
	tabindex="-1"
	data-update-panel
	class="flex flex-col gap-3 p-4 text-body text-text bg-surface rounded border border-border shadow-lg"
>
	<h3 class="text-callout font-semibold"
		>{status?.version ? `Trunk ${status.version}` : "Trunk updates"}</h3
	>
	{#if error}
		<p role="alert" class="text-danger break-words">{error}</p>
	{/if}
	{#if retry}
		<Button disabled={busy || frozen} onclick={retry.run}>{retry.label}</Button>
	{/if}
	{#if status?.message}
		<p role="status" class="break-words">{status.message}</p>
	{/if}
	{#if status && manual}
		<p class="text-text-muted"
			>Use your original installation method to update Trunk. Keep your
			application data when reinstalling.</p
		>
	{:else if frozen}
		<p role="status"
			>{status?.phase === "installing"
				? "Installing and restarting…"
				: "Saving drafts and preparing to restart…"}</p
		>
	{:else if confirmVersion}
		<h4 class="font-medium">Restart and install {confirmVersion}?</h4>
		<p class="text-text-muted"
			>Trunk will save your supported drafts and restart. Finish or cancel
			active Git operations first.</p
		>
		<div class="flex flex-wrap justify-end gap-2">
			<Button size="sm" onclick={onconfirmcancel}>Cancel</Button>
			<Button
				size="sm"
				variant="primary"
				disabled={busy}
				onclick={() => confirmVersion && onconfirm(confirmVersion)}
				>Restart and install {confirmVersion}</Button
			>
		</div>
	{:else if !status}
		<p class="text-text-muted">Update status unavailable</p>
	{:else if !status.adopted}
		<p class="text-text-muted"
			>Enable updates only if you installed this copy directly. Copies managed
			by Homebrew, your organization, or another package manager must keep using
			that installation method.</p
		>
		<Button size="sm" disabled={busy} onclick={onenable}
			>Enable updates for this copy</Button
		>
	{:else if downloading}
		<p role="status">Downloading{percent === null ? "…" : `: ${percent}%`}</p>
		<progress
			class="w-full"
			max="100"
			value={percent ?? undefined}
			aria-label="Update download"
		></progress>
		<Button size="sm" onclick={oncancel}>Cancel download</Button>
	{:else if status.phase === "ready" && status.version}
		<p class="text-text-muted">Update ready. Restart Trunk to install it.</p>
		<Button
			size="sm"
			disabled={busy}
			onclick={() => status?.version && onrestart(status.version)}
			>Restart Trunk</Button
		>
	{:else if status.phase === "available" && status.version}
		<p class="text-text-muted">An update is available.</p>
		<Button
			size="sm"
			disabled={busy}
			onclick={() => status?.version && ondownload(status.version)}
			>Download {status.version}</Button
		>
	{:else if status.phase === "checking"}
		<p role="status">Checking for updates…</p>
	{:else}
		<p class="text-text-muted">Installed version {status.current_version}</p>
		<Button size="sm" disabled={busy} onclick={oncheck}
			>Check for updates</Button
		>
	{/if}
	{#if !frozen || manual}
		<div class="flex items-center justify-between gap-3">
			<a class="text-accent underline" href={releaseUrl}
				>{manual ? "Download a release" : "Update details"}</a
			>
			{#if !frozen}
				<Button size="sm" variant="ghost" onclick={onclose}>Close</Button>
			{/if}
		</div>
	{/if}
</section>
