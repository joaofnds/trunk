import type { FileStatusType, WipStats } from "./types.js";

export interface StatusBadge {
	letter: string;
	color: string;
	title: string;
}

// Single source of truth for the status→letter→color→title mapping, shared by
// FileRow (per-file badge) and CommitRow (per-status WIP-row counts). Change a
// letter or color here and both surfaces stay in sync.
export const STATUS_BADGES: Record<FileStatusType, StatusBadge> = {
	New: { letter: "A", color: "var(--color-status-new)", title: "Added" },
	Modified: {
		letter: "M",
		color: "var(--color-status-modified)",
		title: "Modified",
	},
	Deleted: {
		letter: "D",
		color: "var(--color-status-deleted)",
		title: "Deleted",
	},
	Renamed: {
		letter: "R",
		color: "var(--color-status-renamed)",
		title: "Renamed",
	},
	Typechange: {
		letter: "T",
		color: "var(--color-status-typechange)",
		title: "Typechange",
	},
	Conflicted: {
		letter: "C",
		color: "var(--color-status-conflicted)",
		title: "Conflicted",
	},
};

export const UNKNOWN_STATUS_BADGE: StatusBadge = {
	letter: "?",
	color: "var(--color-text)",
	title: "Unknown",
};

// Display order for the WIP-row badges, pairing each WipStats count with its
// status type. Ordered most-common-first for readability — note this is the
// reverse of the bucket priority in the Rust get_dirty_counts (which ranks
// Conflicted highest and Modified lowest).
export const WIP_BADGE_ORDER: {
	key: keyof WipStats;
	status: FileStatusType;
}[] = [
	{ key: "modified", status: "Modified" },
	{ key: "new", status: "New" },
	{ key: "deleted", status: "Deleted" },
	{ key: "renamed", status: "Renamed" },
	{ key: "typechange", status: "Typechange" },
	{ key: "conflicted", status: "Conflicted" },
];
