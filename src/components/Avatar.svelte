<script lang="ts">
import { initials } from "../lib/initials.js";

interface Props {
	name: string;
	/** Diameter in px. */
	size?: number;
}

let { name, size = 18 }: Props = $props();
</script>

<span
  class="avatar"
  aria-hidden="true"
  style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.5)}px;"
>{initials(name)}</span>

<style>
	.avatar {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-pill);
		background: var(--bg-3);
		color: var(--fg-0);
		box-shadow: inset 0 0 0 1px var(--line);
		font-family: var(--font-sans);
		font-weight: 600;
		letter-spacing: 0.02em;
		line-height: 1;
		user-select: none;
	}
</style>
