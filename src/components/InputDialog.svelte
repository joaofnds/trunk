<script lang="ts">
interface Field {
	key: string;
	label: string;
	placeholder?: string;
	multiline?: boolean;
	required?: boolean;
	defaultValue?: string;
}

interface Props {
	title: string;
	fields: Field[];
	onsubmit: (values: Record<string, string>) => void;
	oncancel: () => void;
	confirmLabel?: string;
	cancelLabel?: string;
}

import { untrack } from "svelte";
import Button from "../lib/ui/Button.svelte";
import Dialog from "../lib/ui/Dialog.svelte";

let {
	title,
	fields,
	onsubmit,
	oncancel,
	confirmLabel = "OK",
	cancelLabel = "Cancel",
}: Props = $props();

let values = $state<Record<string, string>>({});

// Initialize values when fields change (untrack values to avoid feedback loop)
$effect(() => {
	// Track fields as dependency
	const currentFields = fields;
	// Read values without creating dependency
	const currentValues = untrack(() => values);
	const init: Record<string, string> = {};
	for (const field of currentFields) {
		init[field.key] = currentValues[field.key] ?? field.defaultValue ?? "";
	}
	values = init;
});

const canSubmit = $derived(
	fields
		.filter((f) => f.required)
		.every((f) => (values[f.key] ?? "").trim().length > 0),
);

function handleSubmit() {
	if (!canSubmit) return;
	onsubmit(values);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		oncancel();
	} else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
		e.preventDefault();
		handleSubmit();
	}
}

function autofocus(node: HTMLElement) {
	node.focus();
}
</script>

<Dialog {title} {oncancel}>
	{#each fields as field, i}
		<div class="mb-3">
			<label
				for="input-dialog-{field.key}"
				class="block text-callout mb-1 text-text-muted"
			>
				{field.label}
				{#if field.required}
					<span class="text-accent"> *</span>
				{/if}
			</label>
			{#if field.multiline}
				{#if i === 0}
					<textarea
						id="input-dialog-{field.key}"
						class="w-full rounded text-body leading-normal bg-bg border border-border text-text p-2 resize-y field-textarea"
						placeholder={field.placeholder ?? ''}
						bind:value={values[field.key]}
						onkeydown={handleKeydown}
						use:autofocus
					></textarea>
				{:else}
					<textarea
						id="input-dialog-{field.key}"
						class="w-full rounded text-body leading-normal bg-bg border border-border text-text p-2 resize-y field-textarea"
						placeholder={field.placeholder ?? ''}
						bind:value={values[field.key]}
						onkeydown={handleKeydown}
					></textarea>
				{/if}
			{:else}
				{#if i === 0}
					<input
						id="input-dialog-{field.key}"
						type="text"
						class="w-full rounded text-body bg-bg border border-border text-text p-2"
						placeholder={field.placeholder ?? ''}
						bind:value={values[field.key]}
						onkeydown={handleKeydown}
						use:autofocus
					>
				{:else}
					<input
						id="input-dialog-{field.key}"
						type="text"
						class="w-full rounded text-body bg-bg border border-border text-text p-2"
						placeholder={field.placeholder ?? ''}
						bind:value={values[field.key]}
						onkeydown={handleKeydown}
					>
				{/if}
			{/if}
		</div>
	{/each}

	<div class="flex justify-end gap-2 mt-4">
		<Button onclick={oncancel}>{cancelLabel}</Button>
		<Button variant="primary" disabled={!canSubmit} onclick={handleSubmit}>
			{confirmLabel}
		</Button>
	</div>
</Dialog>

<style>
.field-textarea {
	min-height: calc(15 * var(--u));
}
</style>
