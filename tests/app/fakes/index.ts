/**
 * A Tauri surface the harness answers itself rather than running real. Each Fake
 * implements one plugin's command set, holds the state that plugin holds, and
 * exposes named seed verbs plus `reset()`, so a test arranges through the driver
 * instead of poking at fields.
 */
export interface TauriFake {
	/** The plugin segment of `plugin:<name>|<command>`. */
	readonly plugin: string;
	answer(command: string, args: Record<string, unknown>): unknown;
	reset(): void;
}

export class UnknownFakeCommand extends Error {
	constructor(plugin: string, command: string) {
		super(`the ${plugin} fake has no answer for ${command}`);
	}
}
