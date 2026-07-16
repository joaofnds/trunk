// Horizontal scroll-sync for side-by-side columns: every column registered with
// the returned action mirrors its scrollLeft to all the others, so hidden-
// scrollbar columns pan as one. Factory (not a module-level set) so each view
// instance syncs only its own columns.
export function createHorizontalScrollSync() {
	const cols: Set<HTMLElement> = new Set();
	let syncing = false;

	return function sync(node: HTMLElement) {
		cols.add(node);

		function onScroll() {
			if (syncing) return;
			syncing = true;
			const { scrollLeft } = node;
			for (const col of cols) {
				if (col !== node) col.scrollLeft = scrollLeft;
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
