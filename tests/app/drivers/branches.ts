import type { FakeMenu } from "../fakes/menu.js";
import { waitFor } from "../harness/wait.js";
import { firstMatching, openContextMenu } from "./dom.js";

const BRANCH_ROW = '[data-testid="branch-row"]';
const ROW_BUTTON = '[role="button"]';

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

	async checkout(name: string): Promise<void> {
		const row = await waitFor(`the ${name} branch row`, () => branchRow(name));
		const target = row.querySelector(ROW_BUTTON);

		target?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
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
