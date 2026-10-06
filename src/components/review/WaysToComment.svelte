<script lang="ts">
import File from "@lucide/svelte/icons/file";
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import MessageSquare from "@lucide/svelte/icons/message-square";
</script>

<!-- The three places a comment can start, for a panel that has none yet. -->
<ul
	aria-label="Ways to comment"
	class="review-ways flex flex-col list-none mt-2 mb-0 p-0 rounded border border-border bg-surface-raised"
>
	<li class="flex items-center gap-2 h-row px-3 text-callout text-text">
		<MessageSquare size={13} class="text-text-subtle" aria-hidden="true" />
		Comment on selected diff lines
	</li>
	<li class="flex items-center gap-2 h-row px-3 text-callout text-text">
		<GitCommitHorizontal
			size={13}
			class="text-text-subtle"
			aria-hidden="true"
		/>
		Note on a whole commit
	</li>
	<li class="flex items-center gap-2 h-row px-3 text-callout text-text">
		<File size={13} class="text-text-subtle" aria-hidden="true" />
		Comment on any tracked file
	</li>
</ul>

<style>
.review-ways li + li {
	border-top: 1px solid var(--color-border);
}
</style>
