import { commitOidForComment } from "./comment-counts.js";
import type { SessionCommit, Thread } from "./types.js";

export interface ReviewFile {
	path: string;
	threads: Thread[];
}

/**
 * What a group of threads was left on. `uncommitted` is a snapshot of work not
 * yet committed, `current` is a file's own content, which names no commit, and
 * `gone` is a commit the repository no longer has.
 */
export type ReviewGroupKind = "commit" | "gone" | "uncommitted" | "current";

export interface ReviewGroup {
	key: string;
	kind: ReviewGroupKind;
	/** Null only for `current`. */
	commit: SessionCommit | null;
	notes: Thread[];
	files: ReviewFile[];
	/** Notes, then each file's threads, in the order the panel shows them. */
	threads: Thread[];
}

export interface ReviewSection {
	key: string;
	/** The branch the section's commits sit on; null is "not on any branch". */
	branch: string | null;
	isHead: boolean;
	/** The branch's lane colour; null when the graph drew none of its commits. */
	colorIndex: number | null;
	groups: ReviewGroup[];
}

const NO_BRANCH = "";

/**
 * A review's threads gathered the way the panel reads them: by the branch each
 * commit sits on, then by commit in graph order, then by file. Work that is
 * not committed belongs to the checked-out branch.
 */
export function reviewSections(input: {
	threads: Thread[];
	commits: SessionCommit[];
	headBranch: string | null;
}): ReviewSection[] {
	const sections = new Map<string, ReviewSection>();
	const headKey = headSectionKey(input.commits, input.headBranch);

	function sectionFor(key: string): ReviewSection {
		let section = sections.get(key);
		if (section === undefined) {
			section = emptySection(key, input.commits, input.headBranch);
			sections.set(key, section);
		}
		return section;
	}

	const byCommit = new Map<string, Thread[]>();
	const currentFile: Thread[] = [];
	for (const thread of input.threads) {
		if (thread.content_pin) {
			currentFile.push(thread);
			continue;
		}
		const oid = commitOidForComment(thread);
		byCommit.set(oid, [...(byCommit.get(oid) ?? []), thread]);
	}

	const uncommitted: ReviewGroup[] = [];
	for (const commit of input.commits) {
		const threads = byCommit.get(commit.oid) ?? [];
		byCommit.delete(commit.oid);
		if (commit.is_snapshot) {
			if (threads.length > 0) {
				uncommitted.push(group("uncommitted", commit, threads));
			}
			continue;
		}
		const kind = commit.exists ? "commit" : "gone";
		sectionFor(commit.lane_ref?.name ?? NO_BRANCH).groups.push(
			group(kind, commit, threads),
		);
	}

	for (const [oid, threads] of byCommit) {
		sectionFor(NO_BRANCH).groups.push(
			group("commit", outsideTheReview(oid), threads),
		);
	}

	sectionFor(headKey).groups.push(...uncommitted);
	if (currentFile.length > 0) {
		sectionFor(headKey).groups.push(group("current", null, currentFile));
	}

	return [...sections.values()]
		.filter((section) => section.groups.length > 0)
		.sort((a, b) => Number(a.branch === null) - Number(b.branch === null));
}

function headSectionKey(
	commits: SessionCommit[],
	headBranch: string | null,
): string {
	const onHead = commits.find((commit) => commit.lane_ref?.is_head);
	if (onHead?.lane_ref) return onHead.lane_ref.name;
	if (headBranch === null) return NO_BRANCH;
	return `refs/heads/${headBranch}`;
}

function emptySection(
	key: string,
	commits: SessionCommit[],
	headBranch: string | null,
): ReviewSection {
	if (key === NO_BRANCH) {
		return { key, branch: null, isHead: false, colorIndex: null, groups: [] };
	}

	const lane = commits.find(
		(commit) => commit.lane_ref?.name === key,
	)?.lane_ref;
	if (lane) {
		return {
			key,
			branch: lane.short_name,
			isHead: lane.is_head,
			colorIndex: lane.color_index,
			groups: [],
		};
	}

	return {
		key,
		branch: headBranch,
		isHead: true,
		colorIndex: null,
		groups: [],
	};
}

function outsideTheReview(oid: string): SessionCommit {
	return {
		oid,
		short_oid: oid.slice(0, 7),
		summary: "",
		is_snapshot: false,
		lane_ref: null,
		color_index: null,
		author_timestamp: null,
		exists: true,
		picked: false,
	};
}

function group(
	kind: ReviewGroupKind,
	commit: SessionCommit | null,
	threads: Thread[],
): ReviewGroup {
	const notes = threads.filter((t) => t.anchor === null && !t.content_pin);
	const files = byFile(threads.filter((t) => !notes.includes(t)));

	return {
		key: commit === null ? kind : `${kind}:${commit.oid}`,
		kind,
		commit,
		notes,
		files,
		threads: [...notes, ...files.flatMap((file) => file.threads)],
	};
}

function byFile(threads: Thread[]): ReviewFile[] {
	const files = new Map<string, Thread[]>();
	for (const thread of threads) {
		const path =
			thread.anchor?.file_path ?? thread.content_pin?.file_path ?? "";
		files.set(path, [...(files.get(path) ?? []), thread]);
	}

	return [...files].map(([path, list]) => ({
		path,
		threads: list.toSorted((a, b) => startLine(a) - startLine(b)),
	}));
}

function startLine(thread: Thread): number {
	return thread.anchor?.start_line ?? thread.content_pin?.start_line ?? 0;
}
