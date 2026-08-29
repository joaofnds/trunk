/**
 * Puts the application harness's host behind HTTP so a real browser can be the
 * DOM. `tests/app/harness` reaches the host over stdio from node; a page cannot,
 * and jsdom reports no layout, so neither one can answer "how tall does this
 * actually render". This serves the same host to `scripts/measure/boot.ts`.
 *
 * The routes reach the real command set, destructive commands included, so the
 * run writes a random token to `.bridge-token` and refuses every request that
 * does not carry it. Vite proxies the page to this port (see `vite.config.ts`),
 * which keeps the page same-origin and leaves no CORS headers to widen.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
	HostClient,
	type RepoSpec,
} from "../../tests/app/harness/host-client.js";
import type { BridgeEvent } from "./router.js";
import { createRouter } from "./router.js";

const PORT = 8732;
const TOKEN_FILE = join(import.meta.dirname, ".bridge-token");

const repo: RepoSpec = {
	steps: [
		{ step: "file", path: "README.md", content: "# probe\n" },
		{ step: "commit", message: "docs: describe the probe repository", at: 1 },
		{ step: "file", path: "src/app.css", content: ":root { --u: 4px; }\n" },
		{
			step: "commit",
			message: "refactor(ui): derive every length from one unit",
			at: 2,
		},
		{ step: "branch", name: "topic" },
		{
			step: "file",
			path: "src/lib/probe.ts",
			content: "export const probe = 1;\n",
		},
		{ step: "commit", message: "feat: a second lane for the graph", at: 3 },
		{ step: "checkout", name: "main" },
		{
			step: "file",
			path: "src/unstaged.ts",
			content: "export const staged = false;\n",
		},
	],
};

const host = await HostClient.spawn();
const repoPath = await host.seedRepo(repo);
await host.invoke("prefs_set", {
	key: "recent_repos",
	value: [{ name: repoPath.split("/").at(-1), path: repoPath }],
});
await host.invoke("prefs_set", { key: "open_tabs", value: [repoPath] });

const events: BridgeEvent[] = [];
host.onEvent((event, payload) => events.push({ event, payload }));

const token = randomBytes(32).toString("hex");
writeFileSync(TOKEN_FILE, token, { mode: 0o600 });

const route = createRouter({
	token,
	invoke: (cmd, args) => host.invoke(cmd, args),
	context: { home: host.home, repoPath },
	events,
});

createServer(async (req, res) => {
	const body = await new Promise<string>((resolve) => {
		let text = "";
		req.on("data", (chunk) => (text += chunk));
		req.on("end", () => resolve(text));
	});

	const reply = await route({
		method: req.method,
		url: req.url,
		token: req.headers["x-bridge-token"] as string | undefined,
		body,
	});

	res
		.writeHead(reply.status, { "content-type": "application/json" })
		.end(reply.body);
}).listen(PORT, "127.0.0.1", () => {
	console.log(`host bridge on http://127.0.0.1:${PORT}  repo=${repoPath}`);
});
