/** Keep Git's trailing slash on an untracked directory entry. */
export function splitFilePath(path: string) {
	const end = path.endsWith("/") ? path.length - 1 : path.length;
	const slash = path.lastIndexOf("/", end - 1);
	return {
		directory: path.slice(0, Math.max(0, slash)),
		name: path.slice(slash + 1),
	};
}

const gitNameDecoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});

export function decodeGitName(bytes: number[]): string | undefined {
	try {
		return gitNameDecoder.decode(Uint8Array.from(bytes));
	} catch {
		return undefined;
	}
}

/** The Rust boundary escapes the whole path if any byte is invalid.
 * Show each valid component as the user knows it and keep escapes on the rest. */
export function filePathText(path: string, bytes?: number[]): string {
	if (!bytes) return path;
	let start = 0;
	return path
		.split("/")
		.map((escaped) => {
			const slash = bytes.indexOf(47, start);
			const end = slash < 0 ? bytes.length : slash;
			const label = decodeGitName(bytes.slice(start, end)) ?? escaped;
			start = end + 1;
			return label;
		})
		.join("/");
}
