import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenPanel } from "./drive-open-panel.js";

describe("OpenPanel", () => {
	it("gives the app the path the agent answers with", async () => {
		const panel = new OpenPanel();
		const chosen = panel.ask({ directory: true, multiple: false });

		panel.answer("/tmp/other-repo");

		await expect(chosen).resolves.toBe("/tmp/other-repo");
	});

	it("gives a multiple-selection picker the path as a list", async () => {
		const panel = new OpenPanel();
		const chosen = panel.ask({ directory: true, multiple: true });

		panel.answer("/tmp/other-repo");

		await expect(chosen).resolves.toEqual(["/tmp/other-repo"]);
	});

	it("gives the app no path when the agent dismisses it, as Cancel does", async () => {
		const panel = new OpenPanel();
		const chosen = panel.ask({ directory: true });

		panel.dismiss();

		await expect(chosen).resolves.toBeNull();
	});

	it("shows the agent the options the app opened it with", () => {
		const panel = new OpenPanel();

		void panel.ask({ directory: true, title: "Open Repository" });

		expect(panel.showing()).toEqual({
			directory: true,
			title: "Open Repository",
		});
	});

	it.each([
		["answered", (panel: OpenPanel) => panel.answer("/tmp/other-repo")],
		["dismissed", (panel: OpenPanel) => panel.dismiss()],
	])("closes once %s", (_how, close) => {
		const panel = new OpenPanel();
		void panel.ask({ directory: true });

		close(panel);

		expect(panel.showing()).toBeNull();
	});

	describe("next", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("gives a wait the options of the picker the app opens after it began", async () => {
			const panel = new OpenPanel();
			const next = panel.next(1_000);

			void panel.ask({ directory: true, multiple: false });

			await expect(next).resolves.toEqual({ directory: true, multiple: false });
		});

		it("names the picker it waited for once the deadline passes", async () => {
			vi.useFakeTimers();
			const next = new OpenPanel().next(1_000);

			vi.advanceTimersByTime(1_000);

			await expect(next).rejects.toThrow("no folder picker showed in 1000ms");
		});
	});

	describe("when no picker is showing", () => {
		it("refuses an answer", () => {
			expect(() => new OpenPanel().answer("/tmp/other-repo")).toThrow(
				"no folder picker is showing",
			);
		});

		it("refuses a dismissal", () => {
			expect(() => new OpenPanel().dismiss()).toThrow(
				"no folder picker is showing",
			);
		});
	});

	describe("when a picker is already showing", () => {
		it("refuses a second one, as the app-modal panel lets no second Open through", async () => {
			const panel = new OpenPanel();
			void panel.ask({ directory: true });

			await expect(panel.ask({ directory: true })).rejects.toThrow(
				"a folder picker is already showing",
			);
		});
	});
});
