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
	/** Whether the restart is still waiting on earlier work and can be called off. */
	waiting(waiting: boolean): void;
}

type Capture = { participant: UpdateParticipant; capture: UpdateCapture };

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
			this.refuseBlocked();
			if (await this.unlessCancelled(this.host.settle()))
				await this.prepareAndInstall(version);
		} finally {
			this.running = false;
		}
	}

	/** Call off a restart still waiting on earlier work. */
	cancel(): void {
		this.stopWaiting?.();
	}

	private refuseBlocked(): void {
		for (const participant of this.participants) {
			const { blocker } = participant.capture();
			if (blocker) throw new Error(blocker);
		}
	}

	private async unlessCancelled(work: Promise<void>): Promise<boolean> {
		const cancelled = new Promise<false>((resolve) => {
			this.stopWaiting = () => resolve(false);
		});
		this.host.waiting(true);
		try {
			return await Promise.race([work.then(() => true), cancelled]);
		} finally {
			this.stopWaiting = null;
			this.host.waiting(false);
		}
	}

	private async prepareAndInstall(version: string): Promise<void> {
		this.host.freeze(true);
		let captures: Capture[];
		let permit: string;
		try {
			captures = this.capture();
			permit = await this.host.prepare(version);
		} catch (error) {
			this.host.freeze(false);
			throw error;
		}

		try {
			if (await this.unlessCancelled(this.host.drained(permit))) {
				await this.flushAndInstall(version, permit, captures);
				return;
			}
		} catch (error) {
			await this.stop(permit, captures, error);
			throw error;
		}

		await this.stop(permit, captures, null);
	}

	private capture(): Capture[] {
		const captures = [...this.participants].map((participant) => ({
			participant,
			capture: participant.capture(),
		}));

		for (const { capture } of captures) {
			if (capture.blocker) throw new Error(capture.blocker);
		}

		return captures;
	}

	private async flushAndInstall(
		version: string,
		permit: string,
		captures: Capture[],
	): Promise<void> {
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

		await this.host.install(version, permit);
	}

	/** Reopen Trunk after a preparation that will not install, and clear the
	 *  recovery snapshots its flushes may have written. */
	private async stop(
		token: string,
		captures: Capture[],
		cause: unknown,
	): Promise<void> {
		await this.host.abort(token);
		this.host.freeze(false);
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
				cause === null ? failures : [cause, ...failures],
				"The update was stopped, but some recovery snapshots could not be cleared. You can keep working; draft recovery may need attention on the next launch.",
			);
	}
}

let frozen = false;

export function isUpdateFrozen(): boolean {
	return frozen;
}

export function setUpdateFrozen(value: boolean): void {
	frozen = value;
}
