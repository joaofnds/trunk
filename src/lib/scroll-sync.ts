// Horizontal scroll-sync for side-by-side columns: every column registered with
// the returned action mirrors its scrollLeft to all the others, so hidden-
// scrollbar columns pan as one. Factory (not a module-level set) so each view
// instance syncs only its own columns.
export function createHorizontalScrollSync() {
	const cols: Set<HTMLElement> = new Set();
	const written = new WeakMap<HTMLElement, number>();
	let syncing = false;

	return function sync(node: HTMLElement) {
		cols.add(node);

		function onScroll() {
			if (syncing) return;
			// The scroll event for an offset this sync wrote arrives a frame later,
			// when the column it came from may have moved on. Mirrored back, it
			// drags that column to where it was, and every per-frame scroll stalls.
			if (written.get(node) === node.scrollLeft) return;

			syncing = true;
			const { scrollLeft } = node;
			for (const col of cols) {
				if (col === node) continue;
				col.scrollLeft = scrollLeft;
				written.set(col, col.scrollLeft);
			}
			syncing = false;
		}

		node.addEventListener("scroll", onScroll);

		return {
			destroy() {
				node.removeEventListener("scroll", onScroll);
				cols.delete(node);
			},
		};
	};
}
