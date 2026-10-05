<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import { copySha } from "../lib/clipboard.js";
import Chip from "../lib/ui/Chip.svelte";
import Avatar from "./Avatar.svelte";

interface Props {
	authorName: string;
	authorEmail: string;
	/** Seconds since the epoch, as git stores it. */
	authorTimestamp: number;
	parentOids: string[];
	/** Empty when the commit is a tip, or when nav has not loaded. */
	childOids: string[];
	onnavigate?: (oid: string) => void;
}

let {
	authorName,
	authorEmail,
	authorTimestamp,
	parentOids,
	childOids,
	onnavigate,
}: Props = $props();

let authorDate = $derived(new Date(authorTimestamp * 1000).toLocaleString());

async function showShaContextMenu(e: MouseEvent, oid: string) {
	e.preventDefault();
	const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy SHA",
				action: () => {
					void copySha(oid);
				},
			}),
		],
	});
	await menu.popup();
}
</script>

<div class="commit-author">
	<div class="identity">
		<Avatar name={authorName} size={22} />
		<div class="names">
			<span class="name">{authorName}</span>
			<span class="email">{authorEmail}</span>
		</div>
		<span class="date">{authorDate}</span>
	</div>
	{#if parentOids.length > 0 || childOids.length > 0}
		<div class="topo">
			{#if childOids.length > 0}
				<div class="topo-row">
					<span class="topo-lbl"
						>{childOids.length > 1 ? 'Children' : 'Child'}</span
					>
					{#each childOids as childOid (childOid)}
						<Chip
							title="Go to child {childOid.slice(0, 7)} (right-click to copy SHA)"
							onclick={() => onnavigate?.(childOid)}
							oncontextmenu={(e) => showShaContextMenu(e, childOid)}
							><ArrowUp size={11} />{childOid.slice(0, 7)}</Chip
						>
					{/each}
				</div>
			{/if}
			{#if parentOids.length > 0}
				<div class="topo-row">
					<span class="topo-lbl"
						>{parentOids.length > 1 ? 'Parents' : 'Parent'}</span
					>
					{#each parentOids as parentOid, i (parentOid)}
						<Chip
							tone={i === 0 ? "accent" : "neutral"}
							title="Go to parent {parentOid.slice(0, 7)} (right-click to copy SHA)"
							onclick={() => onnavigate?.(parentOid)}
							oncontextmenu={(e) => showShaContextMenu(e, parentOid)}
							><ArrowDown size={11} />{parentOid.slice(0, 7)}</Chip
						>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
.commit-author {
	padding: var(--space-2) var(--space-3);
	border-bottom: 1px solid var(--color-border);
	font-size: var(--text-small);
	color: var(--color-text-muted);
}
.identity {
	display: flex;
	align-items: center;
	gap: var(--space-3);
}
.names {
	display: flex;
	flex-direction: column;
	min-width: 0;
}
.name {
	color: var(--color-text-strong);
	font-weight: var(--weight-semibold);
}
.email {
	color: var(--color-text-subtle);
	font-family: var(--font-mono);
	font-size: var(--text-small);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.date {
	margin-left: auto;
	flex-shrink: 0;
	color: var(--color-text-subtle);
	font-family: var(--font-mono);
	font-size: var(--text-small);
}

.topo {
	margin-top: var(--space-2);
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
}
.topo-row {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	flex-wrap: wrap;
}
.topo-lbl {
	font-size: var(--text-caption);
	color: var(--color-text-subtle);
	text-transform: uppercase;
	letter-spacing: var(--tracking-wider);
	width: calc(31 * var(--u) / 2);
	flex-shrink: 0;
}
</style>
