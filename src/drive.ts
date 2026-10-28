/**
 * The page half of the drive route (src-tauri/src/drive.rs), loaded only by the
 * drive build. The socket's evaluations arrive here, and their awaited results
 * go back as events, since the webview's own completion handler cannot carry a
 * Promise's result.
 */

import { emit } from "@tauri-apps/api/event";

const READY = "trunk-drive:ready";
const REPLY = "trunk-drive:reply";

interface DriveHooks {
	run(id: number, expression: string): Promise<void>;
	until(expression: string): Promise<unknown>;
}

declare global {
	interface Window {
		__trunkDrive: DriveHooks;
	}
}

function compile(expression: string): () => unknown {
	return new Function(`return (${expression});`) as () => unknown;
}

async function run(id: number, expression: string): Promise<void> {
	try {
		const value = await compile(expression)();
		await emit(REPLY, { id, ok: true, value: value ?? null });
	} catch (error) {
		const message =
			error instanceof Error ? `${error.name}: ${error.message}` : `${error}`;
		await emit(REPLY, { id, ok: false, error: message });
	}
}

/** The first truthy value `expression` takes, re-read after each DOM change. */
function until(expression: string): Promise<unknown> {
	const read = compile(expression);

	return new Promise((resolve) => {
		const observer = new MutationObserver(check);
		function check() {
			const value = read();
			if (!value) return;

			observer.disconnect();
			resolve(value);
		}

		observer.observe(document, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
		});
		check();
	});
}

window.__trunkDrive = { run, until };
void emit(READY);
