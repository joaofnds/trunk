import type { GraphResponse } from "../../../src/lib/types.js";
import type { TauriFake } from "../fakes/index.js";
import type { EventHandler } from "./host-client.js";

declare global {
	interface Window {
		__TAURI_INTERNALS__?: Record<string, unknown>;
	}
}

/** All `TauriInternals` needs of a host: a command channel and an event feed.
 *  `HostClient` (stdio) and the measurement bridge's HTTP host both satisfy it,
 *  so neither one has to be cast to the other. */
export interface HostChannel {
	/**
	 * `onReply` runs as the reply is read, before anything the host wrote after
	 * it. The promise settles a microtask later, and a line read behind the
	 * reply in the same chunk has already been handled by then.
	 */
	invoke<T>(
		cmd: string,
		args?: unknown,
		onReply?: (value: T) => void,
	): Promise<T>;
	onEvent(handler: EventHandler): void;
}

export interface InvokeRecord {
	cmd: string;
	args: Record<string, unknown>;
}

interface Callback {
	handler: (payload: unknown) => void;
	once: boolean;
}

interface Listener {
	event: string;
	callbackId: number;
}

const LISTEN = "plugin:event|listen";
const UNLISTEN = "plugin:event|unlisten";
const EMIT = "plugin:event|emit";
const WINDOW_LABEL = "main";
const TRAIL_LENGTH = 100;

/**
 * The transport seam. `@tauri-apps/api` reaches the runtime only through
 * `window.__TAURI_INTERNALS__`, so installing this before the application root
 * mounts routes every call without a single module mock.
 *
 * Trunk's own commands, the two event-registration commands and the frontend's
 * own emits go to the host, which means the real ACL, the real id allocation and
 * the real Rust registration are all inside the box. Only the delivery hop is
 * the harness's:
 * Tauri delivers an event by evaluating a script this side cannot observe, so
 * the host mirrors each emit onto stdout and dispatch runs from the id map here.
 */
/** A held `prefs_get` call, keyed by the pref it asked for, and how to let it
 *  proceed to the real host. */
interface HeldRead {
	key: string;
	release: () => void;
}

interface HeldCommandReply {
	command: string;
	entered: () => void;
	resumed: Promise<void>;
}

export class TauriInternals {
	private readonly callbacks = new Map<number, Callback>();
	private readonly listeners = new Map<number, Listener>();
	private readonly registering = new Set<Promise<number>>();
	private readonly records: InvokeRecord[] = [];
	private readonly fakes = new Map<string, TauriFake>();
	private nextCallbackId = 1;
	private closed = false;
	/** Set by `holdPrefsGet`; every `prefs_get` for that key stalls at this seam
	 *  until `release()` runs, rather than reaching the host. */
	private heldPrefsKey: string | null = null;
	private readonly heldReads: HeldRead[] = [];
	private holdsCommand: ((record: InvokeRecord) => boolean) | null = null;
	private readonly heldCommands: Array<() => void> = [];
	private heldReply?: HeldCommandReply;
	private inFlight = 0;
	private readonly trail: string[] = [];

	constructor(private readonly host: HostChannel) {}

	/**
	 * Freezes every `prefs_get` for `key` at this seam instead of forwarding it,
	 * so a test can inspect a render from before the read resolves — a barrier on
	 * the call itself, not a wall-clock delay. Returns the release: call it once
	 * the test has taken its snapshot, and every call gated so far (there may be
	 * more than one caller of the same pref) proceeds to the host.
	 */
	holdPrefsGet(key: string): () => void {
		this.heldPrefsKey = key;
		return () => {
			this.heldPrefsKey = null;
			const held = this.heldReads.splice(0);
			for (const read of held) read.release();
		};
	}

	/** Freezes every invocation of `command` at the frontend transport seam.
	 * The returned release lets a scenario observe state while the real host
	 * response is still pending. */
	holdCommand(
		command: string | ((record: InvokeRecord) => boolean),
	): () => void {
		this.holdsCommand =
			typeof command === "string" ? ({ cmd }) => cmd === command : command;
		return () => {
			this.holdsCommand = null;
			const held = this.heldCommands.splice(0);
			for (const release of held) release();
		};
	}

