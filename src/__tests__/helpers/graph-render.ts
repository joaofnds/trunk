import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { expect, vi } from "vitest";
import { ROW_HEIGHT } from "../../lib/chrome-heights.js";
import { safeInvoke } from "../../lib/invoke.js";
import { resetCache } from "../../lib/text-measure.js";
import type { GraphResponse } from "../../lib/types.js";
import {
	stubVirtualListLayout,
	UNSCROLLED_VIEWPORT_HEIGHT,
} from "./virtual-list-layout.js";
import "./tauri-mock";

vi.mock("../../lib/invoke.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/invoke.js")>(
		"../../lib/invoke.js",
	);
	return { ...actual, safeInvoke: vi.fn() };
});

vi.mock("../../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));

/** One fixture's `walk_commits` output plus the `wipCount` the app would pass. */
export interface LayoutExport {
	wipCount: number;
	layout: GraphResponse;
}

const EXPORTS_DIR = join(process.cwd(), "src-tauri/tests/goldens/exports");

export function exportNames(): string[] {
	return readdirSync(EXPORTS_DIR)
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.sort();
}

export function loadExport(name: string): LayoutExport {
	return JSON.parse(readFileSync(join(EXPORTS_DIR, `${name}.json`), "utf8"));
}

const WIDE_GLYPH = /[0-9mwMW]/;

function stubTextWidth(text: string): number {
	return [...text].reduce((w, ch) => w + (WIDE_GLYPH.test(ch) ? 10 : 6), 0);
}

if (typeof globalThis.OffscreenCanvas === "undefined") {
	globalThis.OffscreenCanvas = class {
		constructor(
			public width: number,
			public height: number,
		) {}
		getContext() {
			return {
				font: "",
				measureText: (text: string) => ({ width: stubTextWidth(text) }),
			};
		}
	} as unknown as typeof OffscreenCanvas;
}

if (typeof Element.prototype.scrollTo === "undefined") {
	Element.prototype.scrollTo = () => {};
}

// jsdom lays nothing out, so VirtualList's container measures 0 high, its visible
// range collapses to the buffer, and the overlay renders 22 rows however tall the
// fixture is. The truncated render is self-consistent, so nothing about it looks
// wrong. Removing this stub silently caps every render golden at 22 rows.
//
// `./virtual-list-layout.js` measures by role rather than answering one number
// for everything: at `UNSCROLLED_VIEWPORT_HEIGHT` every fixture still fits, which
// is the state the 121 goldens are pinned to, and `mountScrolledGraph` below is
// the same mount at a viewport short enough to scroll.
stubVirtualListLayout({ viewportHeight: UNSCROLLED_VIEWPORT_HEIGHT });

/**
 * Loaded on demand, never as a static import: `./tauri-mock` registers its
 * `vi.mock` calls when this module is evaluated, and a static import of the
 * component would pull the real `@tauri-apps/api/event` in first.
 */
async function graphComponent() {
	return (await import("../../components/CommitGraph.svelte")).default;
}

/**
 * Pays the component's transform and import cost in a hook. Left to the first
 * test it lands on whichever variant runs first, and under a loaded worker that
 * one test alone exceeds the 5s default while every other one takes milliseconds.
 */
export async function warmGraphComponent(): Promise<void> {
	await graphComponent();
}

async function flushRound(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await tick();
}

async function flush(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await flushRound();
	}
}

export interface MountedGraph {
	svg: SVGSVGElement;
	unmount: () => void;
}

async function renderGraph(fixture: LayoutExport, wipCount: number) {
	resetCache();
	vi.mocked(safeInvoke).mockReset();
	vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
		switch (cmd) {
			case "get_commit_graph":
			case "refresh_commit_graph":
				return Promise.resolve(fixture.layout);
			case "list_stashes":
				return Promise.resolve([]);
			default:
				return Promise.resolve(undefined);
		}
	});

	const rendered = render(await graphComponent(), {
		props: {
			repoPath: "/fixture",
			wipCount,
			clearRedoStack: () => {},
			tabActive: true,
		},
	});

	await flush();
	return rendered;
}

export async function mountGraph(
	fixture: LayoutExport,
	wipCount = 0,
): Promise<MountedGraph> {
	const { container, unmount } = await renderGraph(fixture, wipCount);

	const expectedRows = fixture.layout.commits.length + (wipCount > 0 ? 1 : 0);
	const svg = await settledOverlay(container, expectedRows);

	return { svg, unmount };
}

