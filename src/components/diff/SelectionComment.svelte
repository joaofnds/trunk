<script lang="ts" module>
/** The line the selection's Comment action sits on. */
export interface SelectionCommentPlace {
	hunkKey: string;
	lineIndex: number;
}
</script>

<script lang="ts">
// The one control that starts a comment on the selected lines, on the bottom
// edge of the selection's last line. It holds no width in the line, so the
// line's code wraps and measures as it would without it, and it stays inside
// the viewport's right edge while a wide line pans.
import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
import Button from "../../lib/ui/Button.svelte";
import Keycap from "../../lib/ui/Keycap.svelte";

interface Props {
	oncomment: () => void;
}

let { oncomment }: Props = $props();
</script>

<span class="selection-comment-track"
	><span class="selection-comment"
		><Button
			size="sm"
			variant="ghost"
			aria-label="Comment on selected lines"
			aria-keyshortcuts="C"
			onclick={oncomment}
			><MessageSquarePlus size={13} aria-hidden="true" />Comment<Keycap
				>C</Keycap
			></Button
		></span
	></span
>

<style>
/* Sticky against the scrollport's right edge, so a line wider than the view
   keeps its action in reach; with no width and no height it changes nothing
   the row model measured. */
.selection-comment-track {
	position: sticky;
	right: var(--space-4);
	align-self: flex-end;
	width: 0;
	height: 0;
	margin-left: auto;
}
/* Straddles the line's bottom edge, at its right, where it covers the end of
   a line rather than its code. It appears at once, since it shows on every
   selection and a fade would only slow the hand. */
.selection-comment {
	position: absolute;
	right: 0;
	bottom: 0;
	transform: translateY(50%);
	display: inline-flex;
	border-radius: var(--radius);
	background: var(--color-surface-raised);
	border: 1px solid var(--color-border);
	box-shadow: var(--shadow-md);
	font-family: var(--font-sans);
	white-space: nowrap;
	user-select: none;
}
</style>
