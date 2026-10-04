<script lang="ts">
import X from "@lucide/svelte/icons/x";
import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import { displayPath } from "../lib/path.js";
import {
	addRecentRepo,
	getRecentRepos,
	type RecentRepo,
	removeRecentRepo,
} from "../lib/store.js";
import Button from "../lib/ui/Button.svelte";
import Row from "../lib/ui/Row.svelte";

interface Props {
	onopen: (path: string, name: string) => void;
	isFullscreen?: boolean;
}

let { onopen, isFullscreen = false }: Props = $props();

let recentRepos = $state<RecentRepo[]>([]);
let resolvedPaths: Record<string, string> = $state({});
let loading = $state(false);
let error = $state<string | null>(null);

// Storage is uncapped (the picker shows full history); the dashboard intentionally
// shows only the most recent few to keep the welcome screen compact.
const DASHBOARD_RECENT_LIMIT = 10;
const displayedRepos = $derived(recentRepos.slice(0, DASHBOARD_RECENT_LIMIT));

$effect(() => {
	getRecentRepos().then((repos) => {
		recentRepos = repos;
	});
});

$effect(() => {
	for (const repo of recentRepos) {
		if (!(repo.path in resolvedPaths)) {
			displayPath(repo.path).then((p) => {
				resolvedPaths[repo.path] = p;
			});
		}
	}
});

async function openRepository() {
	error = null;
	const selected = await open({ directory: true, multiple: false });
	if (typeof selected !== "string") return;

	await openPath(selected);
}

async function openPath(path: string) {
	error = null;
	loading = true;
	try {
		await safeInvoke("open_repo", { path });
		const name = path.split("/").at(-1) || path;
		await addRecentRepo({ name, path });
		recentRepos = await getRecentRepos();
		onopen(path, name);
	} catch (e: unknown) {
		error = errorMessage(e, "Failed to open repository");
	} finally {
		loading = false;
	}
}

async function handleRemoveRecent(path: string) {
	await removeRecentRepo(path);
	recentRepos = await getRecentRepos();
}
</script>

<div class="flex flex-col h-screen bg-bg">
	<!-- LAYOUT-02: drag region for window movement on welcome screen -->
	<div
		data-tauri-drag-region
		class="flex-shrink-0 h-topbar"
		style:padding-left="{isFullscreen ? 0 : 78}px"
	></div>
	<div class="flex-1 flex flex-col items-center justify-center gap-6">
		<div class="flex flex-col items-center gap-4 w-full max-w-welcome px-4">
			<h1 class="text-display font-semibold text-text">Trunk</h1>
			<p class="text-body text-text-muted"
				>Git history, beautifully visualized</p
			>

			{#if error}
				<div class="error-banner w-full rounded px-4 py-2 text-body">
					{error}
				</div>
			{/if}

			<div class="grid w-full">
				<Button
					variant="primary"
					size="lg"
					onclick={openRepository}
					disabled={loading}
				>
					{loading ? 'Opening...' : 'Open Repository'}
				</Button>
			</div>
		</div>

		{#if displayedRepos.length > 0}
			<div class="w-full max-w-welcome px-4">
				<p
					class="text-callout font-medium mb-2 uppercase tracking-widest text-text-muted"
					>Recent</p
				>
				<ul class="flex flex-col gap-1">
					{#each displayedRepos as repo (repo.path)}
						{@const dp = resolvedPaths[repo.path] ?? repo.path}
						<li>
							<Row
								variant="entry"
								reveal="fade"
								onclick={() => openPath(repo.path)}
							>
								<span class="text-body truncate min-w-0 flex-1">
									<span class="text-text-muted"
										>{dp.substring(0, dp.lastIndexOf('/'))}/</span
									><span class="font-semibold text-text"
										>{dp.split('/').at(-1)}</span
									>
								</span>
								{#snippet actions()}
									<Button
										icon
										size="sm"
										variant="ghost"
										aria-label="Remove from recent"
										title="Remove from recent"
										onclick={() => handleRemoveRecent(repo.path)}
									>
										<X size={12} />
									</Button>
								{/snippet}
							</Row>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
</div>

<style>
.error-banner {
	background: var(--color-danger-bg);
	border: 1px solid var(--color-danger-border);
	color: var(--color-danger);
}
</style>
