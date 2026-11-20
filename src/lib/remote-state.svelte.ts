import type { FetchReport } from "./autofetch-status.js";
import type { TrunkError } from "./invoke.js";

export type RemoteOpKind = "push" | "pull" | "fetch";

export interface RemoteState {
	isRunning: boolean;
	error: TrunkError | null;
	/** The operation whose failure `error` reports, which a later one leaves alone. */
	failedOp: RemoteOpKind | null;
	lastOp: RemoteOpKind | null;
	fetchCompleted(): void;
	autofetch?: FetchReport;
}

export function createRemoteState(
	fetchCompleted: () => void = () => {},
): RemoteState {
	const state: RemoteState = $state({
		isRunning: false,
		error: null as TrunkError | null,
		failedOp: null as RemoteOpKind | null,
		lastOp: null as RemoteOpKind | null,
		fetchCompleted,
	});
	return state;
}

// DEPRECATED: singleton for backward compat until Plan 02 updates consumers
export const remoteState: RemoteState = createRemoteState();
