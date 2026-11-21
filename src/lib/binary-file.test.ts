import { describe, expect, it } from "vitest";
import ASSET_URL_CASES from "./asset-url-cases.json";
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
		"scan.tif",
		"scan.TIFF",
		"photo.heic",
		"photo.heif",
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
		expect(
			binarySummary({ status: "Modified", old_size: 6, new_size: 8 }),
		).toBe("Binary file, 6 bytes → 8 bytes");
	});

	it.each(["Added", "Untracked"] as const)(
		"names the size of a file the change %s",
		(status) => {
			expect(binarySummary({ status, old_size: null, new_size: 2048 })).toBe(
				"Binary file added, 2.05 KB",
			);
		},
	);

	it("names the size of a file the change deleted", () => {
		expect(
			binarySummary({ status: "Deleted", old_size: 5, new_size: null }),
		).toBe("Binary file deleted, 5 bytes");
	});

	it("names the one size of a file opened on its own", () => {
		expect(
			binarySummary({ status: "Unknown", old_size: null, new_size: 3 }),
		).toBe("Binary file, 3 bytes");
	});

	it("names no size it was not told", () => {
		expect(
			binarySummary({ status: "Modified", old_size: null, new_size: null }),
		).toBe("Binary file");
	});
});

describe("assetUrl", () => {
	it.each(
		ASSET_URL_CASES as Array<Parameters<typeof assetUrl>[0] & { url: string }>,
	)(
		"writes $rev.type at $path the way the asset protocol reads it",
		(asset) => {
			expect(assetUrl(asset)).toBe(asset.url);
		},
	);
});
