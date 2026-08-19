/**
 * Render one fixture's committed layout export as a standalone, viewable SVG.
 *
 *   bun run scripts/graph-fixture-render.ts <fixture> > fixture.svg
 *   just graph-svg <fixture>
 *
 * The committed render goldens are a pretty-print of the graph column's markup: unclosed
 * tags, and `var(--lane-N)` with nothing defining it. They diff well and do not open. This
 * drives the same three frontend stages the app does — `withWipRow`, `buildGraphData`,
 * `buildOverlayPaths` — and wraps the result in a document that carries the token block, so
 * a golden that moved can be looked at.
 *
 * Nothing here is committed and no test reads it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraphData } from "../src/lib/active-lanes.js";
import {
	DOT_RADIUS,
	EDGE_STROKE,
	LANE_WIDTH,
	MERGE_STROKE,
	ROW_HEIGHT,
} from "../src/lib/graph-constants.js";
import { buildOverlayPaths } from "../src/lib/overlay-paths.js";
import type {
	GraphCommit,
	GraphResponse,
	OverlayNode,
} from "../src/lib/types.js";
import { withWipRow } from "../src/lib/wip-row.js";
import { TOKENS } from "./graph-connector-render.js";

const EXPORTS_DIR = "src-tauri/tests/goldens/exports";
const SUMMARY_X = 24;
const PADDING = 16;

interface LayoutExport {
	wipCount: number;
	layout: GraphResponse;
}

function fixtureNames(): string[] {
	return readdirSync(EXPORTS_DIR)
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.sort();
}

function loadExport(name: string): LayoutExport {
	return JSON.parse(readFileSync(join(EXPORTS_DIR, `${name}.json`), "utf8"));
}

const cx = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;
const cy = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;
const laneColor = (index: number) => `var(--lane-${index % 8})`;

function escapeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

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

function summaryLine(
	commit: GraphCommit,
	row: number,
	laneWidth: number,
): string {
	const refs = commit.refs.map((r) => r.name).join(" ");
	const label = refs ? `${refs} — ${commit.summary}` : commit.summary;
	return `<text x="${laneWidth + SUMMARY_X}" y="${cy(row) + 4}" class="summary">${escapeText(label)}</text>`;
}

function render(name: string): string {
	const { wipCount, layout } = loadExport(name);
	const rows = withWipRow(layout.commits, wipCount, "Uncommitted changes");
	const { nodes, connections } = buildGraphData(rows, layout.max_columns);
	const paths = buildOverlayPaths({
		nodes,
		connections,
		maxColumns: layout.max_columns,
	});

	const laneWidth = layout.max_columns * LANE_WIDTH;
	const width = laneWidth + SUMMARY_X + 720;
	const height = rows.length * ROW_HEIGHT + PADDING * 2;

	const strokes = paths
		.map(
			(p) =>
				`    <path d="${p.d}" fill="none" stroke="${laneColor(p.colorIndex)}" stroke-width="${EDGE_STROKE}" stroke-linecap="round"${p.dashed ? ' stroke-dasharray="3 3"' : ""}/>`,
		)
		.join("\n");
	const markers = nodes.map((n) => `    ${marker(n)}`).join("\n");
	const summaries = rows
		.map((commit, row) => `    ${summaryLine(commit, row, laneWidth)}`)
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    svg {${TOKENS}    }
    text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .summary { fill: var(--fg-2); }
    .caption { fill: var(--fg-3); font-size: 10px; }
  </style>
  <rect width="100%" height="100%" fill="var(--bg-0)"/>
  <text x="${PADDING}" y="12" class="caption">${escapeText(name)} — ${rows.length} rows, ${layout.max_columns} columns</text>
  <g transform="translate(0, ${PADDING})">
${strokes}
${markers}
${summaries}
  </g>
</svg>
`;
}

const name = process.argv[2];
if (!name) {
	console.error("usage: just graph-svg <fixture>\n\nfixtures:");
	for (const fixture of fixtureNames()) console.error(`  ${fixture}`);
	process.exit(1);
}
if (!fixtureNames().includes(name)) {
	console.error(
		`no export committed for ${name}. Run \`just graph-svg\` for the list.`,
	);
	process.exit(1);
}

console.log(render(name));
