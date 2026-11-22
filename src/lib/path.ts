import { homeDir } from "@tauri-apps/api/path";

let home: string | undefined;

async function getHome(): Promise<string> {
	if (home === undefined) {
		home = await homeDir().catch(() => "");
	}
	return home;
}

export async function displayPath(path: string): Promise<string> {
	const h = await getHome();
	if (!h) return path;
	const homePath = h.replace(/\/$/, "");
	if (path === homePath) return "~/";
	const prefix = `${homePath}/`;
	return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

/** The name a repository goes by in a tab, a list or a message: its folder's name. */
export function repositoryName(path: string): string {
	return path.replace(/\/+$/, "").split("/").at(-1) || path;
}
