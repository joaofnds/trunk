<script lang="ts">
  interface Field {
    key: string;
    label: string;
    placeholder?: string;
    multiline?: boolean;
    required?: boolean;
  }

  interface Props {
    title: string;
    fields: Field[];
    onsubmit: (values: Record<string, string>) => void;
    oncancel: () => void;
  }

  let { title, fields, onsubmit, oncancel }: Props = $props();

  let values = $state<Record<string, string>>({});

  // Initialize values for all fields
  $effect(() => {
    const init: Record<string, string> = {};
    for (const field of fields) {
      init[field.key] = values[field.key] ?? '';
    }
    values = init;
  });

  const canSubmit = $derived(
    fields.filter(f => f.required).every(f => (values[f.key] ?? '').trim().length > 0)
  );

  function handleSubmit() {
    if (!canSubmit) return;
    onsubmit(values);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      oncancel();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      oncancel();
    }
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 flex items-center justify-center"
  style="z-index: 9999; background: rgba(0,0,0,0.5);"
  onkeydown={handleKeydown}
  onclick={handleBackdropClick}
>
  <div
    class="rounded-lg shadow-xl"
    style="background: var(--color-surface); border: 1px solid var(--color-border); min-width: 340px; max-width: 480px; padding: 16px;"
  >
    <h3 class="text-sm font-semibold mb-3" style="color: var(--color-text);">{title}</h3>

    {#each fields as field, i}
      <div class="mb-3">
        <label class="block text-xs mb-1" style="color: var(--color-text-muted);">
          {field.label}{#if field.required}<span style="color: var(--color-accent);"> *</span>{/if}
        </label>
        {#if field.multiline}
          {#if i === 0}
            <textarea
              class="w-full rounded text-sm"
              style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text); padding: 6px 8px; resize: vertical; min-height: 60px;"
              placeholder={field.placeholder ?? ''}
              bind:value={values[field.key]}
              use:autofocus
            ></textarea>
          {:else}
            <textarea
              class="w-full rounded text-sm"
              style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text); padding: 6px 8px; resize: vertical; min-height: 60px;"
              placeholder={field.placeholder ?? ''}
              bind:value={values[field.key]}
            ></textarea>
          {/if}
        {:else}
          {#if i === 0}
            <input
              type="text"
              class="w-full rounded text-sm"
              style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text); padding: 6px 8px;"
              placeholder={field.placeholder ?? ''}
              bind:value={values[field.key]}
              use:autofocus
            />
          {:else}
            <input
              type="text"
              class="w-full rounded text-sm"
              style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text); padding: 6px 8px;"
              placeholder={field.placeholder ?? ''}
              bind:value={values[field.key]}
            />
          {/if}
        {/if}
      </div>
    {/each}

    <div class="flex justify-end gap-2 mt-4">
      <button
        class="rounded px-3 py-1.5 text-xs font-medium"
        style="background: var(--color-bg); border: 1px solid var(--color-border); color: var(--color-text);"
        onclick={oncancel}
      >
        Cancel
      </button>
      <button
        class="rounded px-3 py-1.5 text-xs font-medium"
        style="background: var(--color-accent); color: white; opacity: {canSubmit ? '1' : '0.5'};"
        disabled={!canSubmit}
        onclick={handleSubmit}
      >
        OK
      </button>
    </div>
  </div>
</div>