	/** Leaves the real host's successful reply pending in the frontend. */
	holdNextCommandReply(command: string): {
		entered: Promise<void>;
		release: () => void;
	} {
		const entered = Promise.withResolvers<void>();
		const resumed = Promise.withResolvers<void>();
		this.heldReply = {
			command,
			entered: entered.resolve,
			resumed: resumed.promise,
		};
		return { entered: entered.promise, release: resumed.resolve };
	}

	/** Points every `plugin:` command at the Fake that owns it. Separate from
	 *  construction because a Fake whose surface is callback-driven needs this
	 *  object to dispatch through. */
	route(fakes: TauriFake[]): void {
		for (const fake of fakes) this.fakes.set(fake.plugin, fake);
	}

	/** Every command the harness routed, in the order it saw them. */
	get invokes(): readonly InvokeRecord[] {
		return this.records;
	}

	/** Commands the application has sent and not yet had its answer back for,
	 *  wherever they wait: held here, at the host, or at a Fake. */
	get pendingInvokes(): number {
		return this.inFlight;
	}

	/**
	 * The latest commands sent, their answers and the events read, one a line in
	 * the order they happened. An assertion that fails on a stale screen says
	 * only what the screen showed. This says which read the application made
	 * after the change it was told about, and whether its answer came back.
	 */
	describeTrail(): string {
		return this.trail.join("\n");
	}

