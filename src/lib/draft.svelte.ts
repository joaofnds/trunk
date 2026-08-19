/**
 * Shared open/cancel/commit state machine for a single-field draft editor —
 * the trim-empty-disables-submit pattern behind every add-note, edit, and
 * reply composer in the review UI (root edit, reply edit, reply composer,
 * commit-note composers). `text` is a plain mutable property so
 * `bind:value={draft.text}` works directly; `valid` is derived.
 *
 * A host that never explicitly opens/closes (an always-visible composer)
 * simply ignores `editing`/`open`/`close` and drives `text`/`valid` directly,
 * calling `close()` only to clear the field after a successful submit.
 */
export interface Draft {
	readonly editing: boolean;
	text: string;
	readonly valid: boolean;
	/** Begins editing, seeding the text (defaults to empty). */
	open(seed?: string): void;
	/** Ends editing and clears the text — used for both cancel and the reset
	    after a successful commit; the two share the same target state. */
	close(): void;
}

export function createDraft(): Draft {
	const state = $state({ editing: false, text: "" });
	const valid = $derived(state.text.trim().length > 0);

	return {
		get editing() {
			return state.editing;
		},
		get text() {
			return state.text;
		},
		set text(value: string) {
			state.text = value;
		},
		get valid() {
			return valid;
		},
		open(seed = "") {
			state.text = seed;
			state.editing = true;
		},
		close() {
			state.editing = false;
			state.text = "";
		},
	};
}
