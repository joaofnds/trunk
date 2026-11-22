<script lang="ts">
import X from "@lucide/svelte/icons/x";
import { splitFilePath } from "../lib/file-path.js";
import { displayPath, repositoryName } from "../lib/path.js";
import {
	getRecentRepos,
	type RecentRepo,
	removeRecentRepo,
} from "../lib/store.js";
import Button from "../lib/ui/Button.svelte";
import Row from "../lib/ui/Row.svelte";

interface Props {
	/** A missing choice opens the native folder chooser. */
	onopen: (choice?: RecentRepo) => void;
	opening?: boolean;
	error?: string | null;
}

let { onopen, opening = false, error = null }: Props = $props();

let recentRepos = $state<RecentRepo[]>([]);
let resolvedPaths: Record<string, string> = $state({});

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

async function handleRemoveRecent(path: string) {
	await removeRecentRepo(path);
	recentRepos = await getRecentRepos();
}
</script>

<div class="h-full min-h-0 overflow-y-auto bg-bg">
	<div
		class="flex h-full min-h-min flex-col items-center justify-center gap-4 py-4"
	>
		<div
			class="flex shrink-0 flex-col items-center gap-4 w-full max-w-welcome px-4"
		>
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
				<Button variant="primary" size="lg" onclick={() => onopen()}>
					Open Repository
				</Button>
			</div>
			{#if opening}
				<p role="status" class="text-callout text-text-muted"
					>Opening repository…</p
				>
			{/if}
		</div>

		{#if displayedRepos.length > 0}
			<div class="flex flex-col min-h-0 w-full max-w-welcome px-4">
				<p
					class="text-callout font-medium mb-2 uppercase tracking-widest text-text-muted"
					>Recent</p
				>
				<ul class="flex flex-col gap-1 overflow-y-auto">
					{#each displayedRepos as repo (repo.path)}
						{@const name = repositoryName(repo.path)}
						{@const path = (resolvedPaths[repo.path] ?? repo.path).replace(
							/\/+$/,
							"",
						)}
						{@const parent =
							splitFilePath(path).directory ||
							(path.startsWith("/") ? "/" : "")}
						<li>
							<Row
								variant="entry"
								reveal="fade"
								title={repo.path}
								aria-label={`${name}, ${repo.path}`}
								onclick={() => onopen({ path: repo.path, name })}
							>
								<span class="flex flex-1 items-baseline min-w-0 gap-2">
									<span class="truncate font-medium text-text text-body"
										><bdi>{name}</bdi></span
									>
									{#if parent}
										<span
											dir="rtl"
											class="min-w-0 flex-1 truncate text-left text-callout text-text-muted"
											><bdi>{parent}</bdi></span
										>
									{/if}
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
