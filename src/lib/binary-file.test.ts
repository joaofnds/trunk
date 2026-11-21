import { describe, expect, it } from "vitest";
import {
	assetUrl,
	binarySummary,
	formatSize,
	isImagePath,
} from "./binary-file.js";

describe("isImagePath", () => {
	it.each([
		"logo.png",
		"photo.JPG",
		"photo.jpeg",
		"anim.gif",
		"icon.svg",
		"hero.webp",
		"hero.avif",
		"old.bmp",
		"favicon.ico",
	])("knows %s for an image", (path) => {
		expect(isImagePath(path)).toBe(true);
	});

	it.each(["font.woff2", "archive.zip", "Makefile", "png"])(
		"knows %s is not one",
		(path) => {
			expect(isImagePath(path)).toBe(false);
		},
	);
});

describe("formatSize", () => {
	it.each([
		[0, "0 bytes"],
		[1, "1 byte"],
		[999, "999 bytes"],
		[1000, "1 KB"],
		[1234, "1.23 KB"],
		[12_345, "12.3 KB"],
		[999_999, "1 MB"],
		[5_400_000, "5.4 MB"],
		[2_000_000_000, "2 GB"],
	])("writes %i bytes as %s", (bytes, text) => {
		expect(formatSize(bytes)).toBe(text);
	});
});

describe("binarySummary", () => {
	it("names the size on each side", () => {
		expect(binarySummary({ old_size: 6, new_size: 8 })).toBe(
			"Binary file, 6 bytes → 8 bytes",
		);
	});

	it("names the size of a file the change added", () => {
		expect(binarySummary({ old_size: null, new_size: 2048 })).toBe(
			"Binary file added, 2.05 KB",
		);
	});

	it("names the size of a file the change deleted", () => {
		expect(binarySummary({ old_size: 5, new_size: null })).toBe(
			"Binary file deleted, 5 bytes",
		);
	});

	it("names no size it was not told", () => {
		expect(binarySummary({ old_size: null, new_size: null })).toBe(
			"Binary file",
		);
	});
});

describe("assetUrl", () => {
	it("names the file at a commit the way the asset protocol reads it", () => {
		expect(
			assetUrl({
				repo: "/r",
				rev: { type: "commit", oid: "abc123" },
				path: "img/a b+c.png",
				version: 3,
			}),
		).toBe(
			"trunk-asset://asset/?repo=%2Fr&rev=commit-abc123&path=img%2Fa%20b%2Bc.png",
		);
	});

	it.each([
		[{ type: "workingTree" } as const, "working-tree"],
		[{ type: "index" } as const, "index"],
		[{ type: "head" } as const, "head"],
	])("asks again for a %o file after each refresh", (rev, token) => {
		expect(assetUrl({ repo: "/r", rev, path: "a.png", version: 7 })).toBe(
			`trunk-asset://asset/?repo=%2Fr&rev=${token}&path=a.png&v=7`,
		);
	});
});
