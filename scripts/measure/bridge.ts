/**
 * Puts the application harness's host behind HTTP so a real browser can be the
 * DOM. `tests/app/harness` reaches the host over stdio from node; a page cannot,
 * and jsdom reports no layout, so neither one can answer "how tall does this
 * actually render". This serves the same host to `scripts/measure/boot.ts`.
 */
import { createServer } from "node:http";
import {
	HostClient,
	type RepoSpec,
} from "../../tests/app/harness/host-client.js";

const PORT = 8732;

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

const events: Array<{ event: string; payload: unknown }> = [];
host.onEvent((event, payload) => events.push({ event, payload }));

function cors(res: import("node:http").ServerResponse): void {
	res.setHeader("access-control-allow-origin", "*");
	res.setHeader("access-control-allow-headers", "content-type");
}

createServer(async (req, res) => {
	cors(res);
	if (req.method === "OPTIONS") return res.writeHead(204).end();

	if (req.url === "/home") {
		return res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ home: host.home, repoPath }));
	}

	if (req.url === "/events") {
		const drained = events.splice(0, events.length);
		return res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify(drained));
	}

	if (req.url === "/invoke" && req.method === "POST") {
		const body = await new Promise<string>((resolve) => {
			let text = "";
			req.on("data", (chunk) => (text += chunk));
			req.on("end", () => resolve(text));
		});
		const { cmd, args } = JSON.parse(body);
		try {
			const value = await host.invoke(cmd, args);
			return res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ ok: true, value: value ?? null }));
		} catch (error) {
			return res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ ok: false, error: String(error) }));
		}
	}

	res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => {
	console.log(`host bridge on http://127.0.0.1:${PORT}  repo=${repoPath}`);
});
