<script lang="ts">
import Button from "../lib/ui/Button.svelte";
import Dialog from "../lib/ui/Dialog.svelte";

interface Props {
	title: string;
}

let { title }: Props = $props();

let isOpen = $state(false);
let text = $state("");
let resolveFn: ((value: string | null) => void) | null = null;

export function open(defaultValue: string): Promise<string | null> {
	// Resolve any in-flight promise before reassigning the slot — otherwise a
	// second open() leaks the first resolver and the caller awaits forever.
	resolveFn?.(null);
	text = defaultValue;
	isOpen = true;
	return new Promise((resolve) => {
		resolveFn = resolve;
	});
}

function close(result: string | null) {
	if (!isOpen) return;
	isOpen = false;
	const resolver = resolveFn;
	resolveFn = null;
	resolver?.(result);
}

function handleSubmit() {
	close(text.trim().length === 0 ? null : text);
}

function handleCancel() {
	close(null);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		handleCancel();
	} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		handleSubmit();
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}
</script>

{#if isOpen}
	<Dialog
		{title}
		size="md"
		data-testid="message-editor"
		oncancel={handleCancel}
	>
		<textarea
			class="w-full rounded text-body"
			style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text); padding: var(--space-2); resize: vertical; min-height: 200px;"
			bind:value={text}
			onkeydown={handleKeydown}
			use:autofocus
		></textarea>

		<div class="flex justify-end gap-2 mt-4">
			<Button onclick={handleCancel}>Cancel</Button>
			<Button variant="primary" onclick={handleSubmit}>Save</Button>
		</div>
	</Dialog>
{/if}
