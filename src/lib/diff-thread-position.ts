export interface ThreadReadingPosition {
	readonly threadId: string;
	readonly entry: string | null;
	readonly block: number;
	readonly offset: number;
}

const THREAD = "[data-thread-id]";
const ENTRY = "[data-thread-entry]";
const ROOT = "[data-thread-root-body]";
const COMPOSER = "[data-thread-composer]";
const REPLY = "[data-thread-reply-body]";

function atY<T extends Element>(nodes: ArrayLike<T>, y: number): T | null {
	let start = 0;
	let end = nodes.length;
	while (start < end) {
		const middle = (start + end) >>> 1;
		if (nodes[middle].getBoundingClientRect().bottom <= y) start = middle + 1;
		else end = middle;
	}

	return nodes[start] ?? null;
}

export function threadPositionAt(row: Element, y: number) {
	const thread = atY(row.querySelectorAll<HTMLElement>(THREAD), y);
	if (!thread?.dataset.threadId) return null;

	const part = atY(
		thread.querySelectorAll<HTMLElement>(`${ROOT}, ${ENTRY}, ${COMPOSER}`),
		y,
	);
	const body = part?.matches(ENTRY) ? part.querySelector(REPLY) : part;
	const block = body ? atY(body.children, y) : null;
	const element = block ?? part ?? thread;
	let entry = part?.dataset.threadEntry ?? null;
	if (part && entry === null)
		entry = part.matches(COMPOSER) ? "composer" : "root";

	const position: ThreadReadingPosition = {
		threadId: thread.dataset.threadId,
		entry,
		block: body && block ? Array.from(body.children).indexOf(block) : -1,
		offset: y - element.getBoundingClientRect().top,
	};
	return { element, position };
}

export function threadPositionTarget(
	root: Element,
	position: ThreadReadingPosition,
): Element | null {
	const thread = root.querySelector(
		`[data-thread-id="${CSS.escape(position.threadId)}"]`,
	);
	if (!thread || position.entry === null) return thread;

	const entry = position.entry;
	let part: Element | null;
	let body: Element | null;
	if (entry === "root" || entry === "composer") {
		part = thread.querySelector(entry === "root" ? ROOT : COMPOSER);
		body = part;
	} else {
		part = thread.querySelector(`[data-thread-entry="${CSS.escape(entry)}"]`);
		body = part?.querySelector(REPLY) ?? null;
	}

	return body?.children[position.block] ?? part;
}
