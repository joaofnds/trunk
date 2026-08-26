import { waitFor } from "../harness/wait.js";
import { firstMatching } from "./dom.js";

const BRANCH_ROW = '[data-testid="branch-row"]';

/** The branch sidebar, in the gestures it offers: a double-click checks a
 *  branch out, and a refusal shows under the row it was aimed at. */
export class BranchesDriver {
	async checkout(name: string): Promise<void> {
		const row = await waitFor(`the ${name} branch row`, () => branchRow(name));
		const target = row.querySelector('[role="button"]');

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
