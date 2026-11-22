<script lang="ts">
import type { DiffRow } from "../../lib/diff-rows.js";
import Row from "../../lib/ui/Row.svelte";
import FilePathLabel from "../FilePathLabel.svelte";

interface Props {
	item: Extract<DiffRow, { kind: "file-header" }>;
	ontoggle: (path: string) => void;
}

let { item, ontoggle }: Props = $props();
</script>

<div class="file-header">
	<Row
		variant="title"
		aria-label={item.oldPath ? `${item.oldPath} → ${item.path}` : item.path}
		aria-expanded={!item.collapsed}
		onclick={() => ontoggle(item.path)}
	>
		<span class="caret shrink-0 text-caption text-text-muted" aria-hidden="true"
			>{item.collapsed ? "▶" : "▼"}</span
		>
		<FilePathLabel path={item.path} oldPath={item.oldPath} />
	</Row>
</div>

<style>
.file-header {
	height: var(--diff-file-header-height);
}

.caret {
	width: calc(5 * var(--u) / 2);
}
</style>
