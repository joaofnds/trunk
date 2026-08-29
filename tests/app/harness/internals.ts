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
	invoke<T>(cmd: string, args?: unknown): Promise<T>;
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
export class TauriInternals {
	private readonly callbacks = new Map<number, Callback>();
	private readonly listeners = new Map<number, Listener>();
	private readonly registering = new Set<Promise<number>>();
	private readonly records: InvokeRecord[] = [];
	private readonly fakes = new Map<string, TauriFake>();
	private nextCallbackId = 1;
	private closed = false;

	constructor(private readonly host: HostChannel) {}

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

	install(): void {
		this.host.onEvent((event, payload) => this.deliver(event, payload));

		window.__TAURI_INTERNALS__ = {
			invoke: (cmd: string, args: Record<string, unknown> = {}) =>
				this.invoke(cmd, args),
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
		this.records.push({ cmd, args });

		if (cmd === LISTEN) return await this.listen(args);
		// A frontend `emit` goes to the host as a command, not through the host's
		// own `emit` verb, so it travels the real plugin and the real ACL. Without
		// this route the toolbar's own buttons reject below with no Fake to answer
		// them, and an unhandled rejection is all the test sees.
		if (cmd === UNLISTEN || cmd === EMIT)
			return await this.host.invoke(cmd, args);
		if (!cmd.startsWith("plugin:")) return await this.host.invoke(cmd, args);

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
		const registration = this.host.invoke<number>(LISTEN, args).then((id) => {
			this.listeners.set(id, {
				event: args.event as string,
				callbackId: args.handler as number,
			});
			return id;
		});

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

		for (const [eventId, listener] of this.listeners) {
			if (listener.event !== event) continue;
			this.runCallback(listener.callbackId, {
				event,
				id: eventId,
				payload,
			});
		}
	}
}

function pluginOf(cmd: string): string {
	return cmd.slice("plugin:".length).split("|")[0];
}

function commandOf(cmd: string): string {
	return cmd.slice(cmd.indexOf("|") + 1);
}
