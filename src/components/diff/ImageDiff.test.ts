import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../lib/types.js";
import ImageDiff from "./ImageDiff.svelte";

const PARENT = { type: "commit", oid: "aaa" } as const;
const COMMIT = { type: "commit", oid: "bbb" } as const;

function image(overrides: Partial<FileDiff> = {}): FileDiff {
	return {
		path: "assets/logo.png",
		old_path: null,
		status: "Modified",
		is_binary: true,
		old_size: 1200,
		new_size: 3400,
		hunks: [],
		...overrides,
	};
}

function show(
	file: FileDiff,
	after = COMMIT as typeof COMMIT | { type: "workingTree" },
) {
	return render(ImageDiff, {
		props: { repoPath: "/r", file, before: PARENT, after, version: 4 },
	});
}

function figure(label: string): HTMLElement {
	return screen.getByRole("figure", { name: new RegExp(`^${label}`) });
}

describe("ImageDiff", () => {
	it("shows the image before and after the change, with each side's size", () => {
		show(image());

		expect(screen.getByRole("img", { name: "Before" })).toHaveAttribute(
			"src",
			"trunk-asset://asset/?repo=%2Fr&rev=commit-aaa&path=assets%2Flogo.png",
		);
		expect(screen.getByRole("img", { name: "After" })).toHaveAttribute(
			"src",
			"trunk-asset://asset/?repo=%2Fr&rev=commit-bbb&path=assets%2Flogo.png",
		);
		expect(figure("Before")).toHaveTextContent("1.2 KB");
		expect(figure("After")).toHaveTextContent("3.4 KB");
	});

	it("names each side's pixel size once the image has loaded", async () => {
		show(image());
		const after = screen.getByRole("img", { name: "After" });
		Object.defineProperty(after, "naturalWidth", { value: 64 });
		Object.defineProperty(after, "naturalHeight", { value: 32 });

		await fireEvent.load(after);

		expect(figure("After")).toHaveTextContent("64 × 32 pixels, 3.4 KB");
	});

	it("reads a renamed image's before side at its old path", () => {
		show(image({ status: "Renamed", old_path: "img/old.png" }));

		expect(screen.getByRole("img", { name: "Before" })).toHaveAttribute(
			"src",
			"trunk-asset://asset/?repo=%2Fr&rev=commit-aaa&path=img%2Fold.png",
		);
	});

	it("asks for the file on disk again after each refresh", () => {
		show(image(), { type: "workingTree" });

		expect(screen.getByRole("img", { name: "After" })).toHaveAttribute(
			"src",
			"trunk-asset://asset/?repo=%2Fr&rev=working-tree&path=assets%2Flogo.png&v=4",
		);
	});

	describe("when the change added or deleted the image", () => {
		it.each([
			["Added", "After"],
			["Untracked", "After"],
			["Deleted", "Before"],
		] as const)(
			"shows a file the change %s on one side alone",
			(status, side) => {
				show(image({ status }));

				expect(
					screen.getAllByRole("img").map((img) => img.getAttribute("alt")),
				).toEqual([side]);
			},
		);
	});

	describe("when the webview cannot draw the image", () => {
		it("says so and still names its size", async () => {
			show(image());

			await fireEvent.error(screen.getByRole("img", { name: "After" }));

			expect(figure("After")).toHaveTextContent(
				"This image cannot be previewed",
			);
			expect(figure("After")).toHaveTextContent("3.4 KB");
		});
	});
});
