<script lang="ts" generics="Match">
import { findScope } from "../lib/find-scope.js";
import type { FoundMatches } from "../lib/literal-pattern.js";
import SearchBar from "./SearchBar.svelte";

interface Props {
	placeholder: string;
	matches: (query: string) => FoundMatches<Match>;
	onclose: (match: Match | undefined) => void;
}

let { placeholder, matches, onclose }: Props = $props();
let open = $state(false);
let bar = $state<SearchBar>();
let query = $state("");
let ordinal = $state(0);
const results = $derived(open && query ? matches(query) : []);
const index = $derived(Math.min(ordinal, Math.max(0, results.length - 1)));
const match = $derived(results.at(index));

export function currentMatch(): Match | undefined {
	return match;
}

export function openFind() {
	if (open) {
		bar?.focusQuery();
		return;
	}
	changeQuery("");
	open = true;
}

function changeQuery(value: string) {
	query = value;
	ordinal = 0;
}

function step(delta: number) {
	if (results.length)
		ordinal = (index + delta + results.length) % results.length;
}

export function closeFind(): boolean {
	if (!open) return false;
	const current = currentMatch();
	open = false;
	onclose(current);
	return true;
}
</script>

{#if open}
	<div class="shrink-0" {@attach findScope(openFind)}>
		<SearchBar
			bind:this={bar}
			{placeholder}
			inline
			animate={false}
			{query}
			currentIndex={index}
			totalMatches={results.length}
			searching={false}
			onquerychange={changeQuery}
			onprev={() => step(-1)}
			onnext={() => step(1)}
			onclose={closeFind}
		/>
	</div>
{/if}
