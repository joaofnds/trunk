export interface UpdateCapture {
	readonly generation: string;
	readonly blocker: string | null;
	flush(permit: string): Promise<void>;
	discard?(): Promise<void>;
}

export interface UpdateParticipant {
	capture(): UpdateCapture;
}

interface PreparationHost {
	prepare(version: string): Promise<string>;
	drained(token: string): Promise<void>;
	install(version: string, token: string): Promise<void>;
	abort(token: string): Promise<unknown>;
	freeze(frozen: boolean): void;
	settle(): Promise<void>;
}

export class UpdatePreparation {
	private readonly participants = new Set<UpdateParticipant>();
	private running = false;
	private stopWaiting: (() => void) | null = null;

	constructor(private readonly host: PreparationHost) {}

	register(participant: UpdateParticipant): () => void {
		this.participants.add(participant);
		return () => this.participants.delete(participant);
	}

	/** Restart once the work running at the click has finished, unless cancelled first. */
	async install(version: string): Promise<void> {
		if (this.running) throw new Error("An update is already being prepared.");
		this.running = true;
		try {
			if (await this.earlierWorkSettles())
				await this.prepareAndInstall(version);
		} finally {
			this.running = false;
		}
	}

	/** Stop a restart still waiting on earlier work. */
	cancel(): void {
		this.stopWaiting?.();
	}

	private async earlierWorkSettles(): Promise<boolean> {
		const cancelled = new Promise<false>((resolve) => {
			this.stopWaiting = () => resolve(false);
		});
		try {
			return await Promise.race([
				this.host.settle().then(() => true),
				cancelled,
			]);
		} finally {
			this.stopWaiting = null;
		}
	}

	private async prepareAndInstall(version: string): Promise<void> {
		this.host.freeze(true);
		let token: string | undefined;
		let captures: { participant: UpdateParticipant; capture: UpdateCapture }[] =
			[];
		try {
			captures = [...this.participants].map((participant) => ({
				participant,
				capture: participant.capture(),
			}));
			for (const { capture } of captures) {
				if (capture.blocker) throw new Error(capture.blocker);
			}

			const permit = await this.host.prepare(version);
			token = permit;
			await this.host.drained(permit);
			const results = await Promise.allSettled(
				captures.map(({ capture }) =>
					Promise.resolve().then(() => capture.flush(permit)),
				),
			);
			for (const result of results) {
				if (result.status === "rejected") throw result.reason;
			}
			if (captures.length !== this.participants.size)
				throw new Error(
					"Open editors changed while preparing the update. Try again.",
				);
			for (const { participant, capture } of captures) {
				const current = participant.capture();
				if (
					!this.participants.has(participant) ||
					current.blocker ||
					current.generation !== capture.generation
				)
					throw new Error(
						"A draft changed while preparing the update. Try again.",
					);
			}

			await this.host.install(version, token);
		} catch (error) {
			if (token !== undefined) await this.host.abort(token);
			this.host.freeze(false);
			if (token !== undefined) {
				const cleanup = await Promise.allSettled(
					captures.map(({ capture }) =>
						Promise.resolve().then(() => capture.discard?.()),
					),
				);
				const failures = cleanup.flatMap((result) =>
					result.status === "rejected" ? [result.reason] : [],
				);
				if (failures.length > 0)
					throw new AggregateError(
						[error, ...failures],
						"The update was stopped, but some recovery snapshots could not be cleared. You can keep working; draft recovery may need attention on the next launch.",
					);
			}
			throw error;
		}
	}
}

let frozen = false;

export function isUpdateFrozen(): boolean {
	return frozen;
}

export function setUpdateFrozen(value: boolean): void {
	frozen = value;
}
