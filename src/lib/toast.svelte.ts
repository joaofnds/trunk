export type ToastKind = "success" | "error";

export interface Toast {
	id: number;
	message: string;
	kind: ToastKind;
}

let _toasts = $state<Toast[]>([]);
let _nextId = 0;

export const toasts = {
	get items(): Toast[] {
		return _toasts;
	},
};

/** Reset store state — for use in tests only */
export function _resetToasts(): void {
	_toasts = [];
}

/** More errors than this would stack past the top of the window, out of reach. */
const MAX_ERRORS = 3;

/**
 * Shows `message`. A success closes itself after `ms`, and clears the errors on
 * screen, since the user has moved on and an old reason would read as current.
 * An error says why something the user asked for did not happen, so it stays
 * until clicked. An error already on screen is not shown twice, and past
 * `MAX_ERRORS` the oldest goes.
 */
export function showToast(
	message: string,
	kind: ToastKind = "success",
	ms = 3000,
): void {
	if (kind === "success") {
		showSuccess(message, ms);
	} else {
		showError(message);
	}
}

function showSuccess(message: string, ms: number): void {
	const id = _nextId++;
	_toasts = [
		..._toasts.filter((t) => t.kind !== "error"),
		{ id, message, kind: "success" },
	];
	setTimeout(() => dismissToast(id), ms);
}

function showError(message: string): void {
	if (_toasts.some((t) => t.kind === "error" && t.message === message)) return;

	const errors = _toasts.filter((t) => t.kind === "error");
	const dropped = new Set(errors.slice(0, errors.length - MAX_ERRORS + 1));
	_toasts = [
		..._toasts.filter((t) => !dropped.has(t)),
		{ id: _nextId++, message, kind: "error" },
	];
}

export function dismissToast(id: number): void {
	_toasts = _toasts.filter((t) => t.id !== id);
}
