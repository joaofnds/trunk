import { describe, expect, it } from "vitest";
import { createRouter, type Invoker } from "./router.js";

function invoker(): Invoker & { calls: Array<{ cmd: string }> } {
	const calls: Array<{ cmd: string }> = [];
	return Object.assign(
		async (cmd: string) => {
			calls.push({ cmd });
			return null;
		},
		{ calls },
	);
}

const context = { home: "/tmp/home", repoPath: "/tmp/home/repo" };

function router(invoke: Invoker, token = "secret") {
	return createRouter({ token, invoke, context, events: [] });
}

describe("measurement bridge router", () => {
	it("dispatches an invoke that carries the run's token", async () => {
		const invoke = invoker();
		const reply = await router(invoke)({
			method: "POST",
			url: "/invoke",
			token: "secret",
			body: JSON.stringify({ cmd: "open_repo", args: {} }),
		});

		expect(reply.status).toBe(200);
		expect(invoke.calls).toEqual([{ cmd: "open_repo" }]);
	});

	it("refuses an invoke with no token before it reaches the host", async () => {
		const invoke = invoker();
		const reply = await router(invoke)({
			method: "POST",
			url: "/invoke",
			token: undefined,
			body: JSON.stringify({ cmd: "discard_all", args: {} }),
		});

		expect(reply.status).toBe(403);
		expect(invoke.calls).toEqual([]);
	});

	it("refuses an invoke whose token is wrong before it reaches the host", async () => {
		const invoke = invoker();
		const reply = await router(invoke)({
			method: "POST",
			url: "/invoke",
			token: "guessed",
			body: JSON.stringify({ cmd: "reset_to_commit", args: {} }),
		});

		expect(reply.status).toBe(403);
		expect(invoke.calls).toEqual([]);
	});

	it("guards the state-carrying reads with the same token", async () => {
		const unauthenticated = router(invoker());

		expect(
			(await unauthenticated({ method: "GET", url: "/home" })).status,
		).toBe(403);
		expect(
			(await unauthenticated({ method: "GET", url: "/events" })).status,
		).toBe(403);
	});

	it("answers a malformed body with 400 rather than throwing", async () => {
		const invoke = invoker();
		const reply = await router(invoke)({
			method: "POST",
			url: "/invoke",
			token: "secret",
			body: "{",
		});

		expect(reply.status).toBe(400);
		expect(invoke.calls).toEqual([]);
	});

	it("answers a body that is not an invoke with 400", async () => {
		const invoke = invoker();
		const reply = await router(invoke)({
			method: "POST",
			url: "/invoke",
			token: "secret",
			body: JSON.stringify({ args: {} }),
		});

		expect(reply.status).toBe(400);
		expect(invoke.calls).toEqual([]);
	});

	it("drains each queued event exactly once", async () => {
		const events = [{ event: "a", payload: 1 }];
		const route = createRouter({
			token: "secret",
			invoke: invoker(),
			context,
			events,
		});

		const first = await route({
			method: "GET",
			url: "/events",
			token: "secret",
		});
		const second = await route({
			method: "GET",
			url: "/events",
			token: "secret",
		});

		expect(JSON.parse(first.body)).toEqual([{ event: "a", payload: 1 }]);
		expect(JSON.parse(second.body)).toEqual([]);
	});

	it("reports a host failure as a handled result, not a transport error", async () => {
		const failing: Invoker = async () => {
			throw new Error("no such repo");
		};
		const reply = await router(failing)({
			method: "POST",
			url: "/invoke",
			token: "secret",
			body: JSON.stringify({ cmd: "open_repo", args: {} }),
		});

		expect(reply.status).toBe(200);
		expect(JSON.parse(reply.body)).toMatchObject({ ok: false });
	});

	it("has no route for anything else", async () => {
		const reply = await router(invoker())({
			method: "GET",
			url: "/../etc/passwd",
			token: "secret",
		});

		expect(reply.status).toBe(404);
	});
});
