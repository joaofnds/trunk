/**
 * Open a repository in the app by calling the Tauri IPC command directly.
 * This bypasses the native file dialog which WebDriver cannot interact with.
 * @param {string} repoPath - Absolute path to the git repository
 */
export async function openRepo(repoPath) {
	await browser.execute(async (path) => {
		await window.__TAURI_INTERNALS__.invoke("open_repo", { path });
	}, repoPath);
}

/**
 * Wait for the commit graph to render by checking for a commit-row element.
 * @param {number} timeout - Maximum time to wait in milliseconds (default: 10000)
 */
export async function waitForCommitGraph(timeout = 10000) {
	const row = await $('[data-testid="commit-row"]');
	await row.waitForExist({ timeout });
}

/**
 * Wait for the branch sidebar to render.
 * @param {number} timeout - Maximum time to wait in milliseconds (default: 10000)
 */
export async function waitForBranchSidebar(timeout = 10000) {
	const sidebar = await $('[data-testid="branch-sidebar"]');
	await sidebar.waitForExist({ timeout });
}
