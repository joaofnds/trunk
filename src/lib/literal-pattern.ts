export interface FoundMatches<Match> {
	readonly length: number;
	at(index: number): Match | undefined;
}

export interface MatchRange {
	readonly start: number;
	readonly end: number;
}

interface MatchCheckpoint<Location> {
	readonly location: Location;
	readonly content: string;
	readonly index: number;
	readonly offset: number;
}

// Bound backward seeks within a single line or message containing many hits.
const MATCHES_PER_CHECKPOINT = 256;

export function findLiteralMatches<Location extends object>(
	query: string,
	visit: (collect: (content: string, location: Location) => void) => void,
): FoundMatches<Location & MatchRange> {
	if (!query) return [];

	const pattern = new RegExp(
		query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		"giu",
	);
	const checkpoints: MatchCheckpoint<Location>[] = [];
	let length = 0;

	visit((content, location) => {
		for (let hit = pattern.exec(content); hit; hit = pattern.exec(content)) {
			checkpoints.push({ location, content, index: length, offset: hit.index });
			length++;
			for (let i = 1; i < MATCHES_PER_CHECKPOINT; i++) {
				if (!pattern.test(content)) return;
				length++;
			}
		}
	});

	return {
		length,
		at(index) {
			if (!Number.isInteger(index) || index < 0 || index >= length)
				return undefined;

			let lower = 0;
			let upper = checkpoints.length;
			while (lower + 1 < upper) {
				const mid = Math.floor((lower + upper) / 2);
				if (checkpoints[mid].index <= index) lower = mid;
				else upper = mid;
			}

			const { location, content, offset, index: first } = checkpoints[lower];
			pattern.lastIndex = offset;
			for (let skip = first; skip < index; skip++) pattern.test(content);

			const found = pattern.exec(content);
			return found
				? { ...location, start: found.index, end: pattern.lastIndex }
				: undefined;
		},
	};
}
