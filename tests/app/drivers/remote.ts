import { waitFor } from "../harness/wait.js";
import { firstMatching } from "./dom.js";

const PUSH = '[aria-label="Push"]';
const PULL_OPTIONS = '[title="Pull options"]';
const PULL_REBASE = "Pull (rebase)";
const RECOVERY_SURFACE = ".recovery-surface";
const RECOVERY_TEXT = ".recovery-text";
const FORCE_PUSH = "Force Push";

/** What the push recovery prompt is telling the user, and what it offers. */
export interface Recovery {
	text: string;
	actions: string[];
}

/**
 * The remote operations the toolbar offers, and the prompt a refused push
 * raises. Every gesture waits for its control to be enabled before clicking:
 * the toolbar disables both while an operation is in flight and jsdom drops a
 * click on a disabled button silently, so the wait is also how a gesture waits
 * out the one before it.
 */
export class RemoteDriver {
	async push(): Promise<void> {
		const button = await waitFor("an enabled push button", () => enabled(PUSH));

		button.click();
	}

	/** Opens the pull dropdown and chooses the rebase strategy. The plain Pull
	 *  button is not the same gesture: on a diverged branch under a scrubbed git
	 *  config, a strategy-less pull is a fatal error rather than a default. */
	async pullRebase(): Promise<void> {
		const chevron = await waitFor("an enabled pull-options button", () =>
			enabled(PULL_OPTIONS),
		);

		chevron.click();

		const option = await waitFor(`the ${PULL_REBASE} option`, () =>
			firstMatching("button", (text) => text === PULL_REBASE),
		);

		option.click();
	}

	/**
	 * The prompt once it is offering the action that resolves the failure, and
	 * null until then. The same surface carries a plain message and a lone
	 * Dismiss button while the target and operation probes are in flight, so a
	 * reader keyed on the surface itself would settle on that instead.
	 */
	recovery(): Recovery | null {
		const surface = document.querySelector(RECOVERY_SURFACE);
		if (!surface) return null;

		const actions = [...surface.querySelectorAll("button")].map((action) =>
			collapse(action),
		);
		if (!actions.includes(FORCE_PUSH)) return null;

		return { text: collapse(surface.querySelector(RECOVERY_TEXT)), actions };
	}
}

function enabled(selector: string): HTMLButtonElement | null {
	const control = document.querySelector<HTMLButtonElement>(selector);

	return control && !control.disabled ? control : null;
}

function collapse(node: Element | null): string {
	return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}
