const LINE = "[data-code-line]";
const CODE = "[data-code-selection]";
const PROSE =
	"[data-prose-selection], .markdown-body:not([data-prose-selection] .markdown-body)";
const BLOCK = "[data-prose-block], pre, p, h1, h2, h3, h4, h5, h6, li, td, th";
const INLINE_MARK =
	".word-add, .word-delete, .merge-word, .md-word-add, .md-word-delete, .invisible-char, .find-match";

interface Slice {
	element: HTMLElement;
	range: Range;
}

function closest(node: Node | null, selector: string) {
	const element = node instanceof Element ? node : node?.parentElement;
	return element?.closest<HTMLElement>(selector);
}

function intersect(line: HTMLElement, range: Range, before?: Element): Slice {
	const slice = line.ownerDocument.createRange();
	slice.selectNodeContents(line);
	if (before) slice.setEndBefore(before);
	if (slice.comparePoint(range.startContainer, range.startOffset) === 0) {
		slice.setStart(range.startContainer, range.startOffset);
	}
	if (slice.comparePoint(range.endContainer, range.endOffset) === 0) {
		slice.setEnd(range.endContainer, range.endOffset);
	}

	return { element: line, range: slice };
}

function codeRange(selection: Selection, side: string | undefined) {
	const native = selection.getRangeAt(0);
	const focus = closest(selection.focusNode, LINE);
	if (!focus || focus.dataset.codeLine === side || !selection.anchorNode)
		return native;

	const row = focus.closest("[data-split-code-row]");
	const line = Array.from(row?.querySelectorAll<HTMLElement>(LINE) ?? []).find(
		(candidate) => candidate.dataset.codeLine === side,
	);
	if (!line) return native;

	const range = line.ownerDocument.createRange();
	range.selectNodeContents(line);
	range.collapse(side === "new");
	if (side === "old") {
		const lastText = line.ownerDocument
			.createTreeWalker(line, NodeFilter.SHOW_TEXT)
			.lastChild();
		if (lastText instanceof Text) {
			range.setStart(lastText, lastText.data.replace(/\r?\n$/, "").length);
			range.collapse(true);
		}
	}
	if (range.comparePoint(selection.anchorNode, selection.anchorOffset) < 0)
		range.setStart(selection.anchorNode, selection.anchorOffset);
	else range.setEnd(selection.anchorNode, selection.anchorOffset);

	return range;
}

export function selectedCode(selection: Selection) {
	if (selection.isCollapsed) return;

	const surface = closest(selection.anchorNode, CODE);
	if (!surface || surface !== closest(selection.focusNode, CODE)) return;

	const anchor = closest(selection.anchorNode, LINE);
	if (!anchor || closest(selection.focusNode, PROSE)) return;

	const side = anchor.dataset.codeLine;
	const range = codeRange(selection, side);
	const slices = Array.from(surface.querySelectorAll<HTMLElement>(LINE))
		.filter(
			(line) => line.dataset.codeLine === side && range.intersectsNode(line),
		)
		.map((line) => intersect(line, range));

	return {
		surface,
		slices,
		text: () =>
			slices
				.map(({ range }, index) => {
					const text = range.toString();
					return index < slices.length - 1
						? text.replace(/\r?\n$/, "")
						: text.replace(/\r\n$/, "\n");
				})
				.join("\n"),
	};
}

function selectedProse(selection: Selection) {
	if (selection.isCollapsed) return;

	const surface = closest(selection.anchorNode, PROSE);
	if (!surface || surface !== closest(selection.focusNode, PROSE)) return;

	const range = selection.getRangeAt(0);
	const blocks = surface.matches(BLOCK)
		? [surface]
		: Array.from(surface.querySelectorAll<HTMLElement>(BLOCK));
	const slices = blocks
		.filter((block) => range.intersectsNode(block))
		.flatMap((block) => {
			const nested = Array.from(block.children).find(
				(child) => child.matches(BLOCK) || child.querySelector(BLOCK),
			);
			const slice = intersect(block, range, nested);
			if (slice.range.comparePoint(range.startContainer, range.startOffset) > 0)
				return [];

			return [slice];
		});

	return { surface, slices };
}

interface Band {
	left: number;
	right: number;
	top: number;
}

interface PaintedBand extends Band {
	element: HTMLElement;
	x: number;
	y: number;
	height: number;
}

