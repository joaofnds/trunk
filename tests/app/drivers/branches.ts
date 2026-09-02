import type { FakeMenu } from "../fakes/menu.js";
import { waitFor } from "../harness/wait.js";
import { firstMatching, openContextMenu } from "./dom.js";

const BRANCH_ROW = '[data-testid="branch-row"]';
const ROW_BUTTON = '[role="button"]';
const CREATE_BUTTON = '[aria-label="Create new branch"]';
const CREATE_INPUT = '[data-testid="branch-create-input"]';
const ROW_VISIBILITY = '[data-testid="branch-row-visibility-btn"]';
const SECTION_VISIBILITY = '[data-testid="branch-section-visibility-btn"]';

/** The branch sidebar, in the gestures it offers: a double-click checks a
 *  branch out, and a refusal shows under the row it was aimed at. */
export class BranchesDriver {
	constructor(private readonly menu: FakeMenu) {}

	/** Right-clicks a branch, returning once the menu it opens is on screen. */
	async contextMenu(name: string): Promise<void> {
		const row = await waitFor(`the ${name} branch row`, () => branchRow(name));
		const target = row.querySelector(ROW_BUTTON);
		if (!target) throw new Error(`the ${name} branch row offers no control`);

		await openContextMenu(target, this.menu, name);
	}

	/** Creates a branch through the sidebar's + affordance: the input it opens,
	 *  the name typed into it, and the Enter that submits. */
	async create(name: string): Promise<void> {
		const plus = await waitFor("the create-branch button", () =>
			document.querySelector<HTMLButtonElement>(CREATE_BUTTON),
		);
		plus.click();

		const input = await waitFor("the create-branch input", () =>
			document.querySelector<HTMLInputElement>(CREATE_INPUT),
		);
		input.value = name;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
	}

	/** Whether the sidebar is listing `name` right now. */
	lists(name: string): boolean {
		return branchRow(name) !== null;
	}

	async checkout(name: string): Promise<void> {
		const row = await waitFor(`the ${name} branch row`, () => branchRow(name));
		const target = row.querySelector(ROW_BUTTON);

		target?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	}

	/** The branch the sidebar tags HEAD, or null while none carries the tag —
	 *  a stopped rebase detaches HEAD and the tag disappears with it. */
	headBranch(): string | null {
		const row = firstMatching(BRANCH_ROW, (text) => text.endsWith("HEAD"));

		return row?.textContent?.trim().split(/\s/)[0] ?? null;
	}

	/** What the sidebar is telling the user about `name`, or null while it is
	 *  telling them nothing. */
	refusal(name: string): string | null {
		const banner = branchRow(name)?.querySelector(".error-banner");
		return banner?.textContent?.trim() ?? null;
	}

	/** Clicks the eye on a branch row, hiding it from the graph or showing it
	 *  again. The row reveals the control on hover, so this enters it first. */
	async toggleVisibility(name: string): Promise<void> {
		const row = await waitFor(`the ${name} branch row`, () => branchRow(name));
		row
			.querySelector(ROW_BUTTON)
			?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

		const eye = await waitFor(`the eye on ${name}`, () =>
			row.querySelector<HTMLButtonElement>(ROW_VISIBILITY),
		);
		eye.click();
	}

	/** Whether the sidebar is marking `name` as hidden from the graph. */
	isHidden(name: string): boolean {
		return branchRow(name)?.dataset.hidden === "true";
	}

	/** Whether `name` offers a visibility toggle at all. HEAD's branch does not. */
	offersVisibilityToggle(name: string): boolean {
		const row = branchRow(name);
		if (!row) return false;
		row
			.querySelector(ROW_BUTTON)
			?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

		return row.querySelector(ROW_VISIBILITY) !== null;
	}

	/** Clicks the eye on a section header, hiding or showing every row under it. */
	async toggleSectionVisibility(label: string): Promise<void> {
		const button = await waitFor(`the eye on the ${label} section`, () => {
			const buttons =
				document.querySelectorAll<HTMLButtonElement>(SECTION_VISIBILITY);

			return (
				[...buttons].find((b) =>
					b.getAttribute("aria-label")?.includes(`all ${label} refs`),
				) ?? null
			);
		});
		button.click();
	}
}

function branchRow(name: string): HTMLElement | null {
	return firstMatching(BRANCH_ROW, (text) => text.startsWith(name));
}
