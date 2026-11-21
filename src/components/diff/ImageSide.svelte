<script lang="ts">
import { formatSize } from "../../lib/binary-file.js";

interface Props {
	label: string;
	url: string;
	/** The file's size in bytes on this side, or null where it was not read. */
	size: number | null;
}

let { label, url, size }: Props = $props();

type Drawn =
	| { url: string; width: number; height: number }
	| { url: string; failed: true };

let drawn = $state<Drawn | null>(null);

const current = $derived(drawn?.url === url ? drawn : null);
const failed = $derived(current !== null && "failed" in current);
const details = $derived(
	[
		current && "width" in current
			? `${current.width} × ${current.height} pixels`
			: null,
		size === null ? null : formatSize(size),
	]
		.filter((part) => part !== null)
		.join(", "),
);

const captionId = $props.id();

function measures(source: string) {
	return (image: HTMLImageElement) => {
		const loaded = () => {
			drawn = {
				url: source,
				width: image.naturalWidth,
				height: image.naturalHeight,
			};
		};
		const broken = () => {
			drawn = { url: source, failed: true };
		};
		image.addEventListener("load", loaded);
		image.addEventListener("error", broken);
		return () => {
			image.removeEventListener("load", loaded);
			image.removeEventListener("error", broken);
		};
	};
}
</script>

<figure class="m-0 flex min-w-0 flex-col gap-2" aria-labelledby={captionId}>
	<figcaption
		id={captionId}
		class="flex items-baseline justify-between gap-2 text-callout"
	>
		<span class="font-medium text-text-strong">{label}</span>
		<span class="text-text-muted">{details}</span>
	</figcaption>
	<div
		class="flex flex-1 items-center justify-center rounded border border-border bg-surface-raised p-4"
	>
		<img
			src={url}
			alt={label}
			class="max-w-full"
			hidden={failed}
			{@attach measures(url)}
		>
		{#if failed}
			<p class="m-0 text-body text-text-muted"
				>This image cannot be previewed</p
			>
		{/if}
	</div>
</figure>
