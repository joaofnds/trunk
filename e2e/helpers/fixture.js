import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Create a fixture repo with linear commit history.
 * @param {number} commitCount - Number of commits to create (default: 3)
 * @returns {string} Path to the temporary repo directory
 */
export function createLinearRepo(commitCount = 3) {
	const dir = mkdtempSync(join(tmpdir(), "trunk-e2e-"));
	execSync("git init", { cwd: dir });
	execSync('git config user.email "test@test.com"', { cwd: dir });
	execSync('git config user.name "Test"', { cwd: dir });

	for (let i = 1; i <= commitCount; i++) {
		writeFileSync(join(dir, `file-${i}.txt`), `content ${i}`);
		execSync("git add .", { cwd: dir });
		execSync(`git commit -m "commit ${i}"`, { cwd: dir });
	}

	return dir;
}

/**
 * Create a fixture repo with branches.
 * Creates an initial commit on main, then branches `feature-a` and `feature-b`.
 * @returns {string} Path to the temporary repo directory
 */
export function createBranchRepo() {
	const dir = mkdtempSync(join(tmpdir(), "trunk-e2e-"));
	execSync("git init", { cwd: dir });
	execSync('git config user.email "test@test.com"', { cwd: dir });
	execSync('git config user.name "Test"', { cwd: dir });

	writeFileSync(join(dir, "README.md"), "initial");
	execSync("git add .", { cwd: dir });
	execSync('git commit -m "initial commit"', { cwd: dir });

	execSync("git branch feature-a", { cwd: dir });
	execSync("git branch feature-b", { cwd: dir });

	return dir;
}

/**
 * Create a fixture repo with a dirty working tree (unstaged file).
 * Creates one commit, then writes an unstaged file.
 * @returns {string} Path to the temporary repo directory
 */
export function createDirtyRepo() {
	const dir = createLinearRepo(1);
	writeFileSync(join(dir, "dirty-file.txt"), "dirty content");
	return dir;
}

/**
 * Remove a fixture repo directory.
 * @param {string} dir - Path to the repo directory to remove
 */
export function cleanupRepo(dir) {
	rmSync(dir, { recursive: true, force: true });
}
