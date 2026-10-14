<script lang="ts">
// A card drawn under a panel's visibility context, without the panel, so a
// test can tell which variants of the card the context watches.
import ThreadCard from "../../components/ThreadCard.svelte";
import {
	provideReviewVisibility,
	type ReviewVisibility,
} from "../../lib/review-visibility.svelte.js";
import type { Thread } from "../../lib/types.js";

interface Props {
	visibility: ReviewVisibility;
	thread: Thread;
	variant: "panel" | "inline";
}

let { visibility, thread, variant }: Props = $props();

// The context is set once at mount, as the panel sets its own.
// svelte-ignore state_referenced_locally
provideReviewVisibility(visibility);
</script>

<ThreadCard
	{thread}
	{variant}
	repoPath="/repo"
	onedit={() => {}}
	ondelete={() => {}}
/>