function measure(
	{ element, range }: Slice,
	newline: boolean,
	preserveBreaks: boolean,
): PaintedBand[] {
	if (range.collapsed && !newline) return [];

	const style = getComputedStyle(element);
	const height = parseFloat(style.lineHeight);
	if (!(height > 0)) return [];

	const tail = parseFloat(style.fontSize) / 2;
	const bounds = element.getBoundingClientRect();
	const x = bounds.left + element.clientLeft - element.scrollLeft;
	const y = bounds.top + element.clientTop - element.scrollTop;
	const textLeft = x + parseFloat(style.paddingLeft);
	const textTop = y + parseFloat(style.paddingTop);
	const bands: Band[] = [];
	for (const rect of range.getClientRects()) {
		if (!rect.width && (!preserveBreaks || !rect.height)) continue;

		const top =
			textTop +
			Math.floor((rect.top + rect.height / 2 - textTop) / height) * height;
		const left = Math.abs(rect.left - textLeft) < 1 ? textLeft : rect.left;
		bands.push({
			left,
			right: rect.width ? rect.right : left + tail,
			top,
		});
	}

	if (newline) {
		const end = range.cloneRange();
		end.collapse(false);
		const caret = end.getClientRects()[0];
		const last = bands.at(-1);
		const top = last?.top ?? textTop;
		const left = last?.right ?? caret?.left ?? textLeft;
		bands.push({
			left,
			right: left + tail,
			top,
		});
	}

	bands.sort((a, b) => a.top - b.top || a.left - b.left);
	const merged: PaintedBand[] = [];
	for (const band of bands) {
		const previous = merged.at(-1);
		if (
			previous &&
			previous.top === band.top &&
			band.left <= previous.right + 0.5
		) {
			previous.right = Math.max(previous.right, band.right);
		} else {
			merged.push({ ...band, element, x, y, height });
		}
	}

	return merged;
}

function paintBand({ element, left, right, top, x, y, height }: PaintedBand) {
	const paint = element.ownerDocument.createElement("span");
	paint.className = "text-selection-paint";
	paint.setAttribute("aria-hidden", "true");
	paint.style.left = `${left - x}px`;
	paint.style.top = `${top - y}px`;
	paint.style.width = `${right - left}px`;
	paint.style.height = `${height}px`;
	element.append(paint);
	return paint;
}

function reflectSelection(
	attribute: string,
	previous: ReadonlySet<HTMLElement>,
	next: ReadonlySet<HTMLElement>,
) {
	for (const element of previous) {
		if (!next.has(element)) element.removeAttribute(attribute);
	}
	for (const element of next) {
		if (!previous.has(element)) element.setAttribute(attribute, "");
	}
}

export function installTextSelection(document: Document) {
	let frame: number | undefined;
	let surface: HTMLElement | undefined;
	let paint: HTMLElement[] = [];
	let paintedBlocks = new Set<HTMLElement>();
	let markedOverlaps = new Set<HTMLElement>();
	const view = document.defaultView;
	const root = document.documentElement;
	const resize = new ResizeObserver(schedule);

	function clear() {
		for (const element of paint) element.remove();
		paint = [];
	}

	function update() {
		frame = undefined;
		clear();

		const selection = document.getSelection();
		const code = selection && selectedCode(selection);
		const text = code || (selection && selectedProse(selection));
		const next = text ? text.surface : undefined;
		if (surface !== next) {
			resize.disconnect();
			surface?.removeAttribute("data-code-selection-active");
			surface = next;
			if (surface) resize.observe(surface);
		}
		const bands = text
			? text.slices.flatMap((slice, index) =>
					measure(
						slice,
						!!code &&
							(index < code.slices.length - 1 ||
								slice.range.toString().endsWith("\n")),
						!code,
					),
				)
			: [];
		paint = bands.map(paintBand);
		code?.surface.toggleAttribute("data-code-selection-active", true);

		const nextBlocks = new Set(bands.map(({ element }) => element));
		const nextOverlaps = new Set<HTMLElement>();
		for (const { element, range } of text ? text.slices : []) {
			if (range.collapsed) continue;
			for (const mark of element.querySelectorAll<HTMLElement>(INLINE_MARK)) {
				if (
					range.intersectsNode(mark) &&
					intersect(mark, range).range.toString()
				)
					nextOverlaps.add(mark);
			}
		}
		reflectSelection("data-text-selection-active", paintedBlocks, nextBlocks);
		reflectSelection(
			"data-text-selection-overlap",
			markedOverlaps,
			nextOverlaps,
		);
		paintedBlocks = nextBlocks;
		markedOverlaps = nextOverlaps;
	}

	function schedule() {
		frame ??= requestAnimationFrame(update);
	}

	function syncFocus() {
		root.toggleAttribute("data-selection-inactive", !document.hasFocus());
	}

	function copy(event: ClipboardEvent) {
		if (event.defaultPrevented || !event.clipboardData) return;

		const target = event.target;
		if (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			(target instanceof HTMLElement && target.isContentEditable)
		)
			return;

		const selection = document.getSelection();
		const code = selection && selectedCode(selection);
		if (!code) return;

		event.preventDefault();
		const text = code.text();
		if (text) event.clipboardData.setData("text/plain", text);
	}

	document.addEventListener("selectionchange", schedule);
	document.addEventListener("copy", copy);
	view?.addEventListener("focus", syncFocus);
	view?.addEventListener("blur", syncFocus);
	syncFocus();

	return () => {
		document.removeEventListener("selectionchange", schedule);
		document.removeEventListener("copy", copy);
		view?.removeEventListener("focus", syncFocus);
		view?.removeEventListener("blur", syncFocus);
		root.removeAttribute("data-selection-inactive");
		if (frame !== undefined) cancelAnimationFrame(frame);
		resize.disconnect();
		surface?.removeAttribute("data-code-selection-active");
		for (const block of paintedBlocks)
			block.removeAttribute("data-text-selection-active");
		for (const mark of markedOverlaps)
			mark.removeAttribute("data-text-selection-overlap");
		clear();
	};
}
