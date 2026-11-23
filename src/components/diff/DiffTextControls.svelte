<script lang="ts">
import Pilcrow from "@lucide/svelte/icons/pilcrow";
import TextWrap from "@lucide/svelte/icons/text-wrap";
import Button from "../../lib/ui/Button.svelte";

interface Props {
	showInvisibles: boolean;
	wordWrap: boolean;
	fixedPitch: boolean;
	renderedActive?: boolean;
	onshowinvisibleschange: (show: boolean) => void;
	onwordwrapchange: (wrap: boolean) => void;
}

let {
	showInvisibles,
	wordWrap,
	fixedPitch,
	renderedActive = false,
	onshowinvisibleschange,
	onwordwrapchange,
}: Props = $props();
</script>

<Button
	icon
	size="sm"
	variant="ghost"
	aria-label="Show invisible characters"
	aria-pressed={showInvisibles}
	disabled={renderedActive}
	title={renderedActive
		? "Invisible characters aren't rendered in preview"
		: "Show invisible characters"}
	onclick={() => onshowinvisibleschange(!showInvisibles)}
	><Pilcrow size={14} /></Button
>
<Button
	icon
	size="sm"
	variant="ghost"
	aria-label="Toggle word wrap"
	aria-pressed={wordWrap && fixedPitch}
	disabled={!fixedPitch}
	title={fixedPitch
		? "Toggle word wrap"
		: "Word wrap needs a fixed-pitch diff font"}
	onclick={() => onwordwrapchange(!wordWrap)}
	><TextWrap size={14} /></Button
>