// Under machine load the fixed flush above can return while the overlay is still
// mid-render; capturing then diffs a truncated SVG against the golden — and in
// accept mode would commit one. Wait for the row count the mount's own inputs
// imply, and make a persistent shortfall its own failure.
const SETTLE_ROUNDS = 25;

async function settledOverlay(
	container: HTMLElement,
	expectedRows: number,
): Promise<SVGSVGElement> {
	for (let round = 0; round < SETTLE_ROUNDS; round++) {
		const svg = overlaySvg(container);
		if (svg && dots(svg).length >= expectedRows) return svg;

		await flushRound();
	}

	const svg = overlaySvg(container);
	if (!svg) {
		throw new Error("no graph overlay <svg> rendered");
	}
	throw new Error(
		`graph overlay truncated: expected ${expectedRows} rows, rendered ${dots(svg).length} after ${SETTLE_ROUNDS} settle rounds`,
	);
}

function overlaySvg(container: HTMLElement): SVGSVGElement | null {
	const layer = container.querySelector(".overlay-dots, .overlay-pills");
	return layer?.closest("svg") ?? null;
}

/**
 * A linear fixture of `rows` commits, built in memory from a committed export's
 * own commit shape.
 *
 * A scrolled mount needs more rows than `VirtualList`'s buffer plus its viewport,
 * and the tallest committed fixture is 30 — under a 20-row buffer that still
 * renders every row from any scroll position, which is what makes a scroll test
 * against it pass while proving nothing. Growing the corpus instead would add
 * render goldens, and these rows exist to be scrolled past rather than to pin a
 * layout, so they are built here and committed nowhere.
 */
export function tallFixture(rows: number): LayoutExport {
	const seed = loadExport("lane-13-tall-linear");
	const [tip] = seed.layout.commits;

	const oidOf = (row: number) => `${row}`.padStart(40, "0");
	const commits = Array.from({ length: rows }, (_, row) => ({
		...tip,
		oid: oidOf(row),
		short_oid: oidOf(row).slice(0, 7),
		summary: `tall ${rows - row}`,
		body: null,
		author_timestamp: tip.author_timestamp - row * 86_400,
		parent_oids: row === rows - 1 ? [] : [oidOf(row + 1)],
		refs: row === 0 ? tip.refs : [],
		is_head: row === 0,
		is_branch_tip: row === 0,
	}));

	return {
		wipCount: 0,
		layout: { ...seed.layout, commits },
	};
}

export interface ScrolledGraphOptions {
	/** Shorter than the fixture's content, so the list scrolls and culls. */
	viewportHeight: number;
	wipCount?: number;
}

export interface ScrolledGraph {
	svg: SVGSVGElement;
	/** The row height the overlay is painted at, read back from the gap between
	 *  its dots. The defect this mount exists to catch drew this at the viewport
	 *  height instead of the row height. */
	rowHeight: () => number;
	scrollTo: (top: number) => Promise<void>;
	unmount: () => void;
}

/**
 * The graph behind a viewport shorter than its own content: the state the render
 * goldens cannot reach, because every one of them mounts tall enough to fit the
 * whole fixture and so never leaves `visibleStart` 0.
 *
 * Restores the goldens' full-height layout on unmount. The stub is on the
 * prototypes and is shared by every mount in the process, so a scrolled test that
 * left it installed would silently shrink the viewport under a golden.
 */
export async function mountScrolledGraph(
	fixture: LayoutExport,
	options: ScrolledGraphOptions,
): Promise<ScrolledGraph> {
	const { viewportHeight, wipCount = 0 } = options;
	stubVirtualListLayout({ viewportHeight });

	const { container, unmount } = await renderGraph(fixture, wipCount);

	const viewport = container.querySelector<HTMLElement>(
		".virtual-list-viewport",
	);
	if (!viewport) throw new Error("no virtual list viewport rendered");

	const svg = await settledScrolledOverlay(container);

	return {
		svg,
		rowHeight: () => overlayRowHeight(svg),
		scrollTo: (top: number) => settledScroll(container, viewport, top),
		unmount: () => {
			unmount();
			stubVirtualListLayout({ viewportHeight: UNSCROLLED_VIEWPORT_HEIGHT });
		},
	};
}

/**
 * Scrolls the viewport and waits for the list to render the window that position
 * implies, re-issuing the scroll each round until it holds.
 *
 * Two things make a single assignment insufficient. `VirtualList` handles a
 * scroll event on a `requestAnimationFrame`, which jsdom runs on a ~16ms timer,
 * so a `setTimeout(0)` flush returns before the list has read the new position.
 * And `CommitGraph` scrolls itself to the HEAD row once per mount, on a deferred
 * frame of its own — landing after an early scroll and resetting it to 0.
 *
 * So wait on the rendered row index rather than on a duration, and keep asking
 * until the observable agrees. The window's first row is what the scroll is for.
 */
