import type { FakeMenu } from "../fakes/menu.js";
import { waitFor } from "../harness/wait.js";
import { firstMatching, openContextMenu } from "./dom.js";

const BRANCH_ROW = '[data-testid="branch-row"]';
const ROW_BUTTON = '[role="button"]';
const CREATE_BUTTON = '[aria-label="Create new branch"]';
const CREATE_INPUT = '[data-testid="branch-create-input"]';

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
}

function branchRow(name: string): HTMLElement | null {
	return firstMatching(BRANCH_ROW, (text) => text.startsWith(name));
}
