import type { TabInfo } from "./tab-types.js";

export type TabStep = -1 | 1;

export function canMoveTab(
	tabs: readonly TabInfo[],
	id: string,
	step: TabStep,
): boolean {
	const from = tabs.findIndex((tab) => tab.id === id);
	if (from === -1) return false;

	const to = from + step;
	return to >= 0 && to < tabs.length;
}

export function moveTab(
	tabs: readonly TabInfo[],
	id: string,
	step: TabStep,
): TabInfo[] {
	if (!canMoveTab(tabs, id, step)) return [...tabs];

	const from = tabs.findIndex((tab) => tab.id === id);
	return moveTabTo(tabs, from, from + step);
}

export function moveTabTo(
	tabs: readonly TabInfo[],
	from: number,
	to: number,
): TabInfo[] {
	const moved = [...tabs];
	const [tab] = moved.splice(from, 1);
	moved.splice(to, 0, tab);
	return moved;
}
