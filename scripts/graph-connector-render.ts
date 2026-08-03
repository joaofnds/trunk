/**
 * Render the connector geometry `buildPath()` emits, as one standalone SVG on stdout.
 *
 *   bun run scripts/graph-connector-render.ts > connectors.svg
 *
 * The scenes are fixed, so two runs over an unchanged tree are byte-identical: capture one
 * before a change to overlay-paths.ts, capture again after, and open both to see what moved.
 * Panels are scaled up so the dash gaps at hollow tips are legible.
 *
 * Upward scenes (parent above child) are unreachable from walk_commits — it orders stashes by
 * the revwalk — so a dev build cannot show them. They are here because the geometry still has
 * a transient caller; see docs/architecture/commit-graph.md, "Direction of travel".
 */

import {
	DOT_RADIUS,
	EDGE_STROKE,
	LANE_WIDTH,
	MERGE_STROKE,
	ROW_HEIGHT,
} from "../src/lib/graph-constants.js";
import { buildOverlayPaths } from "../src/lib/overlay-paths.js";
import type { OverlayConnection, OverlayNode } from "../src/lib/types.js";

/** Mirrors the :root block in src/app.css — the only place these values are authored. */
const TOKENS = `
	--lane-0: oklch(0.76 0.12 225);
	--lane-1: oklch(0.76 0.14 55);
	--lane-2: oklch(0.76 0.14 350);
	--lane-3: oklch(0.76 0.12 275);
	--lane-4: oklch(0.78 0.14 135);
	--lane-5: oklch(0.76 0.12 200);
	--lane-6: oklch(0.76 0.14 160);
	--lane-7: oklch(0.76 0.02 75);
	--bg-0: oklch(0.08 0.003 260);
	--bg-1: oklch(0.1 0.003 260);
	--fg-1: oklch(0.86 0.003 260);
	--fg-2: oklch(0.73 0.005 260);
	--fg-3: oklch(0.7 0.006 260);
`;

const SCALE = 5;
const PANEL_COLS = 3;
const PANEL_ROWS = 4;
const TITLE_H = 26;
const CAPTION_H = 18;
const GAP = 32;

const cx = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;
const cy = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;
const laneColor = (index: number) => `var(--lane-${index % 8})`;

interface Scene {
	title: string;
	nodes: OverlayNode[];
	connections: OverlayConnection[];
}

function node(
	overrides: Partial<OverlayNode> & { x: number; y: number },
): OverlayNode {
	return {
		oid: `n${overrides.x}${overrides.y}`,
		colorIndex: 0,
		isMerge: false,
		isBranchTip: false,
		isStash: false,
		isWip: false,
		...overrides,
	};
}

const scenes: Scene[] = [
	{
		title: "Stash inline — clean worktree",
		nodes: [
			node({ x: 0, y: 0, isBranchTip: true }),
			node({ x: 0, y: 1, isStash: true, isBranchTip: true }),
			node({ x: 0, y: 2 }),
			node({ x: 0, y: 3 }),
		],
		connections: [
			{
				childX: 0,
				childY: 1,
				parentX: 0,
				parentY: 2,
				colorIndex: 0,
				dashed: true,
			},
			{
				childX: 0,
				childY: 2,
				parentX: 0,
				parentY: 3,
				colorIndex: 0,
				dashed: false,
			},
		],
	},
	{
		title: "Stash branched right — dirty worktree",
		nodes: [
			node({ x: 0, y: 0, isBranchTip: true }),
			node({ x: 1, y: 1, isStash: true, isBranchTip: true, colorIndex: 1 }),
			node({ x: 0, y: 2 }),
			node({ x: 0, y: 3 }),
		],
		connections: [
			{
				childX: 1,
				childY: 1,
				parentX: 0,
				parentY: 2,
				colorIndex: 1,
				dashed: true,
			},
			{
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 2,
				colorIndex: 0,
				dashed: false,
			},
			{
				childX: 0,
				childY: 2,
				parentX: 0,
				parentY: 3,
				colorIndex: 0,
				dashed: false,
			},
		],
	},
	{
		title: "Merge commit joining a branch below",
		nodes: [
			node({ x: 0, y: 0, isMerge: true, isBranchTip: true }),
			node({ x: 1, y: 1, colorIndex: 2 }),
			node({ x: 0, y: 3 }),
			node({ x: 1, y: 2, colorIndex: 2 }),
		],
		connections: [
			{
				childX: 0,
				childY: 0,
				parentX: 1,
				parentY: 2,
				colorIndex: 2,
				dashed: false,
			},
			{
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 3,
				colorIndex: 0,
				dashed: false,
			},
			{
				childX: 1,
				childY: 2,
				parentX: 0,
				parentY: 3,
				colorIndex: 2,
				dashed: false,
			},
		],
	},
	{
		title: "WIP row above the head chain",
		nodes: [
			node({ x: 0, y: 0, isWip: true }),
			node({ x: 0, y: 1, isBranchTip: true }),
			node({ x: 0, y: 2 }),
		],
		connections: [
			{
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 1,
				colorIndex: 0,
				dashed: true,
			},
			{
				childX: 0,
				childY: 1,
				parentX: 0,
				parentY: 2,
				colorIndex: 0,
				dashed: false,
			},
		],
	},
	{
		title: "Backdated stash, parent above — fork",
		nodes: [
			node({ x: 0, y: 0, isBranchTip: true }),
			node({ x: 0, y: 1 }),
			node({ x: 1, y: 2, isStash: true, isBranchTip: true, colorIndex: 1 }),
		],
		connections: [
			{
				childX: 1,
				childY: 2,
				parentX: 0,
				parentY: 0,
				colorIndex: 1,
				dashed: true,
			},
			{
				childX: 0,
				childY: 0,
				parentX: 0,
				parentY: 1,
				colorIndex: 0,
				dashed: false,
			},
		],
	},
	{
		title: "Backdated stash, parent above — same column",
		nodes: [
			node({ x: 0, y: 0, isMerge: true, isBranchTip: true }),
			node({ x: 0, y: 2, isStash: true, isBranchTip: true }),
		],
		connections: [
			{
				childX: 0,
				childY: 2,
				parentX: 0,
				parentY: 0,
				colorIndex: 0,
				dashed: true,
			},
		],
	},
];

