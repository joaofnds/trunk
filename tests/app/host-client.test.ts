import { afterEach, describe, expect, it } from "vitest";
import type { RefsResponse } from "../../src/lib/types.js";
import { HostClient } from "./harness/host-client.js";

describe("host client", () => {
	let host: HostClient | undefined;

	afterEach(async () => {
		await host?.shutdown();
		host = undefined;
	});

	it("answers list_refs for a seeded repository", async () => {
		host = await HostClient.spawn();
		const path = await host.seedRepo({
			steps: [
				{ step: "file", path: "README.md", content: "hello" },
				{ step: "commit", message: "Initial commit" },
			],
		});
		await host.invoke("open_repo", { path });

		const refs = await host.invoke<RefsResponse>("list_refs", { path });

		expect(refs.local.map((branch) => branch.name)).toEqual(["main"]);
	});
});
