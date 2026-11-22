/** Keep Git's trailing slash on an untracked directory entry. */
export function splitFilePath(path: string) {
	const end = path.endsWith("/") ? path.length - 1 : path.length;
	const slash = path.lastIndexOf("/", end - 1);
	return {
		directory: path.slice(0, Math.max(0, slash)),
		name: path.slice(slash + 1),
	};
}
