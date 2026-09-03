import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphResponse } from "../../src/lib/types.js";
import { HostClient, type SpecStep } from "./harness/host-client.js";

/**
 * The graph replaces its whole commit list with what a rebuild returns. Both
 * rebuild commands used to return the first page alone, so a user who had paged
 * past it lost every page below on a toggle, a commit, a checkout, or the
 * watcher firing. The visible symptom was the author column re-fitting to page
 * one and every row's message re-truncating (TRUNK-133).
 *
 * These drive the real backend over a repository deeper than two pages. One host
 * serves all three: spawning it costs more than the assertions do, and only the
 * toggle writes anything, which it then asserts for itself.
 */
const PAGE = 200;
const DEPTH = 2 * PAGE + 40;

function commits(count: number): SpecStep[] {
	return Array.from({ length: count }, (_, i) => [
		{ step: "file" as const, path: `f${i}.txt`, content: `${i}` },
		{ step: "commit" as const, message: `commit ${i}` },
	]).flat();
}

describe("a rebuild and the depth the caller already holds", () => {
	let host: HostClient;
	let path: string;

	beforeAll(async () => {
		host = await HostClient.spawn();
		path = await host.seedRepo({
			steps: [
				...commits(DEPTH),
				{ step: "branch", name: "topic" },
				{ step: "checkout", name: "topic" },
				{ step: "file", path: "t.txt", content: "t" },
				{ step: "commit", message: "Topic tip" },
				{ step: "checkout", name: "main" },
			],
		});
		await host.invoke("open_repo", { path });
	});

	afterAll(async () => {
		await host?.shutdown();
	});

	it("returns the caller's whole depth from a refresh", async () => {
		const graph = await host.invoke<GraphResponse>("refresh_commit_graph", {
			path,
			loaded: 2 * PAGE,
		});

		expect(graph.commits).toHaveLength(2 * PAGE);
	});

	// A caller holding nothing is a fresh open, and still gets one page.
	it("returns one page to a caller holding nothing", async () => {
		const graph = await host.invoke<GraphResponse>("refresh_commit_graph", {
			path,
			loaded: 0,
		});

		expect(graph.commits).toHaveLength(PAGE);
	});

	// Writes the visibility, so it runs last and states what it left behind.
	it("returns the caller's whole depth from a visibility toggle", async () => {
		const graph = await host.invoke<GraphResponse>("set_ref_visibility", {
			path,
			visibility: { hiddenRefs: ["refs/heads/topic"], hiddenStashes: [] },
			loaded: 2 * PAGE,
		});

		expect(graph.commits).toHaveLength(2 * PAGE);
		expect(graph.commits.map((c) => c.summary)).not.toContain("Topic tip");
	});
});
