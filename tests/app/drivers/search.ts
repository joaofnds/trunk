import { waitFor } from "../harness/wait.js";
import { firstMatching } from "./dom.js";

const INPUT = ".search-bar-input";
const COUNT = /^(\d+ of \d+|0 matches)$/;

/** The commit search bar the Cmd+F accelerator opens. */
export class SearchDriver {
	/** Types a query into the open search bar. */
	async query(text: string): Promise<void> {
		const input = await waitFor("the search input", () =>
			document.querySelector<HTMLInputElement>(INPUT),
		);

		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/** The match count beside the input, as the user reads it, or null while
	 *  the bar is not showing one. */
	matchCount(): string | null {
		return (
			firstMatching("span", (text) => COUNT.test(text))?.textContent?.trim() ??
			null
		);
	}
}
