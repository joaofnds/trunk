import { describe, expect, it } from "vitest";
import {
	bumpCargoLock,
	bumpCargoToml,
	bumpPackageJson,
	bumpTauriConf,
	currentVersion,
	ReleaseError,
	releaseBaseline,
	requireIncrement,
} from "./release.js";

describe("currentVersion", () => {
	it("reads the version field out of tauri.conf.json", () => {
		const contents = JSON.stringify({ version: "0.12.8", other: "x" });

		expect(currentVersion(contents)).toBe("0.12.8");
	});
});

describe("requireIncrement", () => {
	it("accepts a version strictly greater than the current one", () => {
		expect(() => requireIncrement("0.44.0", "0.45.0")).not.toThrow();
	});

	it("orders numerically rather than lexicographically", () => {
		expect(() => requireIncrement("0.9.0", "0.10.0")).not.toThrow();
	});

	it("rejects a version equal to the current one", () => {
		expect(() => requireIncrement("0.44.0", "0.44.0")).toThrowError(
			new ReleaseError("0.44.0 is not greater than the current version 0.44.0"),
		);
	});

	it("rejects a version lower than the current one", () => {
		expect(() => requireIncrement("0.44.0", "0.43.0")).toThrowError(
			new ReleaseError("0.43.0 is not greater than the current version 0.44.0"),
		);
	});

	it("rejects a non-numeric version instead of silently accepting it", () => {
		expect(() => requireIncrement("0.44.0", "not-a-version")).toThrowError(
			new ReleaseError('"not-a-version" is not a valid x.y.z version'),
		);
	});

	it("rejects a version with a non-numeric patch segment", () => {
		expect(() => requireIncrement("1.0.0", "1.0.0foo")).toThrowError(
			new ReleaseError('"1.0.0foo" is not a valid x.y.z version'),
		);
	});

	it("rejects a version with too few segments", () => {
		expect(() => requireIncrement("0.44.0", "0.44")).toThrowError(
			new ReleaseError('"0.44" is not a valid x.y.z version'),
		);
	});

	it("rejects a version carrying shell metacharacters", () => {
		expect(() =>
			requireIncrement("0.44.0", '1.0.0"; touch pwned; echo "'),
		).toThrowError(
			new ReleaseError(
				'"1.0.0"; touch pwned; echo "" is not a valid x.y.z version',
			),
		);
	});
});

describe("bumpTauriConf", () => {
	it("replaces the version field and preserves the rest of the document", () => {
		const contents = JSON.stringify(
			{ productName: "Trunk", version: "0.12.8", identifier: "com.x" },
			null,
			2,
		);

		const bumped = bumpTauriConf(contents, "0.45.0");

		expect(JSON.parse(bumped)).toEqual({
			productName: "Trunk",
			version: "0.45.0",
			identifier: "com.x",
		});
	});

	it("keeps a trailing newline when the source has one", () => {
		const contents = `${JSON.stringify({ version: "0.12.8" }, null, 2)}\n`;

		expect(bumpTauriConf(contents, "0.45.0").endsWith("\n")).toBe(true);
	});
});

describe("bumpPackageJson", () => {
	it("replaces the version field and preserves the rest of the document", () => {
		const contents = JSON.stringify(
			{ name: "trunk", version: "0.1.0", license: "Apache-2.0" },
			null,
			"\t",
		);

		const bumped = bumpPackageJson(contents, "0.45.0");

		expect(JSON.parse(bumped)).toEqual({
			name: "trunk",
			version: "0.45.0",
			license: "Apache-2.0",
		});
	});

	it("preserves tab indentation", () => {
		const contents = JSON.stringify(
			{ name: "trunk", version: "0.1.0" },
			null,
			"\t",
		);

		expect(bumpPackageJson(contents, "0.45.0")).toContain('\t"version"');
	});
});