async function settledScroll(
	container: HTMLElement,
	viewport: HTMLElement,
	scrollTop: number,
): Promise<void> {
	const target = Math.floor(scrollTop / ROW_HEIGHT);

	for (let round = 0; round < SETTLE_ROUNDS; round++) {
		viewport.scrollTop = scrollTop;
		viewport.dispatchEvent(new Event("scroll"));

		await frame();
		await flushRound();

		const first = container.querySelector<HTMLElement>("[data-original-index]");
		const start = Number.parseInt(first?.dataset.originalIndex ?? "", 10);
		if (Number.isFinite(start) && start > 0 && start <= target) return;
	}

	throw new Error(
		`the list never left visibleStart 0 after scrolling to row ${target}`,
	);
}

function frame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

/**
 * A scrolled mount cannot wait on the fixture's full row count the way
 * `mountGraph` does — culling that count away is the point. Wait for the overlay
 * to hold any row at all, and let the assertions say what the window should be.
 */
async function settledScrolledOverlay(
	container: HTMLElement,
): Promise<SVGSVGElement> {
	for (let round = 0; round < SETTLE_ROUNDS; round++) {
		const svg = overlaySvg(container);
		if (svg && dots(svg).length > 0) return svg;

		await flushRound();
	}
	throw new Error("graph overlay rendered no rows");
}

/**
 * The row height the overlay is actually drawn at: the gap between consecutive
 * dots, which `CommitGraph` computes from the height `VirtualList` measured off
 * the rendered rows.
 *
 * Read from the painted output rather than from any input. A row's
 * `getBoundingClientRect` would hand back the stub's own answer and assert
 * nothing, and the item layer's `translateY` sums mostly *unmeasured* rows, which
 * fall back to the estimate and hide a wrong measurement behind it. The dot gap
 * is the number a user would see be wrong.
 */
function overlayRowHeight(svg: SVGSVGElement): number {
	const ys = dots(svg).map((dot) =>
		Number.parseFloat(dot.getAttribute("cy") ?? dot.getAttribute("y") ?? ""),
	);
	if (ys.length < 2) throw new Error("need two dots to measure the row gap");

	const gaps = new Set(ys.slice(1).map((y, i) => y - ys[i]));
	if (gaps.size !== 1) {
		throw new Error(`dots are unevenly spaced: ${[...gaps].join(", ")}`);
	}

	return [...gaps][0];
}

/** Each dot's row index, read back from the `cy` the overlay painted it at. */
export function dotRows(svg: SVGSVGElement): number[] {
	return dots(svg).map((dot) => {
		const cy = Number.parseFloat(
			dot.getAttribute("cy") ?? dot.getAttribute("y") ?? "",
		);
		return Math.round((cy - ROW_HEIGHT / 2) / ROW_HEIGHT);
	});
}

/** One element per rendered row: a circle for a commit, a rect for a stash. */
export function dots(svg: SVGSVGElement): Element[] {
	return [...(svg.querySelector(".overlay-dots")?.children ?? [])];
}

/** The attributes that tell the four node shapes apart, and nothing else. */
export function shapeOf(dot: Element) {
	return {
		element: dot.tagName,
		fill: dot.getAttribute("fill"),
		dash: dot.getAttribute("stroke-dasharray"),
		strokeWidth: dot.getAttribute("stroke-width"),
	};
}

/** Every ref pill's rendered text, in document order, overflow badges included. */
export function pillTexts(svg: SVGSVGElement): string[] {
	const pills = svg.querySelector(".overlay-pills")?.children ?? [];

	return [...pills]
		.filter((child) => child.tagName === "foreignObject")
		.map((label) => label.textContent?.trim() ?? "");
}

export function dashedPaths(svg: SVGSVGElement): Element[] {
	return [
		...svg.querySelectorAll('.overlay-paths path[stroke-dasharray="3 3"]'),
	];
}

/**
 * The overlay as committed text: one line per element, attributes sorted, so a
 * moved dot or a changed dash rule reads as a one-line diff.
 *
 * A nested `<svg>` is a Lucide pill icon. Its class names the icon, which is the
 * part this pipeline chooses; the path data underneath belongs to the icon set.
 */
export function serializeSvg(root: SVGSVGElement): string {
	const lines: string[] = [];
	serializeInto(root, 0, lines, true);
	return `${lines.join("\n")}\n`;
}

