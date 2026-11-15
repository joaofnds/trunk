<script lang="ts">
import Button from "../lib/ui/Button.svelte";
import Dialog from "../lib/ui/Dialog.svelte";
import type { UpdateStatus } from "../lib/updates.js";

interface Props {
	status: UpdateStatus | null;
	busy: boolean;
	frozen: boolean;
	error: string | null;
	retry?: { label: string; run(): void };
	onclose(): void;
	onenable(): void;
	oncheck(): void;
	ondownload(version: string): void;
	onrestart(version: string): void;
	oncancel(): void;
}

let {
	status,
	busy,
	frozen,
	error,
	retry,
	onclose,
	onenable,
	oncheck,
	ondownload,
	onrestart,
	oncancel,
}: Props = $props();
const downloading = $derived(status?.phase === "downloading");
const percent = $derived(
	status?.total && status.total > 0
		? Math.min(100, Math.round((status.downloaded / status.total) * 100))
		: null,
);

function close(event?: Event) {
	event?.preventDefault();
	if (!frozen) onclose();
}
</script>

<Dialog title="Trunk updates" size="md" oncancel={close} data-update-dialog>
	<div class="flex flex-col gap-3 text-body leading-normal">
		{#if status}
			<p>Installed version {status.current_version}</p>
		{:else}
			<p>Update status unavailable</p>
		{/if}
		{#if error}
			<p role="alert" class="text-danger">{error}</p>
		{/if}
		{#if retry}
			<Button disabled={busy} onclick={retry.run}>{retry.label}</Button>
		{/if}
		{#if status?.message}
			<p role="status">{status.message}</p>
		{/if}
		{#if !status?.eligible ||
			status.phase === "manual" ||
			status.phase === "recovery"}
			<p
				>Use your original installation method to update Trunk. Keep your
				application data when reinstalling.</p
			>
			<a
				class="text-accent underline"
				href="https://github.com/joaofnds/trunk/releases/latest"
				target="_blank"
				rel="noreferrer"
				>Download a release</a
			>
		{:else if !status.adopted}
			<p
				>Enable updates only if you installed this copy directly. Copies managed
				by Homebrew, your organization, or another package manager must keep
				using that installation method.</p
			>
			<Button variant="primary" disabled={busy} onclick={onenable}
				>Enable updates for this copy</Button
			>
		{:else}
			{#if status.version}
				<p>Version {status.version}</p>
			{/if}
			{#if status.notes}
				<p
					class="whitespace-pre-wrap break-words max-h-dialog-lg-max overflow-auto"
					>{status.notes}</p
				>
			{/if}
			{#if downloading}
				<p role="status"
					>Downloading{percent === null ? "…" : `: ${percent}%`}</p
				>
				<progress
					class="w-full"
					max="100"
					value={percent ?? undefined}
					aria-label="Update download"
				></progress>
			{:else if frozen}
				<p role="status"
					>{status.phase === "installing"
						? "Installing and restarting…"
						: "Saving drafts and preparing to restart…"}</p
				>
			{:else if status.phase === "checking"}
				<p role="status">Checking for updates…</p>
			{/if}
			<div class="flex flex-wrap gap-2">
				{#if downloading}
					<Button onclick={oncancel}>Cancel download</Button>
				{:else if status.phase === "ready" && status.version}
					<Button
						variant="primary"
						disabled={busy || frozen}
						onclick={() => status?.version && onrestart(status.version)}
						>Restart and install {status.version}</Button
					>
				{:else if status.phase === "available" && status.version}
					<Button
						variant="primary"
						disabled={busy || frozen}
						onclick={() => status?.version && ondownload(status.version)}
						>Download {status.version}</Button
					>
				{/if}
				<Button disabled={busy || frozen || downloading} onclick={oncheck}
					>Check for updates</Button
				>
			</div>
		{/if}
		<div class="flex justify-end">
			<Button disabled={frozen} onclick={() => close()}>Close</Button>
		</div>
	</div>
</Dialog>
