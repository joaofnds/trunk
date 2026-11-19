import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const SCRIPT = join(import.meta.dirname, "homebrew-cask.sh");
const INTEL = "a".repeat(64);
const ARM = "b".repeat(64);

async function writeCasks(tag: string, tauriVersion: string) {
	const casks = await mkdtemp(join(tmpdir(), "trunk-casks-"));
	onTestFinished(() => rm(casks, { recursive: true, force: true }));

	const run = spawnSync("bash", [SCRIPT, tag, tauriVersion, INTEL, ARM, casks]);

	return { casks, status: run.status };
}

describe("homebrew-cask.sh", () => {
	it("writes the cask for a release tag", async () => {
		const { casks, status } = await writeCasks("v0.63.0", "0.63.0");

		const cask = await readFile(join(casks, "trunk.rb"), "utf8");
		expect(status).toBe(0);
		expect(cask).toContain('cask "trunk" do');
		expect(cask).toContain('version "0.63.0"');
		expect(cask).toContain(
			"https://github.com/joaofnds/trunk/releases/download/v0.63.0/Trunk_0.63.0_aarch64.dmg",
		);
		expect(cask).toContain(`sha256 "${ARM}"`);
	});

	it("pins the same cask under the release's own token", async () => {
		const { casks } = await writeCasks("v0.63.0", "0.63.0");

		const [latest, pinned] = await Promise.all([
			readFile(join(casks, "trunk.rb"), "utf8"),
			readFile(join(casks, "trunk@0.63.0.rb"), "utf8"),
		]);
		expect(pinned).toBe(
			latest.replace('cask "trunk" do', 'cask "trunk@0.63.0" do'),
		);
	});

	describe("when a version is not MAJOR.MINOR.PATCH", () => {
		it.each([
			["v1#{system(%q(id))}", "0.63.0"],
			['v1"+`id`+"', "0.63.0"],
			["v0.63", "0.63.0"],
			["v0.63.0.1", "0.63.0"],
			["v0.63.0", "0.63.0#{system(%q(id))}"],
			["v0.63.0", ""],
		])(
			"refuses tag %j with tauri version %j and writes nothing",
			async (tag, tauriVersion) => {
				const { casks, status } = await writeCasks(tag, tauriVersion);

				expect(status).not.toBe(0);
				expect(await readdir(casks)).toEqual([]);
			},
		);
	});
});
