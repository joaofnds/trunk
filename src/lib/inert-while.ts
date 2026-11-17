import type { Attachment } from "svelte/attachments";

/** Makes a region inert while it is hidden, and lets go of the focus held in
 *  it, so the keys reach what the user can see rather than a list or a field
 *  nobody can. Not every engine blurs an element that turns inert. */
export function inertWhile(hidden: boolean): Attachment<HTMLElement> {
	return (region) => {
		region.inert = hidden;
		if (!hidden) return;

		const focused = document.activeElement;
		if (focused instanceof HTMLElement && region.contains(focused)) {
			focused.blur();
		}
	};
}
