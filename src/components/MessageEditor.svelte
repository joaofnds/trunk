<script lang="ts">
interface Props {
	title: string;
}

let { title }: Props = $props();

let dialogEl: HTMLDialogElement | undefined = $state();
let isOpen = $state(false);
let text = $state("");
let resolveFn: ((value: string | null) => void) | null = null;
const titleId = `message-editor-title-${crypto.randomUUID()}`;

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

function handleBackdropClick(e: MouseEvent) {
	if (e.target === dialogEl) {
		handleCancel();
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}

$effect(() => {
	if (isOpen && dialogEl && !dialogEl.open) {
		dialogEl.showModal();
	}
});
</script>

{#if isOpen}
	<dialog
		bind:this={dialogEl}
		class="rounded"
		data-testid="message-editor-backdrop"
		aria-labelledby={titleId}
		style="background: var(--bg-2); border: 1px solid var(--line); box-shadow: var(--shadow-2); min-width: 420px; max-width: 640px; padding: var(--space-4);"
		onkeydown={handleKeydown}
		onclick={handleBackdropClick}
	>
		<h3
			id={titleId}
			class="text-sm font-semibold mb-3"
			style="color: var(--color-text);"
		>
			{title}
		</h3>

		<textarea
			class="w-full rounded text-sm"
			style="background: var(--bg-0); border: 1px solid var(--line); color: var(--fg-1); padding: var(--space-2); resize: vertical; min-height: 200px;"
			bind:value={text}
			use:autofocus
		></textarea>

		<div class="flex justify-end gap-2 mt-4">
			<button
				class="rounded px-3 py-1.5 text-xs font-medium"
				style="background: var(--bg-3); border: 1px solid var(--line); color: var(--fg-1);"
				onclick={handleCancel}
			>
				Cancel
			</button>
			<button
				class="rounded px-3 py-1.5 text-xs font-medium"
				style="background: var(--color-accent); color: var(--color-on-accent);"
				onclick={handleSubmit}
			>
				Save
			</button>
		</div>
	</dialog>
{/if}

<style>
	/* Restore native modal centering: the UA `dialog:modal { margin: auto }`
	   default is wiped by Tailwind v4 preflight's universal `margin: 0` reset,
	   which collapses the dialog to the viewport's top-left corner. Re-state the
	   centering recipe explicitly (fit-content box + inset:0 + auto margins). */
	dialog {
		position: fixed;
		inset: 0;
		width: fit-content;
		height: fit-content;
		margin: auto;
	}

	dialog::backdrop {
		background: var(--color-backdrop);
	}
</style>
