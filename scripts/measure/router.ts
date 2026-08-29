/**
 * The measurement bridge's request handling, apart from the socket that carries
 * it. The host it dispatches to is the real Trunk command set, including the
 * destructive ones, so every route is behind a per-run token: a page that cannot
 * read the token cannot reach the host, whatever origin it is served from.
 */

export type Invoker = (
	cmd: string,
	args: Record<string, unknown>,
) => Promise<unknown>;

export interface BridgeEvent {
	event: string;
	payload: unknown;
}

export interface BridgeContext {
	home: string;
	repoPath: string;
}

export interface Request {
	method: string | undefined;
	url: string | undefined;
	token?: string | undefined;
	body?: string;
}

export interface Reply {
	status: number;
	body: string;
}

export interface RouterOptions {
	token: string;
	invoke: Invoker;
	context: BridgeContext;
	events: BridgeEvent[];
}

function json(status: number, value: unknown): Reply {
	return { status, body: JSON.stringify(value) };
}

/** `{ cmd, args }` or nothing — the body arrives from a socket, so it is parsed
 *  once here and never trusted as a shape. */
function parseInvoke(
	body: string | undefined,
): { cmd: string; args: Record<string, unknown> } | null {
	if (body === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { cmd, args } = parsed as { cmd?: unknown; args?: unknown };
	if (typeof cmd !== "string") return null;
	if (args !== undefined && (typeof args !== "object" || args === null))
		return null;
	return { cmd, args: (args ?? {}) as Record<string, unknown> };
}

export function createRouter({
	token,
	invoke,
	context,
	events,
}: RouterOptions): (request: Request) => Promise<Reply> {
	return async (request) => {
		if (request.token !== token) return json(403, { error: "forbidden" });

		if (request.url === "/home" && request.method === "GET")
			return json(200, context);

		if (request.url === "/events" && request.method === "GET")
			return json(200, events.splice(0, events.length));

		if (request.url === "/invoke" && request.method === "POST") {
			const call = parseInvoke(request.body);
			if (call === null) return json(400, { error: "expected { cmd, args }" });
			try {
				const value = await invoke(call.cmd, call.args);
				return json(200, { ok: true, value: value ?? null });
			} catch (error) {
				return json(200, { ok: false, error: String(error) });
			}
		}

		return json(404, { error: "no such route" });
	};
}
