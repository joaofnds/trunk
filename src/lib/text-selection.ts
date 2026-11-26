const LINE = "[data-code-line]";
const CODE = "[data-code-selection]";
const PROSE =
	"[data-prose-selection], .markdown-body:not([data-prose-selection] .markdown-body)";
const BLOCK = "[data-prose-block], pre, p, h1, h2, h3, h4, h5, h6, li, td, th";

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
	bottom: number;
}

interface PaintedBand extends Band {
	element: HTMLElement;
	x: number;
	y: number;
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
			bottom: top + height,
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
			bottom: top + height,
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
			merged.push({ ...band, element, x, y });
		}
	}

	return merged;
}

function paintBand(band: PaintedBand, above?: Band, below?: Band) {
	const { element, left, right, top, bottom, x, y } = band;
	const joinsAbove = above && Math.abs(above.bottom - top) < 0.5;
	const joinsBelow = below && Math.abs(below.top - bottom) < 0.5;
	const paint = element.ownerDocument.createElement("span");
	paint.className = "text-selection-paint";
	paint.setAttribute("aria-hidden", "true");
	paint.toggleAttribute("data-selection-start", !above);
	paint.toggleAttribute("data-selection-end", !below);
	paint.style.left = `${left - x}px`;
	paint.style.top = `${top - y}px`;
	paint.style.width = `${right - left}px`;
	paint.style.height = `${bottom - top}px`;
	if (joinsAbove) {
		if (above.left <= left + 0.5 && above.right > left)
			paint.style.borderTopLeftRadius = "0";
		if (above.right >= right - 0.5 && above.left < right)
			paint.style.borderTopRightRadius = "0";
	}
	if (joinsBelow) {
		if (below.left <= left + 0.5 && below.right > left)
			paint.style.borderBottomLeftRadius = "0";
		if (below.right >= right - 0.5 && below.left < right)
			paint.style.borderBottomRightRadius = "0";
	}

	element.append(paint);
	return paint;
}

export function installTextSelection(document: Document) {
	let frame: number | undefined;
	let surface: HTMLElement | undefined;
	let paint: HTMLElement[] = [];
	let proseBlocks = new Set<HTMLElement>();
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
		paint = bands.map((band, index) =>
			paintBand(band, bands[index - 1], bands[index + 1]),
		);
		code?.surface.toggleAttribute("data-code-selection-active", true);

		const nextBlocks = code
			? new Set<HTMLElement>()
			: new Set(bands.map(({ element }) => element));
		for (const block of proseBlocks) {
			if (!nextBlocks.has(block))
				block.removeAttribute("data-prose-selection-active");
		}
		for (const block of nextBlocks) {
			if (!proseBlocks.has(block))
				block.setAttribute("data-prose-selection-active", "");
		}
		proseBlocks = nextBlocks;
	}

	function schedule() {
		frame ??= requestAnimationFrame(update);
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
	return () => {
		document.removeEventListener("selectionchange", schedule);
		document.removeEventListener("copy", copy);
		if (frame !== undefined) cancelAnimationFrame(frame);
		resize.disconnect();
		surface?.removeAttribute("data-code-selection-active");
		for (const block of proseBlocks)
			block.removeAttribute("data-prose-selection-active");
		clear();
	};
}
