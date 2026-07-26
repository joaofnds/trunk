import type { TrunkError } from "./invoke.js";

export type RemoteOpKind = "push" | "pull" | "fetch";

export interface RemoteState {
	isRunning: boolean;
	progressLine: string;
	error: TrunkError | null;
	lastOp: RemoteOpKind | null;
}

export function createRemoteState(): RemoteState {
	const state: RemoteState = $state({
		isRunning: false,
		progressLine: "",
		error: null as TrunkError | null,
		lastOp: null as RemoteOpKind | null,
	});
	return state;
}

// DEPRECATED: singleton for backward compat until Plan 02 updates consumers
export const remoteState: RemoteState = createRemoteState();
