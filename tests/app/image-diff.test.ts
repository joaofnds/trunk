import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoSpec } from "./harness/host-client.js";
import { setup, teardown } from "./harness/index.js";
import { waitFor } from "./harness/wait.js";

/** A NUL byte is what makes git call a file binary, so each version carries
 *  one. The picture grows from 6 bytes to 8 on disk, and an archive beside it
 *  changes too, so one repository holds an image and a binary that is not. */
const EDITED_BINARIES: RepoSpec = {
	steps: [
		{ step: "file", path: "logo.png", content: "PNG\u0000ab" },
		{ step: "file", path: "bundle.zip", content: "PK\u0000\u0001" },
		{ step: "commit", message: "base" },
		{ step: "file", path: "logo.png", content: "PNG\u0000abcd" },
		{ step: "file", path: "bundle.zip", content: "PK\u0000\u0001\u0002" },
	],
};

describe("the diff of a binary file", () => {
	afterEach(teardown);

	it("shows an edited image before and after, with each side's size", async () => {
		const app = await setup({ repo: EDITED_BINARIES });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("logo.png");

		const sides = await waitFor("both sides of the image", () => {
			const shown = app.diffPane.imageSides();
			return shown.length === 2 ? shown : null;
		});

		expect(sides.map(({ caption }) => caption)).toEqual([
			"Before 6 bytes",
			"After 8 bytes",
		]);
		expect(sides[0]?.src).toMatch(/[?&]rev=index&path=logo\.png(&|$)/);
		expect(sides[1]?.src).toMatch(/[?&]rev=working-tree&path=logo\.png(&|$)/);
	});

	it("reads the image again after it changes on disk", async () => {
		const app = await setup({ repo: EDITED_BINARIES });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("logo.png");
		const first = await waitFor(
			"the image's after side",
			() => app.diffPane.imageSides()[1] ?? null,
		);

		writeFileSync(join(app.repo.path, "logo.png"), "PNG\u0000abcdefgh");
		await app.events.externalChange(app.repo.path);

		const refreshed = await waitFor("the after side read again", () => {
			const after = app.diffPane.imageSides()[1];
			return after && after.caption === "After 12 bytes" ? after : null;
		});
		expect(refreshed.src).not.toBe(first.src);
	});

	it("names the size on each side of a binary file it cannot picture", async () => {
		const app = await setup({ repo: EDITED_BINARIES });
		await app.repo.open();
		await app.staging.open();
		await app.staging.openFile("bundle.zip");

		await expect(
			waitFor("the binary notice", () => {
				const notices = app.diffPane.binaryNotices();
				return notices.length > 0 ? notices : null;
			}),
		).resolves.toEqual(["Binary file, 4 bytes → 5 bytes"]);
		expect(app.diffPane.imageSides()).toEqual([]);
	});
});
