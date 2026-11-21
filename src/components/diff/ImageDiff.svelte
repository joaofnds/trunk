<script lang="ts">
import { assetUrl } from "../../lib/binary-file.js";
import type { RevSpec } from "../../lib/rev-spec.js";
import type { FileDiff } from "../../lib/types.js";
import ImageSide from "./ImageSide.svelte";

interface Props {
	repoPath: string;
	file: FileDiff;
	/** Null for a file opened on its own, which has no other side. */
	before: RevSpec | null;
	after: RevSpec;
	/** Changes on each refresh. It versions a side whose content has no id. */
	version: number;
}

let { repoPath, file, before, after, version }: Props = $props();

const beforeSide = $derived(
	file.status === "Added" || file.status === "Untracked" ? null : before,
);
const hasAfter = $derived(file.status !== "Deleted");
</script>

<div class="h-full overflow-auto p-4">
	<div class="grid gap-4" class:grid-cols-2={beforeSide !== null && hasAfter}>
		{#if beforeSide !== null}
			<ImageSide
				label="Before"
				url={assetUrl({
					repo: repoPath,
					rev: beforeSide,
					path: file.old_path ?? file.path,
					version: file.old_id ?? version,
				})}
				size={file.old_size}
			/>
		{/if}
		{#if hasAfter}
			<ImageSide
				label={before === null ? "Current" : "After"}
				url={assetUrl({
					repo: repoPath,
					rev: after,
					path: file.path,
					version: file.new_id ?? version,
				})}
				size={file.new_size}
			/>
		{/if}
	</div>
</div>
