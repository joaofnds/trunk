import { describe, expect, it } from "vitest";
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

	it("shows the agent the options the app opened it with until it is answered", () => {
		const panel = new OpenPanel();
		void panel.ask({ directory: true, title: "Open Repository" });

		expect(panel.showing()).toEqual({
			directory: true,
			title: "Open Repository",
		});
		panel.answer("/tmp/other-repo");
		expect(panel.showing()).toBeNull();
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
		it("refuses a second one, as a window holds one sheet at a time", async () => {
			const panel = new OpenPanel();
			void panel.ask({ directory: true });

			await expect(panel.ask({ directory: true })).rejects.toThrow(
				"a folder picker is already showing",
			);
		});
	});
});