describe("bumpCargoToml", () => {
	it("replaces the package version line and leaves the rest untouched", () => {
		const contents = [
			"[package]",
			'name = "trunk"',
			'version = "0.1.0"',
			'edition = "2024"',
			"",
			"[dependencies]",
			'tauri = { version = "2", features = [] }',
			"",
		].join("\n");

		const bumped = bumpCargoToml(contents, "0.45.0");

		expect(bumped).toContain('version = "0.45.0"');
		expect(bumped).toContain('tauri = { version = "2", features = [] }');
		expect(bumped).not.toContain('version = "0.1.0"');
	});

	it("treats a $-bearing version as literal text, not a replacement pattern", () => {
		const contents = [
			"[package]",
			'name = "trunk"',
			'version = "0.1.0"',
			"",
		].join("\n");

		const bumped = bumpCargoToml(contents, "9.9.9$&$`$'");

		expect(bumped).toContain('version = "9.9.9$&$`$\'"');
	});

	it("throws when no package version line is found", () => {
		const contents = "[dependencies]\n";

		expect(() => bumpCargoToml(contents, "0.45.0")).toThrowError(
			new ReleaseError("no [package] version line found in Cargo.toml"),
		);
	});
});

describe("bumpCargoLock", () => {
	it("replaces only the trunk package's own version entry", () => {
		const contents = [
			"[[package]]",
			'name = "tauri"',
			'version = "2.9.1"',
			"",
			"[[package]]",
			'name = "trunk"',
			'version = "0.1.0"',
			"dependencies = [",
			' "tauri",',
			"]",
			"",
			"[[package]]",
			'name = "windows-sys"',
			'version = "0.61.2"',
			"",
		].join("\n");

		const bumped = bumpCargoLock(contents, "0.45.0");

		expect(bumped).toContain(
			["[[package]]", 'name = "trunk"', 'version = "0.45.0"'].join("\n"),
		);
		expect(bumped).toContain('name = "tauri"\nversion = "2.9.1"');
		expect(bumped).toContain('name = "windows-sys"\nversion = "0.61.2"');
	});

	it("treats a $-bearing version as literal text, not a replacement pattern", () => {
		const contents = [
			"[[package]]",
			'name = "trunk"',
			'version = "0.1.0"',
			"",
		].join("\n");

		const bumped = bumpCargoLock(contents, "9.9.9$1$2");

		expect(bumped).toContain('version = "9.9.9$1$2"');
	});

	it("throws when no trunk package entry is found", () => {
		const contents = '[[package]]\nname = "tauri"\nversion = "2.9.1"\n';

		expect(() => bumpCargoLock(contents, "0.45.0")).toThrowError(
			new ReleaseError(
				'no [[package]] entry named "trunk" found in Cargo.lock',
			),
		);
	});
});

describe("releaseBaseline", () => {
	it("takes the highest release tag when it is ahead of the manifest", () => {
		expect(releaseBaseline("0.12.8", ["v0.43.0", "v0.44.0", "v0.9.0"])).toBe(
			"0.44.0",
		);
	});

	it("orders tags numerically rather than lexicographically", () => {
		expect(releaseBaseline("0.1.0", ["v0.9.0", "v0.10.0"])).toBe("0.10.0");
	});

	it("falls back to the manifest when no release tags exist", () => {
		expect(releaseBaseline("0.12.8", [])).toBe("0.12.8");
	});

	it("takes the manifest when it is ahead of every tag", () => {
		expect(releaseBaseline("0.45.0", ["v0.44.0"])).toBe("0.45.0");
	});

	it("ignores tags that are not a plain x.y.z release", () => {
		expect(
			releaseBaseline("0.12.8", ["v0.44.0", "v1.0.0-rc.1", "nightly"]),
		).toBe("0.44.0");
	});

	it("refuses a version below the newest tag once used as the baseline", () => {
		const baseline = releaseBaseline("0.12.8", ["v0.44.0"]);

		expect(() => requireIncrement(baseline, "0.30.5")).toThrowError(
			new ReleaseError("0.30.5 is not greater than the current version 0.44.0"),
		);
	});
});
