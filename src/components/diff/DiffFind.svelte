<script lang="ts">
import { untrack } from "svelte";
import { findDiffMatches } from "../../lib/diff-find.js";
import type { DiffNav } from "../../lib/diff-nav.js";
import { focusInEditable, keyChord, keyInDialog } from "../../lib/keyboard.js";
import SearchBar from "../SearchBar.svelte";

interface Props {
	source: DiffNav | null;
	subject: string;
	enabled: boolean;
	focusDiff: () => void;
}

let { source, subject, enabled, focusDiff }: Props = $props();
let open = $derived.by(() => {
	void subject;
	void enabled;
	return false;
});
let bar = $state<SearchBar | null>(null);
let previousFocus: HTMLElement | null = null;
let query = $state("");
let ordinal = $state(0);
const results = $derived(
	open && enabled && source && query
		? findDiffMatches(source.searchRows(), query)
		: null,
);
const total = $derived(results?.length ?? 0);
const index = $derived(Math.min(ordinal, Math.max(0, total - 1)));
const match = $derived(results?.at(index) ?? null);
const row = $derived(match?.row);
const side = $derived(match?.side);
const start = $derived(match?.start);
const end = $derived(match?.end);

export function currentMatch() {
	return match;
}

export function openFind() {
	if (!enabled || !source) return;

	if (open) {
		bar?.focusQuery();
		return;
	}

	previousFocus =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	changeQuery("");
	open = true;
}

$effect(() => {
	void side;
	void start;
	void end;
	if (row === undefined || !source?.isReady()) return;

	const target = source;
	const targetRow = row;
	untrack(() => target.revealSearchRow(targetRow, avoidCoveringMatch));
});

function avoidCoveringMatch(mark: HTMLElement) {
	bar?.avoidCovering(mark, mark.closest(".split-window"));
}

function changeQuery(value: string) {
	query = value;
	ordinal = 0;
}

function step(direction: number) {
	if (total === 1 && match)
		source?.revealSearchRow(match.row, avoidCoveringMatch);
	else if (total > 1) ordinal = (index + direction + total) % total;
}

function close() {
	open = false;
	if (previousFocus?.isConnected && previousFocus !== document.body) {
		previousFocus.focus({ preventScroll: true });
	} else {
		focusDiff();
	}
	previousFocus = null;
}

function handleEscape(event: KeyboardEvent) {
	if (
		!open ||
		event.defaultPrevented ||
		keyChord(event) !== "Escape" ||
		keyInDialog(event) ||
		focusInEditable(document.activeElement)
	)
		return;

	event.preventDefault();
	close();
}
</script>

<svelte:document onkeydowncapture={handleEscape} />

{#if open && enabled}
	<SearchBar
		bind:this={bar}
		placeholder="Find in diff…"
		animate={false}
		{query}
		currentIndex={index}
		totalMatches={total}
		searching={false}
		onquerychange={changeQuery}
		onprev={() => step(-1)}
		onnext={() => step(1)}
		onclose={close}
	/>
{/if}
