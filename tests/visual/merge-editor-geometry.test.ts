import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SuiteHarness, type VisualHarness } from "./harness.js";

describe("merge editor at the minimum window size", () => {
	const suite = new SuiteHarness();
	let harness: VisualHarness;

	beforeAll(async () => {
		harness = await suite.start({ cases: ["10-nested-conflict"], pages: 1 });
	});
	afterAll(() => suite.teardown());

	test("fits the file controls above aligned sources and leaves Output visible", async (context) => {
		const geometry = await harness.inspectMergeEditor(
			"nested-conflict",
			"src/services/auth/permissions.ts",
			{ width: 720, height: 480 },
			context,
			measureLayout,
		);

		expect(geometry.controls).toEqual([
			"Path actions for src/services/auth/permissions.ts",
			"Show conflicts with context",
			"Show invisible characters",
			"Toggle word wrap",
		]);
		expect(geometry.clippedOrOverlappingControls).toEqual([]);
		expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.sourcesTop);
		expect(geometry.currentRow).toEqual(geometry.incomingRow);
		expect(geometry.currentRow.top).toBeGreaterThanOrEqual(geometry.sourcesTop);
		expect(geometry.currentRow.bottom).toBeLessThanOrEqual(
			geometry.sourcesBottom,
		);
		expect(geometry.outputTop).toBeGreaterThanOrEqual(geometry.sourcesBottom);
		expect(geometry.visibleOutputHeight).toBeGreaterThan(0);
	});
});

function measureLayout(editor: Element) {
	function rect(selector: string) {
		const match = editor.querySelector(selector);
		if (!match) throw new Error(`Missing merge editor element: ${selector}`);
		return match.getBoundingClientRect();
	}

	function source(label: string) {
		const pane = `[aria-label="${label}"]`;
		const { top, bottom } = rect(`${pane} [data-conflict]`);
		return { pane: rect(pane), row: { top, bottom } };
	}

	const bounds = editor.getBoundingClientRect();
	const toolbar = rect('[aria-label="Merge file controls"]');
	const buttons = [
		...editor.querySelectorAll('[aria-label="Merge file controls"] button'),
	];
	let previousRight = Math.max(toolbar.left, bounds.left, 0);
	const clippedOrOverlappingControls = buttons.filter((button) => {
		const box = button.getBoundingClientRect();
		const clipped =
			box.width <= 0 ||
			box.height <= 0 ||
			box.left < previousRight ||
			box.right > Math.min(toolbar.right, bounds.right, innerWidth) ||
			box.top < toolbar.top ||
			box.bottom > toolbar.bottom;
		previousRight = box.right;
		return clipped;
	});

	const current = source("Current (Ours)");
	const incoming = source("Incoming (Theirs)");
	const output = rect('textarea[aria-label="Merge output"]');

	return {
		controls: buttons.map((button) => button.getAttribute("aria-label")),
		clippedOrOverlappingControls: clippedOrOverlappingControls.map((button) =>
			button.getAttribute("aria-label"),
		),
		controlsBottom: toolbar.bottom,
		sourcesTop: Math.min(current.pane.top, incoming.pane.top),
		currentRow: current.row,
		incomingRow: incoming.row,
		sourcesBottom: Math.max(current.pane.bottom, incoming.pane.bottom),
		outputTop: output.top,
		visibleOutputHeight:
			Math.min(innerHeight, bounds.bottom, output.bottom) - output.top,
	};
}
