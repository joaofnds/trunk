<script lang="ts">
import { deleteThread, editThread } from "../../lib/review-comment-actions.js";
import type { ThreadEditorSession } from "../../lib/review-editors.svelte.js";
import type { ThreadFolds } from "../../lib/thread-folds.svelte.js";
import type { Thread } from "../../lib/types.js";
import ThreadCard from "../ThreadCard.svelte";

// A thread as every diff view draws it among the lines, and under the note of a
// file with no changes, so the views cannot draw it differently.
interface Props {
	thread: Thread;
	repoPath: string;
	/** Which threads are folded, shared with the views the diff switches to. */
	folds: ThreadFolds;
	editorSessionForThread?: (thread: Thread) => ThreadEditorSession;
}

let { thread, repoPath, folds, editorSessionForThread }: Props = $props();
</script>

<ThreadCard
	variant="inline"
	confirmDelete={false}
	{thread}
	{folds}
	{repoPath}
	onedit={(id, text) => editThread(repoPath, id, text)}
	ondelete={(id) => deleteThread(repoPath, id)}
	{editorSessionForThread}
/>
