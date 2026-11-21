import { ask } from "./dialog.js";
import { forDisplay, MAX_PATH_CHARS } from "./display-text.js";
import { safeInvoke } from "./invoke.js";
import { displayPath } from "./path.js";

/** The repository to open for a folder the user chose: the folder itself, or the
 *  repository it lies inside once the user agrees to open that instead, or null
 *  when they decline. */
export async function repositoryToOpen(
	folder: string,
	isCurrent = () => true,
): Promise<string | null> {
	const enclosing = await safeInvoke<string | null>("enclosing_repository", {
		path: folder,
	});
	if (!isCurrent()) return null;
	if (enclosing === null) return folder;

	const question = `${await shownPath(folder)} is a folder inside the repository ${await shownPath(enclosing)}. Open that repository?`;
	if (!isCurrent()) return null;
	const agreed = await ask(question, {
		title: "Open Repository",
		kind: "info",
		okLabel: "Open Repository",
	});
	return agreed && isCurrent() ? enclosing : null;
}

async function shownPath(path: string): Promise<string> {
	return forDisplay(await displayPath(path), MAX_PATH_CHARS);
}
