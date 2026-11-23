import type { FakeMenu } from "../fakes/menu.js";
import { waitFor } from "../harness/wait.js";
import { openContextMenu, pressButton } from "./dom.js";

/** The three-panel conflict editor a conflicted file's row opens onto. */
export class MergeEditorDriver {
	constructor(private readonly menu: FakeMenu) {}

	async fileContextMenu(path: string): Promise<void> {
		const button = await waitFor("the merge filename", () =>
			document.querySelector<HTMLButtonElement>(
				`button[aria-label="${CSS.escape(`Path actions for ${path}`)}"]`,
			),
		);
		await openContextMenu(button, this.menu, path);
	}

	wrapsOutput(): boolean {
		return (
			document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Merge output"]',
			)?.wrap === "soft"
		);
	}

	async toggleWordWrap(): Promise<void> {
		const control = await waitFor("the merge wrap control", () =>
			document.querySelector<HTMLButtonElement>(
				'button[aria-label="Toggle word wrap"]:not(:disabled)',
			),
		);
		control.click();
	}

	async typeOutput(text: string): Promise<void> {
		const output = await waitFor("editable merge output", () =>
			document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Merge output"]:not([readonly])',
			),
		);
		output.value = text;
		output.dispatchEvent(new Event("input", { bubbles: true }));
	}

	async close(): Promise<void> {
		const close = await waitFor("the merge editor close button", () =>
			document.querySelector<HTMLButtonElement>(
				'button[aria-label="Close merge editor"]',
			),
		);
		close.click();
	}

	recoveredOutput(): string | null {
		return (
			document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Previous merge draft"]',
			)?.value ?? null
		);
	}

	async recover(path: string): Promise<void> {
		await pressButton(`Recover draft for ${path}`);
	}

	/** Takes the incoming side of every conflict. */
	async takeAllIncoming(): Promise<void> {
		await pressButton("Take All Incoming");
	}

	/** Takes the current side of every conflict. */
	async takeAllCurrent(): Promise<void> {
		await pressButton("Take All Current");
	}

	/** Saves the assembled result and marks the file resolved. */
	async saveAndResolve(): Promise<void> {
		await pressButton("Save and Mark Resolved");
	}

	isShowing(): boolean {
		return (
			document.querySelector('section[aria-label="Merge editor"]') !== null
		);
	}
}