function serializeInto(
	element: Element,
	depth: number,
	lines: string[],
	isRoot: boolean,
): void {
	const indent = "  ".repeat(depth);
	const attributes = [...element.attributes]
		.map((attribute) => `${attribute.name}="${attribute.value}"`)
		.sort()
		.join(" ");

	const open = attributes
		? `<${element.tagName} ${attributes}>`
		: `<${element.tagName}>`;
	lines.push(indent + open);
	if (!isRoot && element.tagName === "svg") return;

	for (const child of element.childNodes) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			serializeInto(child as Element, depth + 1, lines, false);
			continue;
		}
		const text = child.nodeType === Node.TEXT_NODE && child.textContent?.trim();
		if (text) lines.push(`${indent}  "${text}"`);
	}
}

/** One fixture rendered at one `wipCount`, and the row count that render must produce. */
export interface RenderVariant {
	name: string;
	fixture: LayoutExport;
	wipCount: number;
	rows: number;
}

function wipVariant(name: string, fixture: LayoutExport, wipCount: number) {
	return {
		name: `${name}.wip`,
		fixture,
		wipCount,
		rows: fixture.layout.commits.length + 1,
	};
}

/**
 * Renders taken at a `wipCount` the fixture's own worktree does not report,
 * because no dirty fixture reaches the shapes they cover.
 *
 * Both put a row in the WIP row's own column, which is what splits the dashed WIP
 * connection — the two shapes `active-lanes.ts` names, a branch behind its
 * upstream and an inline stash. The stash fixture also carries a merge and an
 * ordinary commit, so its render holds all four node shapes at once.
 */
const EXTRA_WIP_VARIANTS: [name: string, wipCount: number][] = [
	["lane-01-behind-only", 1],
	["stash-14-merge-tip", 1],
];

export function renderVariants(): RenderVariant[] {
	const extra = EXTRA_WIP_VARIANTS.map(([name, wipCount]) =>
		wipVariant(name, loadExport(name), wipCount),
	);

	const variants = exportNames().flatMap((name) => {
		const fixture = loadExport(name);
		const clean = {
			name,
			fixture,
			wipCount: 0,
			rows: fixture.layout.commits.length,
		};

		if (fixture.wipCount === 0) return [clean];
		return [clean, wipVariant(name, fixture, fixture.wipCount)];
	});

	return [...variants, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}

export interface RenderedGraph {
	dotCount: number;
	markup: string;
}

const rendered = new Map<string, Promise<RenderedGraph>>();

/** Mounted once per variant: the row-count guard and the golden read the same render. */
export function renderVariant(variant: RenderVariant): Promise<RenderedGraph> {
	const cached = rendered.get(variant.name);
	if (cached) return cached;

	const pending = mountGraph(variant.fixture, variant.wipCount).then(
		({ svg, unmount }) => {
			const captured = {
				dotCount: dots(svg).length,
				markup: serializeSvg(svg),
			};
			unmount();
			return captured;
		},
	);

	rendered.set(variant.name, pending);
	return pending;
}

const GOLDENS_DIR = join(process.cwd(), "src/__tests__/goldens/graph-render");

// Set by `just graph-accept`, never by an ordinary test recipe. `vitest -u` cannot
// reach these: they are plain files, not vitest snapshots.
const ACCEPT_VAR = "TRUNK_ACCEPT_GRAPH_GOLDENS";

const ACCEPT_HINT =
	"A red graph golden is a suspected defect, not a stale artifact. Investigate first. " +
	'If the new render is genuinely intended, accept it with `just graph-accept "<reason>"`, ' +
	"which records the reason in docs/commit-graph-changelog.md. " +
	"Never set TRUNK_ACCEPT_GRAPH_GOLDENS by hand, and accept only at the user's explicit direction.";

export function goldenNames(): string[] {
	return readdirSync(GOLDENS_DIR)
		.filter((name) => name.endsWith(".txt"))
		.map((name) => name.slice(0, -".txt".length))
		.sort();
}

export function expectMatchesGolden(name: string, markup: string): void {
	const path = join(GOLDENS_DIR, `${name}.txt`);

	if (process.env[ACCEPT_VAR] !== undefined) {
		mkdirSync(GOLDENS_DIR, { recursive: true });
		writeFileSync(path, markup);
		return;
	}

	if (!existsSync(path)) {
		throw new Error(
			`no render golden committed for ${name}.\n\n${ACCEPT_HINT}`,
		);
	}
	expect(readFileSync(path, "utf8"), ACCEPT_HINT).toBe(markup);
}
