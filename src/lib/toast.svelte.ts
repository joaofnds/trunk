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
	_nextId = 0;
}

export function showToast(
	message: string,
	kind: ToastKind = "success",
	ms = 3000,
): void {
	const id = _nextId++;
	_toasts = [..._toasts, { id, message, kind }];
	setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
	_toasts = _toasts.filter((t) => t.id !== id);
}
