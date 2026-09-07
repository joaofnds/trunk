export class ReleaseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReleaseError";
	}
}

export function currentVersion(tauriConfContents: string): string {
	return JSON.parse(tauriConfContents).version;
}

// Anchored so a trailing shell metacharacter or extra segment ("1.0.0foo",
// `1.0.0"; rm -rf ~`) fails the match instead of producing a NaN component
// that Number-based comparison silently treats as "greater". A version
// matching this shape is also safe to splice into the justfile's `git commit`
// and `git tag` arguments unquoted, since it can hold no shell metacharacter.
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

function requireVersionShape(version: string): void {
	if (!VERSION_SHAPE.test(version)) {
		throw new ReleaseError(`"${version}" is not a valid x.y.z version`);
	}
}

// Numeric triplet comparison, not lexicographic ("0.9.0" < "0.10.0"). The
// three manifests this script bumps only ever carry a plain x.y.z, so a
// semver library's pre-release/build-metadata handling has nothing to do.
function parts(version: string): number[] {
	return version.split(".").map(Number);
}

function order(a: string, b: string): number {
	const [a1, a2, a3] = parts(a);
	const [b1, b2, b3] = parts(b);
	return a1 - b1 || a2 - b2 || a3 - b3;
}

export function requireIncrement(current: string, next: string): void {
	requireVersionShape(next);
	if (order(next, current) <= 0) {
		throw new ReleaseError(
			`${next} is not greater than the current version ${current}`,
		);
	}
}

function bumpJsonVersion(contents: string, version: string): string {
	const trailingNewline = contents.endsWith("\n");
	const indent = contents.includes("\t") ? "\t" : 2;
	const parsed = JSON.parse(contents);
	parsed.version = version;
	const bumped = JSON.stringify(parsed, null, indent);
	return trailingNewline ? `${bumped}\n` : bumped;
}

export function bumpTauriConf(contents: string, version: string): string {
	return bumpJsonVersion(contents, version);
}

export function bumpPackageJson(contents: string, version: string): string {
	return bumpJsonVersion(contents, version);
}

const CARGO_VERSION_LINE = /^version = "[^"]*"$/m;

export function bumpCargoToml(contents: string, version: string): string {
	if (!CARGO_VERSION_LINE.test(contents)) {
		throw new ReleaseError("no [package] version line found in Cargo.toml");
	}
	// A replacer function, not a template string: String.replace treats "$&",
	// "$1", etc. in a string replacement as its own substitution syntax, which
	// would corrupt output for a version containing a literal "$".
	return contents.replace(CARGO_VERSION_LINE, () => `version = "${version}"`);
}

// Cargo silently rewrites this entry back to Cargo.toml's on-disk version the
// next time any cargo command resolves the lockfile, so it has to move in the
// same commit as Cargo.toml or the sync doesn't survive `just check`.
const TRUNK_LOCK_ENTRY = /(\[\[package\]\]\nname = "trunk"\nversion = )"[^"]*"/;

export function bumpCargoLock(contents: string, version: string): string {
	if (!TRUNK_LOCK_ENTRY.test(contents)) {
		throw new ReleaseError(
			'no [[package]] entry named "trunk" found in Cargo.lock',
		);
	}
	// A replacer function so a "$" in version is never read as replacement
	// syntax — same reason as bumpCargoToml above.
	return contents.replace(
		TRUNK_LOCK_ENTRY,
		(_match, prefix: string) => `${prefix}"${version}"`,
	);
}
