<script lang="ts">
import { untrack } from "svelte";
import InputDialog from "../../components/InputDialog.svelte";
import MessageEditor from "../../components/MessageEditor.svelte";
import { provideUpdatePreparation } from "../../lib/updates-context.js";
import type { UpdatePreparation } from "../../lib/updates-lifecycle.js";

let {
	preparation,
	kind,
}: { preparation: UpdatePreparation; kind: "input" | "message" } = $props();
provideUpdatePreparation(untrack(() => preparation));
let message: MessageEditor | undefined = $state();
export function openMessage(): Promise<string | null> {
	if (!message) throw new Error("message editor is not mounted");
	return message.open("unfinished message");
}
</script>

{#if kind === "input"}
	<InputDialog
		title="Rename branch"
		fields={[{ key: "name", label: "Name" }]}
		onsubmit={() => {}}
		oncancel={() => {}}
	/>
{:else}
	<MessageEditor bind:this={message} title="Commit message" />
{/if}
