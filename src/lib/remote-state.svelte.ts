import type { FetchReport } from "./autofetch-status.js";
import type { TrunkError } from "./invoke.js";

export type RemoteOpKind = "push" | "pull" | "fetch";

export interface RemoteState {
	isRunning: boolean;
	progressLine: string;
	error: TrunkError | null;
	lastOp: RemoteOpKind | null;
	fetchCompleted(): void;
	autofetch?: FetchReport;
}

export function createRemoteState(
	fetchCompleted: () => void = () => {},
): RemoteState {
	const state: RemoteState = $state({
		isRunning: false,
		progressLine: "",
		error: null as TrunkError | null,
		lastOp: null as RemoteOpKind | null,
		fetchCompleted,
	});
	return state;
}

// DEPRECATED: singleton for backward compat until Plan 02 updates consumers
export const remoteState: RemoteState = createRemoteState();
