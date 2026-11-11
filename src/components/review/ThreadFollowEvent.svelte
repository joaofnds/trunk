<script lang="ts">
// A thread's move onto the rewritten copy of its commit, set between the
// replies it came between: the commit it left, the copy it moved to, and how
// long ago. The app moved it, so no author leads it.

import GitCommitVertical from "@lucide/svelte/icons/git-commit-vertical";
import { currentMinute } from "../../lib/now.svelte.js";
import { compactLabel, exactLabel } from "../../lib/relative-time.js";
import type { ThreadFollow } from "../../lib/types.js";
import Badge from "../../lib/ui/Badge.svelte";

interface Props {
	follow: ThreadFollow;
}

let { follow }: Props = $props();
</script>

<div
	class="flex h-control items-center gap-2 overflow-hidden whitespace-nowrap px-3 text-small text-text-muted"
>
	<span class="inline-flex w-control-sm shrink-0 justify-center">
		<GitCommitVertical size={12} aria-hidden="true" />
	</span>
	<span>Followed its commit from</span>
	<Badge variant="label" title={follow.from}>{follow.from.slice(0, 7)}</Badge>
	<span>to</span>
	<Badge variant="label" title={follow.to}>{follow.to.slice(0, 7)}</Badge>
	<time
		class="shrink-0 font-mono text-caption text-text-subtle"
		title={exactLabel(follow.created_at)}
		>· {compactLabel(follow.created_at, currentMinute())}</time
	>
</div>
