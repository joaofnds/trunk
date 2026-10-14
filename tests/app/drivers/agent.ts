import type { HostClient } from "../harness/host-client.js";

/** An agent working the review from outside the app, through the `trunk` CLI. */
export class AgentDriver {
	constructor(
		private readonly host: HostClient,
		private readonly repoPath: string,
	) {}

	/** Answers a thread on the agent channel. */
	async reply(thread: string, text: string): Promise<void> {
		await this.host.cli([
			"review",
			"reply",
			thread,
			text,
			"--repo",
			this.repoPath,
		]);
	}
}
