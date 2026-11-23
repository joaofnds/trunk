import { homeDir } from "@tauri-apps/api/path";

let home: string | undefined;

async function getHome(): Promise<string> {
	if (home === undefined) {
		home = await homeDir().catch(() => "");
	}
	return home;
}

// Repository paths come from the native folder picker or the backend as absolute
// paths. A backslash inside an absolute Unix path is part of a filename.
export function repositorySeparator(path: string): string {
	return /^(?:[a-z]:[/\\]|\\\\)/i.test(path) ? "\\" : "/";
}

function forwardSlashes(path: string, separator: string): string {
	return separator === "\\" ? path.replaceAll("\\", "/") : path;
}

export function repositoryParts(path: string): string[] {
	return forwardSlashes(path, repositorySeparator(path))
		.replace(/\/+$/, "")
		.split("/");
}

export function repositoryParent(path: string, displayed: string): string {
	const separator = repositorySeparator(path);
	const normalized = forwardSlashes(displayed, separator).replace(/\/+$/, "");
	const last = normalized.lastIndexOf("/");
	if (last === -1) return "";
	if (
		last === 0 ||
		(separator === "\\" && /^[a-z]:\//i.test(normalized) && last === 2)
	) {
		return displayed.slice(0, last + 1);
	}
	return displayed.slice(0, last);
}

export async function displayPath(path: string): Promise<string> {
	const h = await getHome();
	if (!h) return path;
	const separator = repositorySeparator(path);
	const normalized = forwardSlashes(path, separator);
	const homePath = forwardSlashes(h, separator).replace(/\/+$/, "");
	if (normalized === homePath) return `~${separator}`;
	const prefix = `${homePath}/`;
	return normalized.startsWith(prefix)
		? `~${separator}${path.slice(prefix.length)}`
		: path;
}

/** The name a repository goes by in a tab, a list or a message: its folder's name. */
export function repositoryName(path: string): string {
	return repositoryParts(path).at(-1) || path;
}
