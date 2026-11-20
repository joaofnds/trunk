import { ask } from "./dialog.js";
import { forDisplay, MAX_PATH_CHARS } from "./display-text.js";
import { safeInvoke } from "./invoke.js";
import { displayPath } from "./path.js";

/** The repository to open for a folder the user chose: the folder itself, or the
 *  repository it lies inside once the user agrees to open that instead, or null
 *  when they decline. */
export async function repositoryToOpen(folder: string): Promise<string | null> {
	const enclosing = await safeInvoke<string | null>("enclosing_repository", {
		path: folder,
	});
	if (enclosing === null) return folder;

	const agreed = await ask(
		`${await shownPath(folder)} is a folder inside the repository ${await shownPath(enclosing)}. Open that repository?`,
		{ title: "Open Repository", kind: "info", okLabel: "Open Repository" },
	);
	return agreed ? enclosing : null;
}

async function shownPath(path: string): Promise<string> {
	return forDisplay(await displayPath(path), MAX_PATH_CHARS);
}
