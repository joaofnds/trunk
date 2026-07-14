import { openUrl } from "@tauri-apps/plugin-opener";

// Svelte action for rendered-markdown containers ({@html} output). A single
// delegated click listener intercepts clicks landing on an <a>, cancels the
// in-app navigation, and hands external URLs to the OS browser via the opener.
// This is the render-layer link handling of the four-layer security stack
// (grill §3.4); the Rust `on_navigation` guard is the authoritative backstop.
export function externalLinks(node: HTMLElement) {
	function handler(event: MouseEvent) {
		const anchor = (event.target as HTMLElement | null)?.closest("a");
		const href = anchor?.getAttribute("href");
		if (!href) return;
		// In-page anchors keep their default scroll behavior.
		if (href.startsWith("#")) return;
		event.preventDefault();
		if (/^(https?|mailto|tel):/i.test(href)) {
			openUrl(href).catch(() => {});
		}
	}
	node.addEventListener("click", handler);
	return {
		destroy() {
			node.removeEventListener("click", handler);
		},
	};
}
