import { screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { makeFile } from "./__tests__/helpers/factories.js";
import { StartupHarness } from "./__tests__/helpers/startup-harness.js";

const file = makeFile("src/review/index.ts");
const tabs = [
	{ id: "one", repoPath: "/one", repoName: "one" },
	{ id: "two", repoPath: "/two", repoName: "two" },
];

let app: StartupHarness;
afterEach(() => app.teardown());

function setup() {
	app = new StartupHarness(tabs, "one");
	app.host.seedResponse("get_status", {
		staged: [],
		unstaged: [file],
		conflicted: [],
	});
}

describe("App file labels", () => {
	it("restores the user's full paths and changes every visited tab from the menu", async () => {
		setup();
		app.host.preferences.set("file_label_style", "full-path");
		app.start();
		await screen.findByText(file.path);
		await app.activate("two");
		await waitFor(() => expect(screen.getAllByText(file.path)).toHaveLength(2));

		await app.host.emit("file-label-style-changed", "filename-first");

		await waitFor(() =>
			expect(screen.getAllByText("index.ts")).toHaveLength(2),
		);
		expect(screen.queryByText(file.path)).toBeNull();
	});

	it("keeps a newer menu choice when an older stored value arrives", async () => {
		setup();
		const saved = app.host.holdNextReply("get_file_label_style");
		app.start();
		await saved.entered;
		try {
			await screen.findByText("index.ts");
			await app.host.emit("file-label-style-changed", "filename-first");
		} finally {
			saved.release("full-path");
		}
		await app.settle();
		expect(screen.getByText("index.ts")).toBeVisible();
		expect(screen.queryByText(file.path)).toBeNull();
	});
});
