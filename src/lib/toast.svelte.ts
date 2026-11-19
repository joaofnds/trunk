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

/**
 * Shows `message`. A success dismisses itself after `ms`. An error says why
 * something the user asked for did not happen, so it stays until clicked, and
 * an error already on screen is not shown twice.
 */
export function showToast(
	message: string,
	kind: ToastKind = "success",
	ms = 3000,
): void {
	if (
		kind === "error" &&
		_toasts.some((t) => t.kind === "error" && t.message === message)
	) {
		return;
	}

	const id = _nextId++;
	_toasts = [..._toasts, { id, message, kind }];
	if (kind === "success") {
		setTimeout(() => dismissToast(id), ms);
	}
}

export function dismissToast(id: number): void {
	_toasts = _toasts.filter((t) => t.id !== id);
}