	install(): void {
		this.host.onEvent((event, payload) => this.deliver(event, payload));

		window.__TAURI_INTERNALS__ = {
			invoke: (cmd: string, args: Record<string, unknown> = {}) =>
				this.counted(cmd, args, this.invoke(cmd, args)),
			transformCallback: (handler: (payload: unknown) => void, once = false) =>
				this.transformCallback(handler, once),
			unregisterCallback: (id: number) => this.callbacks.delete(id),
			runCallback: (id: number, payload: unknown) =>
				this.runCallback(id, payload),
			convertFileSrc: (filePath: string, protocol = "asset") =>
				`${protocol}://localhost/${encodeURIComponent(filePath)}`,
			metadata: {
				currentWindow: { label: WINDOW_LABEL },
				currentWebview: { label: WINDOW_LABEL },
			},
			plugins: { path: { sep: "/", delimiter: ":" } },
		};

		window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
			unregisterListener: (_event: string, eventId: number) =>
				this.unregisterListener(eventId),
		};
	}

	/**
	 * Leaves the seam in place but quiescent, rather than removing it. Unmounting
	 * the application tears effects down while their `listen` promises are still
	 * resolving, and each of those reaches for `transformCallback` on the way out;
	 * a seam that has vanished turns an ordinary shutdown into a `TypeError`. The
	 * next `setup` replaces the whole object.
	 */
	uninstall(): void {
		this.closed = true;
	}

	private async invoke(
		cmd: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		if (this.closed) return null;
		const record = { cmd, args };
		this.records.push(record);
		if (this.holdsCommand?.(record)) {
			await new Promise<void>((release) => {
				this.heldCommands.push(release);
			});
		}

		if (cmd === LISTEN) return await this.listen(args);
		// A frontend `emit` goes to the host as a command, not through the host's
		// own `emit` verb, so it travels the real plugin and the real ACL. Without
		// this route the toolbar's own buttons reject below with no Fake to answer
		// them, and an unhandled rejection is all the test sees.
		if (cmd === UNLISTEN || cmd === EMIT)
			return await this.host.invoke(cmd, args);
		if (!cmd.startsWith("plugin:")) {
			if (cmd === "prefs_get" && args.key === this.heldPrefsKey) {
				await new Promise<void>((release) => {
					this.heldReads.push({ key: args.key as string, release });
				});
			}
			const reply =
				this.heldReply?.command === cmd ? this.heldReply : undefined;
			if (reply) this.heldReply = undefined;
			const result = await this.host.invoke(cmd, args);
			if (reply) {
				reply.entered();
				await reply.resumed;
			}
			return result;
		}

		return this.fake(cmd).answer(commandOf(cmd), args);
	}

	/**
	 * A `plugin:` command with no Fake and no host route rejects, naming itself.
	 * Nine commands answered `undefined` over the mocked transport during
	 * milestone 1 with nothing noticing: a silent `undefined` from a clipboard
	 * write reads as a copy that copied nothing.
	 */
	private fake(cmd: string): TauriFake {
		const fake = this.fakes.get(pluginOf(cmd));
		if (!fake) throw new Error(`no route for ${cmd}`);
		return fake;
	}

	private listen(args: Record<string, unknown>): Promise<number> {
		const listener = {
			event: args.event as string,
			callbackId: args.handler as number,
		};
		const registration = this.host.invoke<number>(LISTEN, args, (id) =>
			this.listeners.set(id, listener),
		);

		this.registering.add(registration);
		void registration
			.catch(() => undefined)
			.then(() => this.registering.delete(registration));

		return registration;
	}

	/**
	 * Resolves once every `listen` the application has already called has reached
	 * the map `deliver` reads. Registering costs a host round trip, so a `listen`
	 * issued while the application mounts is still in flight when the driver's
	 * readiness wait — a commit row on screen — is already satisfied. The real
	 * watcher emits `repo-changed` again and again and never notices; a test emits
	 * once, and the listener that missed it never hears about the change at all
	 * (TRUNK-45).
	 */
	async registrationsSettled(): Promise<void> {
		while (this.registering.size > 0) {
			await Promise.allSettled([...this.registering]);
		}
	}

	// Hands the application the answer itself rather than a promise chained on
	// it, so counting a command adds no turn before the application sees it.
	private counted(
		cmd: string,
		args: Record<string, unknown>,
		answer: Promise<unknown>,
	): Promise<unknown> {
		this.inFlight += 1;
		const { path: _path, ...named } = args;
		const detail = Object.keys(named).length ? ` ${JSON.stringify(named)}` : "";
		this.record(`sent ${cmd}${detail}`);
		const answered = (value?: unknown) => {
			this.inFlight -= 1;
			this.record(`answered ${cmd}${graphContent(value)}`);
		};
		answer.then(answered, () => answered());
		return answer;
	}

	/** Puts a step of the test itself in the trail, so the trail orders the
	 *  test's reads against the application's commands. */
	mark(step: string): void {
		this.record(`test: ${step}`);
	}

	private transformCallback(
		handler: (payload: unknown) => void,
		once: boolean,
	): number {
		const id = this.nextCallbackId++;
		this.callbacks.set(id, { handler, once });
		return id;
	}

	runCallback(id: number, payload: unknown): void {
		const callback = this.callbacks.get(id);
		if (!callback) return;
		if (callback.once) this.callbacks.delete(id);
		callback.handler(payload);
	}

	private unregisterListener(eventId: number): void {
		const listener = this.listeners.get(eventId);
		if (!listener) return;
		this.listeners.delete(eventId);
		this.callbacks.delete(listener.callbackId);
	}

	private deliver(event: string, payload: unknown): void {
		if (this.closed) return;

		const heard = [...this.listeners.values()].filter(
			(listener) => listener.event === event,
		).length;
		this.record(
			`read event ${event} ${JSON.stringify(payload)}, heard by ${heard} listeners`,
		);
		for (const [eventId, listener] of this.listeners) {
			if (listener.event !== event) continue;
			this.runCallback(listener.callbackId, {
				event,
				id: eventId,
				payload,
			});
		}
	}

	private record(entry: string): void {
		this.trail.push(entry);
		if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
	}
}

/** What a graph answer held, so a stale screen can be told from a stale answer. */
function graphContent(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const { commits, revision, checked } = value as Partial<GraphResponse>;
	if (!Array.isArray(commits) || typeof revision !== "number") return "";
	const subjects = commits.map((commit) => commit.summary);

	return ` ${JSON.stringify({ revision, checked, subjects })}`;
}

function pluginOf(cmd: string): string {
	return cmd.slice("plugin:".length).split("|")[0];
}

function commandOf(cmd: string): string {
	return cmd.slice(cmd.indexOf("|") + 1);
}
