import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampedLeft, SHOW_DELAY_MS, tooltip } from "./tooltip.js";

describe("clampedLeft", () => {
	it("centers the tooltip under the trigger when there is room", () => {
		const left = clampedLeft({ left: 100, width: 26 }, 80, 1000);

		expect(left).toBe(73);
	});

	it("clamps to the right edge when a centered tooltip would overflow right", () => {
		const left = clampedLeft({ left: 950, width: 26 }, 180, 1000);

		expect(left).toBe(1000 - 180 - 6);
	});

	it("clamps to the left margin when a centered tooltip would overflow left", () => {
		const left = clampedLeft({ left: 0, width: 26 }, 180, 1000);

		expect(left).toBe(6);
	});
});

describe("tooltip", () => {
	let node: HTMLButtonElement;
	let handle: { update(t: string): void; destroy(): void };

	function popup() {
		return document.querySelector(".tooltip-pop");
	}

	beforeEach(() => {
		vi.useFakeTimers();
		node = document.createElement("button");
		document.body.appendChild(node);
		handle = tooltip(node, "Stash");
	});

	afterEach(() => {
		handle.destroy();
		node.remove();
		vi.useRealTimers();
	});

	it("shows the tooltip after the delay on mouseenter", () => {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);

		expect(popup()?.textContent).toBe("Stash");
	});

	it("does not show the tooltip before the delay elapses", () => {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS - 1);

		expect(popup()).toBeNull();
	});

	it("hides the tooltip on mouseleave", () => {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);
		node.dispatchEvent(new MouseEvent("mouseleave"));

		expect(popup()).toBeNull();
	});

	it("cancels a pending tooltip when the pointer leaves before the delay", () => {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		node.dispatchEvent(new MouseEvent("mouseleave"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);

		expect(popup()).toBeNull();
	});

	it("shows on focus and hides on blur", () => {
		node.dispatchEvent(new FocusEvent("focus"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);
		expect(popup()?.textContent).toBe("Stash");

		node.dispatchEvent(new FocusEvent("blur"));
		expect(popup()).toBeNull();
	});

	it("removes the tooltip when the trigger is clicked", () => {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);
		node.dispatchEvent(new MouseEvent("click"));

		expect(popup()).toBeNull();
	});

	it("reflects an updated label on the next show", () => {
		handle.update("Pop");
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);

		expect(popup()?.textContent).toBe("Pop");
	});

	it("stops responding to events after destroy", () => {
		handle.destroy();
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);

		expect(popup()).toBeNull();
	});

	it("does not show a popup for a blank label", () => {
		const blankNode = document.createElement("button");
		document.body.appendChild(blankNode);
		const blank = tooltip(blankNode, "   ");

		blankNode.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);
		expect(popup()).toBeNull();

		blank.destroy();
		blankNode.remove();
	});

	it("hides a shown popup when updated to a blank label", () => {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);
		expect(popup()).not.toBeNull();

		handle.update("");
		expect(popup()).toBeNull();
	});
});
