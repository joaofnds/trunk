import { exactLabel } from "./relative-time.js";
import { tooltip } from "./tooltip.js";

// A relative date carries its exact date two ways: visually through the shared
// tooltip action, and as the trigger's aria-label, since tooltip.ts is visual
// only by its own contract. This action keeps that pairing one concept at the
// call sites: `use:exactDate={tsSeconds}`.
export function exactDate(
	node: HTMLElement,
	tsSeconds: number,
): { update(next: number): void; destroy(): void } {
	function label(ts: number): string {
		const text = exactLabel(ts);
		if (text) node.setAttribute("aria-label", text);
		else node.removeAttribute("aria-label");
		return text;
	}

	const pop = tooltip(node, label(tsSeconds));
	return {
		update(next: number) {
			pop.update(label(next));
		},
		destroy: pop.destroy,
	};
}
