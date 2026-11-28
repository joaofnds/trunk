import { afterEach, expect, it } from "vitest";
import { type RepoSpec, setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

const FILE = "src/value.ts";
const NESTED_FILE = "src/detail/example.ts";
const REPO: RepoSpec = {
	steps: [
		{ step: "file", path: FILE, content: "export const value = 1;\n" },
		{ step: "file", path: NESTED_FILE, content: "export const example = 1;\n" },
		{ step: "file", path: "README.md", content: "Value example\n" },
		{ step: "commit", message: "Add value" },
		{ step: "file", path: FILE, content: "export const value = 2;\n" },
		{ step: "commit", message: "Update value" },
	],
};

afterEach(teardown);

function control(owner: ParentNode, label: string) {
	return waitFor(label, () =>
		owner.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"]:enabled`,
		),
	);
}

async function collapseAndExpand(owner: ParentNode) {
	await waitFor("the expanded file row", () =>
		owner.querySelector(`[role="treeitem"][data-path="${FILE}"]`),
	);
	const collapse = await control(owner, "Collapse all directories");
	collapse.click();
	const expand = await control(owner, "Expand all directories");
	expect(expand).toBe(collapse);
	expect(
		owner.querySelector(`[role="treeitem"][data-path="${FILE}"]`),
	).toBeNull();

	expand.click();
	expect(await control(owner, "Collapse all directories")).toBe(expand);
	expect(
		owner.querySelector(`[role="treeitem"][data-path="${FILE}"]`),
	).not.toBeNull();
}

it("opens every folder when selecting a commit in tree view", async () => {
	const app = await setup({ repo: REPO });
	await app.repo.open();
	await app.repo.selectCommit("Update value");
	(await control(document, "Switch to tree view")).click();
	(await control(document, "Collapse all directories")).click();
	await control(document, "Expand all directories");

	await app.repo.selectCommit("Add value");

	expect(
		document.querySelector(
			`[data-testid="commit-detail"] [role="treeitem"][data-path="${NESTED_FILE}"]`,
		),
	).not.toBeNull();
});

it("expands and collapses the files in a comparison", async () => {
	const app = await setup({ repo: REPO });
	await app.repo.open();
	await app.repo.selectCompare("Add value", "Update value");
	(await control(document, "Switch to tree view")).click();

	await collapseAndExpand(document);
});

it("expands and collapses the files in a focused rebase commit", async () => {
	const app = await setup({ repo: REPO });
	await app.repo.open();
	await app.repo.selectCommit("Add value");
	await app.repo.contextMenu("Add value");
	app.contextMenu.choose("Interactive Rebase...");
	await app.rebaseEditor.focus("Update value");
	const rebase = await waitFor("the interactive rebase pane", () =>
		document.querySelector('section[aria-label="Interactive rebase"]'),
	);
	(await control(rebase, "Switch to tree view")).click();
	await collapseAndExpand(rebase);
});
