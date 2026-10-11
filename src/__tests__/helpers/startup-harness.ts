import { setImmediate } from "node:timers";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { FakeScheduler } from "../../../tests/app/fakes/scheduler.js";
import {
	installDomPolyfills,
	restoreDomPolyfills,
} from "../../../tests/app/harness/dom.js";
import App from "../../App.svelte";
import { SCHEDULER } from "../../lib/scheduler.js";
import type { PersistedTab } from "../../lib/tab-types.js";
import { makeCommit } from "./factories.js";
import { RepositoryReadHost } from "./repository-read-host.js";

/** Real root component and Tauri transport, with controllable repository replies. */
export class StartupHarness {
	readonly host = new RepositoryReadHost();
	readonly clock = new FakeScheduler();
	private view?: ReturnType<typeof render>;

	constructor(tabs: PersistedTab[], activeId: string) {
		this.host.install();
		installDomPolyfills();
		this.host.preferences.set("open_tabs", tabs);
		this.host.preferences.set("active_tab_id", activeId);
		this.host.preferences.set("fetch_interval_ms", 0);
		this.host.preferences.set("column_user_widths_copied", true);
		this.host.preferences.set("column_visibility", { diff: false });
		this.host.seedGraph({
			commits: [makeCommit({ oid: "history", summary: "restored history" })],
			max_columns: 1,
			revision: 1,
		});
	}

	start(): void {
		this.view = render(App, { context: new Map([[SCHEDULER, this.clock]]) });
	}

	async settle(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await tick();
	}

	async activate(name: string): Promise<void> {
		await fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
	}

	async pickRecent(name: string): Promise<void> {
		await fireEvent.keyDown(window, { key: "r", ctrlKey: true });
		const picker = await screen.findByRole("dialog", {
			name: "Open a recent repository",
		});
		await fireEvent.click(await within(picker).findByText(name));
	}

	async prepareNextRepository(): Promise<void> {
		this.clock.advanceBy(0);
		await this.settle();
	}

	async enterReview(): Promise<void> {
		await this.host.emit("review-toggle", null);
		await screen.findByText("No reviews in this repository");
	}

	async close(name: string): Promise<void> {
		const item = screen.getByRole("tab", { name }).parentElement;
		if (!item) throw new Error("tab has no container");
		await fireEvent.click(
			within(item).getByRole("button", { name: "Close tab" }),
		);
	}

	paths(command: string): string[] {
		return this.host.requests
			.filter(({ cmd }) => cmd === command)
			.map(({ args }) => String(args.path));
	}

	dirty(name: string): boolean {
		return (
			screen.getByRole("tab", { name }).querySelector(".dirty-dot") !== null
		);
	}

	async selectedHistoryRow(): Promise<HTMLElement> {
		const summary = await screen.findByText("restored history");
		const row = summary.closest<HTMLElement>('[data-testid="commit-row"]');
		if (!row) throw new Error("history has no row");
		await fireEvent.click(row);
		return row;
	}

	async clearDraft(subject: string, body: string): Promise<void> {
		await fireEvent.input(screen.getByDisplayValue(subject), {
			target: { value: "" },
		});
		await fireEvent.input(screen.getByDisplayValue(body), {
			target: { value: "" },
		});
		await this.settle();
	}

	async advanceFetches(count: number): Promise<void> {
		for (let i = 0; i < count; i += 1) {
			this.clock.advanceBy(60_000);
			await this.settle();
		}
	}

	teardown(): void {
		this.view?.unmount();
		this.host.dispose();
		restoreDomPolyfills();
	}
}
