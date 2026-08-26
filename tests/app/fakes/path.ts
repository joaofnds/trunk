import { BaseDirectory } from "@tauri-apps/api/path";
import { type TauriFake, UnknownFakeCommand } from "./index.js";

/**
 * The directories the real `path` plugin resolves from the process environment.
 * The harness seeds `Home` with the host's tempdir, which is where the host's
 * own `app_data_dir()` resolves, so both sides of the boundary agree on where
 * this application lives.
 */
export class FakePath implements TauriFake {
	readonly plugin = "path";
	private home: string;

	constructor(private readonly defaultHome: string) {
		this.home = defaultHome;
	}

	setHome(path: string): void {
		this.home = path;
	}

	reset(): void {
		this.home = this.defaultHome;
	}

	answer(command: string, args: Record<string, unknown>): unknown {
		if (command !== "resolve_directory") {
			throw new UnknownFakeCommand(this.plugin, command);
		}
		if (args.directory !== BaseDirectory.Home) {
			throw new UnknownFakeCommand(
				this.plugin,
				`${command} for directory ${String(args.directory)}`,
			);
		}
		return this.home;
	}
}
