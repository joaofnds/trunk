import type { EventHandler } from "../harness/host-client.js";
import type { HostChannel } from "../harness/internals.js";

interface Unanswered {
	onReply?: (value: unknown) => void;
	resolve: (value: unknown) => void;
}

/**
 * A host the test answers by hand, so a reply and an event push can be placed
 * in one synchronous turn or the other way round. The real host's stdout reader
 * fires every line of one chunk before a microtask runs, and this is how a test
 * says which lines shared a chunk.
 */
export class FakeHostChannel implements HostChannel {
	private readonly handlers: EventHandler[] = [];
	private readonly unanswered: Unanswered[] = [];

	invoke<T>(
		_cmd: string,
		_args?: unknown,
		onReply?: (value: T) => void,
	): Promise<T> {
		return new Promise<T>((resolve) => {
			this.unanswered.push({
				onReply: onReply as ((value: unknown) => void) | undefined,
				resolve: resolve as (value: unknown) => void,
			});
		});
	}

	onEvent(handler: EventHandler): void {
		this.handlers.push(handler);
	}

	/** Answers the oldest command still waiting, the way one reply line does. */
	reply(value: unknown): void {
		const request = this.unanswered.shift();
		if (!request) throw new Error("no command is waiting for a reply");

		request.onReply?.(value);
		request.resolve(value);
	}

	/** Pushes an event, the way one event line does. */
	push(event: string, payload: unknown): void {
		for (const handler of this.handlers) handler(event, payload);
	}
}
