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
import { safeInvoke } from "../../lib/invoke.js";
import { resetCache } from "../../lib/text-measure.js";
import type { GraphResponse } from "../../lib/types.js";
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
const VIEWPORT_HEIGHT = 4000;

Element.prototype.getBoundingClientRect = function stubbedRect(): DOMRect {
	return {
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 0,
		bottom: VIEWPORT_HEIGHT,
		width: 0,
		height: VIEWPORT_HEIGHT,
		toJSON: () => ({}),
	} as DOMRect;
};

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

async function flush(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tick();
	}
}

export interface MountedGraph {
	svg: SVGSVGElement;
	unmount: () => void;
}

export async function mountGraph(
	fixture: LayoutExport,
	wipCount = 0,
): Promise<MountedGraph> {
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

	const { container, unmount } = render(await graphComponent(), {
		props: {
			repoPath: "/fixture",
			wipCount,
			clearRedoStack: () => {},
			tabActive: true,
		},
	});

	await flush();

	const layer = container.querySelector(".overlay-dots, .overlay-pills");
	const svg = layer?.closest("svg");
	if (!svg) {
		throw new Error("no graph overlay <svg> rendered");
	}

	return { svg: svg as SVGSVGElement, unmount };
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
