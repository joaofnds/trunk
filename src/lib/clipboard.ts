import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showToast } from "./toast.svelte.js";

/** Copy a commit SHA to the clipboard and confirm via toast.
 *  Always copies the full oid, even when only a short form is shown on screen. */
export async function copySha(oid: string): Promise<void> {
	await copy({ text: oid, shown: oid.slice(0, 7) });
}

export async function copyRefName(name: string): Promise<void> {
	await copy({ text: name, shown: name });
}

async function copy({
	text,
	shown,
}: {
	text: string;
	shown: string;
}): Promise<void> {
	try {
		await writeText(text);
		showToast(`Copied ${shown}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		showToast(`Failed to copy: ${message}`, "error");
	}
}
