// The Markdown a comment field writes for a key, as GitHub's comment box writes
// it: each function reads the text and its selection and returns the range to
// replace, what replaces it, and where the selection lands, or null when the
// key's plain behavior stands.

export interface FieldState {
	value: string;
	selectionStart: number;
	selectionEnd: number;
}

export interface TextEdit {
	start: number;
	end: number;
	text: string;
	selectionStart: number;
	selectionEnd: number;
}

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const URL = /^https?:\/\/\S+$/;

function lineStartOf(value: string, index: number): number {
	return value.lastIndexOf("\n", index - 1) + 1;
}

function lineEndOf(value: string, index: number): number {
	const end = value.indexOf("\n", index);
	return end === -1 ? value.length : end;
}

/** Enter inside a list item: the next item, or the end of the list when the
 *  item is empty. */
export function continueList(field: FieldState): TextEdit | null {
	const { value, selectionStart: caret, selectionEnd } = field;
	if (caret !== selectionEnd) return null;

	const lineStart = lineStartOf(value, caret);
	const lineEnd = lineEndOf(value, caret);
	const line = value.slice(lineStart, lineEnd);
	const item = LIST_ITEM.exec(line);
	if (!item || caret < lineStart + item[0].length) return null;

	if (line.slice(item[0].length).trim() === "") {
		return {
			start: lineStart,
			end: lineEnd,
			text: "",
			selectionStart: lineStart,
			selectionEnd: lineStart,
		};
	}

	const [, indent, bullet, number, delimiter, space, task] = item;
	const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
	const text = `\n${indent}${marker}${space}${task ? "[ ] " : ""}`;
	const carried = value.slice(caret, lineEnd);
	return {
		start: caret,
		end: caret + carried.length - carried.trimStart().length,
		text,
		selectionStart: caret + text.length,
		selectionEnd: caret + text.length,
	};
}

/** Bold, italic or code: the selection between two marks, or out of them when
 *  they already surround it. */
export function wrapSelection(field: FieldState, mark: string): TextEdit {
	const { value, selectionStart: start, selectionEnd: end } = field;
	const selected = value.slice(start, end);
	const wrapped =
		value.slice(start - mark.length, start) === mark &&
		value.slice(end, end + mark.length) === mark;

	if (wrapped) {
		return {
			start: start - mark.length,
			end: end + mark.length,
			text: selected,
			selectionStart: start - mark.length,
			selectionEnd: end - mark.length,
		};
	}

	return {
		start,
		end,
		text: `${mark}${selected}${mark}`,
		selectionStart: start + mark.length,
		selectionEnd: end + mark.length,
	};
}

/** A link around the selection, with its url selected to type over. */
export function linkSelection(field: FieldState): TextEdit {
	const { value, selectionStart: start, selectionEnd: end } = field;
	const selected = value.slice(start, end);
	const text = `[${selected}](url)`;

	if (selected === "") {
		return {
			start,
			end,
			text,
			selectionStart: start + 1,
			selectionEnd: start + 1,
		};
	}

	const url = start + selected.length + 3;
	return { start, end, text, selectionStart: url, selectionEnd: url + 3 };
}

/** A list or a quote over every line the selection touches, or off them when
 *  every one already has it. An ordered list numbers its lines. */
export function prefixLines(field: FieldState, prefix: string): TextEdit {
	const { value, selectionStart, selectionEnd } = field;
	const start = lineStartOf(value, selectionStart);
	const end = lineEndOf(value, selectionEnd);
	const lines = value.slice(start, end).split("\n");
	const ordered = /^\d+\. $/.test(prefix);
	const existing = ordered
		? /^\d+\. /
		: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

	const text = lines.every((line) => existing.test(line))
		? lines.map((line) => line.replace(existing, "")).join("\n")
		: lines
				.map((line, i) => `${ordered ? `${i + 1}. ` : prefix}${line}`)
				.join("\n");
	return {
		start,
		end,
		text,
		selectionStart: start,
		selectionEnd: start + text.length,
	};
}

/** A url pasted over selected text links that text to it. */
export function pasteAsLink(
	field: FieldState,
	pasted: string,
): TextEdit | null {
	const { value, selectionStart: start, selectionEnd: end } = field;
	const url = pasted.trim();
	if (start === end || !URL.test(url)) return null;

	const text = `[${value.slice(start, end)}](${url})`;
	return {
		start,
		end,
		text,
		selectionStart: start + text.length,
		selectionEnd: start + text.length,
	};
}
