<script lang="ts">
import Pilcrow from "@lucide/svelte/icons/pilcrow";
import TextWrap from "@lucide/svelte/icons/text-wrap";
import Button from "../../lib/ui/Button.svelte";

interface Props {
	joined?: boolean;
	showLabels?: boolean;
	showInvisibles: boolean;
	wordWrap: boolean;
	fixedPitch: boolean;
	renderedActive?: boolean;
	onshowinvisibleschange: (show: boolean) => void;
	onwordwrapchange: (wrap: boolean) => void;
}

let {
	joined = false,
	showLabels = false,
	showInvisibles,
	wordWrap,
	fixedPitch,
	renderedActive = false,
	onshowinvisibleschange,
	onwordwrapchange,
}: Props = $props();
</script>

<Button
	{joined}
	icon={!showLabels}
	size={joined ? "base" : "sm"}
	variant={joined ? "secondary" : "ghost"}
	aria-label="Show invisible characters"
	aria-pressed={showInvisibles}
	disabled={renderedActive}
	title={renderedActive
		? "Invisible characters aren't rendered in preview"
		: "Show invisible characters"}
	onclick={() => onshowinvisibleschange(!showInvisibles)}
	><Pilcrow size={14} />
	{#if showLabels}
		Invisible characters
	{/if}</Button
>
<Button
	{joined}
	icon={!showLabels}
	size={joined ? "base" : "sm"}
	variant={joined ? "secondary" : "ghost"}
	aria-label="Toggle word wrap"
	aria-pressed={wordWrap && fixedPitch}
	disabled={!fixedPitch}
	title={fixedPitch
		? "Toggle word wrap"
		: "Word wrap needs a fixed-pitch diff font"}
	onclick={() => onwordwrapchange(!wordWrap)}
	><TextWrap size={14} />
	{#if showLabels}
		Word wrap
	{/if}</Button
>
