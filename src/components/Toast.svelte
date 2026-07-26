<script lang="ts">
import { fly } from "svelte/transition";
import { dismissToast, toasts } from "../lib/toast.svelte.js";
</script>

<div class="fixed bottom-4 right-4 flex flex-col gap-2 z-50 pointer-events-none">
  {#each toasts.items as toast (toast.id)}
    <div role="status" transition:fly={{ y: 8, duration: 150 }}>
      <button
        type="button"
        class="toast block w-full text-left px-4 py-2 rounded-lg text-sm font-medium shadow-lg pointer-events-auto"
        class:error={toast.kind === 'error'}
        onclick={() => dismissToast(toast.id)}
      >
        {toast.message}
      </button>
    </div>
  {/each}
</div>

<style>
  .toast {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    cursor: pointer;
  }
  .toast:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .toast.error {
    background: var(--color-toast-error-bg);
    border-color: var(--color-danger-border);
    color: var(--color-danger);
  }
</style>