function marker(n: OverlayNode): string {
	const color = laneColor(n.colorIndex);
	const [x, y] = [cx(n.x), cy(n.y)];

	if (n.isWip) {
		return `<circle cx="${x}" cy="${y}" r="${DOT_RADIUS}" fill="none" stroke="${color}" stroke-width="${EDGE_STROKE}" stroke-dasharray="3 3"/>`;
	}
	if (n.isStash) {
		const side = DOT_RADIUS * 2;
		return `<rect x="${x - DOT_RADIUS}" y="${y - DOT_RADIUS}" width="${side}" height="${side}" fill="none" stroke="${color}" stroke-width="${EDGE_STROKE}" stroke-dasharray="3 3"/>`;
	}
	if (n.isMerge) {
		return `<circle cx="${x}" cy="${y}" r="${DOT_RADIUS}" fill="var(--bg-1)" stroke="${color}" stroke-width="${MERGE_STROKE}"/>`;
	}
	return `<circle cx="${x}" cy="${y}" r="${DOT_RADIUS}" fill="${color}"/>`;
}

const PANEL_W = PANEL_COLS * LANE_WIDTH * SCALE;
const PANEL_H = PANEL_ROWS * ROW_HEIGHT * SCALE;

/** Titles are wider than the panel, so they set the block pitch. Monospace advance is 0.6em. */
const TITLE_FONT_SIZE = 12;
const longestTitle = Math.max(...scenes.map((s) => s.title.length));
const TITLE_W = Math.ceil(longestTitle * TITLE_FONT_SIZE * 0.6);
const CONTENT_W = Math.max(PANEL_W, TITLE_W);
const BLOCK_W = CONTENT_W + GAP;
const BLOCK_H = TITLE_H + PANEL_H + CAPTION_H + GAP;
const PER_ROW = 3;

function panel(scene: Scene, originX: number, originY: number): string {
	const paths = buildOverlayPaths({
		nodes: scene.nodes,
		connections: scene.connections,
		maxColumns: PANEL_COLS,
	});

	const strokes = paths
		.map(
			(p) =>
				`<path d="${p.d}" fill="none" stroke="${laneColor(p.colorIndex)}" stroke-width="${EDGE_STROKE}" stroke-linecap="round"${p.dashed ? ' stroke-dasharray="3 3"' : ""}/>`,
		)
		.join("\n        ");
	const markers = scene.nodes.map(marker).join("\n        ");
	const rows = paths.map((p) => `${p.minRow}–${p.maxRow}`).join("  ");

	return `  <g transform="translate(${originX}, ${originY})">
    <text x="0" y="16" class="title">${scene.title}</text>
    <rect x="0" y="${TITLE_H}" width="${PANEL_W}" height="${PANEL_H}" fill="var(--bg-1)" stroke="var(--fg-3)" stroke-opacity="0.15"/>
    <g transform="translate(0, ${TITLE_H}) scale(${SCALE})">
        ${strokes}
        ${markers}
    </g>
    <text x="0" y="${TITLE_H + PANEL_H + 14}" class="caption">rows ${rows}</text>
  </g>`;
}

function render(): string {
	const width = GAP + BLOCK_W * PER_ROW;
	const height = GAP + BLOCK_H * Math.ceil(scenes.length / PER_ROW);

	const blocks = scenes.map((scene, i) =>
		panel(
			scene,
			GAP + (i % PER_ROW) * BLOCK_W,
			GAP + Math.floor(i / PER_ROW) * BLOCK_H,
		),
	);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    svg {${TOKENS}    }
    text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .title { fill: var(--fg-1); font-size: ${TITLE_FONT_SIZE}px; font-weight: 600; }
    .caption { fill: var(--fg-3); font-size: 10px; }
  </style>
  <rect width="100%" height="100%" fill="var(--bg-0)"/>
${blocks.join("\n")}
</svg>
`;
}

console.log(render());
