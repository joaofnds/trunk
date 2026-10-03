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
	>{initials(name)}</span
>

<style>
.avatar {
	flex-shrink: 0;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: var(--radius-pill);
	background: var(--color-surface-chip);
	color: var(--color-text-strong);
	box-shadow: inset 0 0 0 1px var(--color-border);
	font-family: var(--font-sans);
	font-weight: var(--weight-semibold);
	letter-spacing: 0.02em;
	line-height: var(--leading-none);
	user-select: none;
}
</style>
