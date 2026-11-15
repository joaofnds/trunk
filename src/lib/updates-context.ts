import { getContext, onDestroy, setContext } from "svelte";
import type {
	UpdateParticipant,
	UpdatePreparation,
} from "./updates-lifecycle.js";

const UPDATE_PREPARATION = Symbol("update-preparation");

export function provideUpdatePreparation(preparation: UpdatePreparation): void {
	setContext(UPDATE_PREPARATION, preparation);
}

export function registerUpdateParticipant(
	participant: UpdateParticipant,
): void {
	const preparation = getContext<UpdatePreparation | undefined>(
		UPDATE_PREPARATION,
	);
	if (preparation) onDestroy(preparation.register(participant));
}

export function registerUpdateBlocker(reason: () => string | null): void {
	registerUpdateParticipant({
		capture: () => ({
			generation: reason() ?? "",
			blocker: reason(),
			flush: async () => {},
		}),
	});
}
