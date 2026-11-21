import { describe, expect, it } from "vitest";
import type { GraphResponse } from "../../lib/types.js";
import { makeCommit } from "./factories.js";
import { RepositoryReadHost } from "./repository-read-host.js";

describe("RepositoryReadHost graph paging", () => {
	it("reads the first full page when the loaded depth is zero", async () => {
		const host = new RepositoryReadHost();
		const commits = Array.from({ length: 201 }, (_, row) =>
			makeCommit({ oid: `commit-${row}` }),
		);
		const graph = { commits, max_columns: 1, revision: 2, checked: true };
		host.seedGraph(graph);

		const page = await host.invoke<GraphResponse>("get_commit_graph", {
			offset: 1,
			loaded: 0,
			revision: graph.revision,
		});

		expect(page.commits).toHaveLength(200);
		expect(page.commits[0]).toEqual(commits[0]);
	});

	it("rejects an obsolete revision before looking up a target", async () => {
		const host = new RepositoryReadHost();
		host.seedGraph({ commits: [], max_columns: 0, revision: 2, checked: true });

		const page = host.invoke("get_commit_graph", {
			offset: 0,
			through: "hidden-tip",
			revision: 1,
		});

		await expect(
			page.catch((error: string) => JSON.parse(error)),
		).resolves.toMatchObject({ code: "graph_changed" });
	});
});
