import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	layOutText,
	restoreTextLayout,
} from "../__tests__/helpers/text-layout.js";
import { clampedLeft, cutTooltip, SHOW_DELAY_MS, tooltip } from "./tooltip.js";

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

	it("opens above a trigger at the bottom of the window", () => {
		const top = window.innerHeight - 28;
		vi.spyOn(node, "getBoundingClientRect").mockReturnValue(
			new DOMRect(100, top, 80, 28),
		);
		const height = vi
			.spyOn(HTMLElement.prototype, "offsetHeight", "get")
			.mockReturnValue(24);
		try {
			node.dispatchEvent(new MouseEvent("mouseenter"));
			vi.advanceTimersByTime(SHOW_DELAY_MS);

			const bubble = document.querySelector<HTMLElement>(".tooltip-pop");
			expect(
				Number.parseFloat(bubble?.style.top ?? "") + 24,
			).toBeLessThanOrEqual(top);
			vi.spyOn(node, "getBoundingClientRect").mockReturnValue(
				new DOMRect(100, 10, 80, 28),
			);
			window.dispatchEvent(new Event("resize"));
			expect(Number.parseFloat(bubble?.style.top ?? "")).toBeGreaterThanOrEqual(
				38,
			);
		} finally {
			height.mockRestore();
		}
	});

	it("shows late statistics while the pointer remains in an initially empty cell", () => {
		handle.update("");
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);
		expect(popup()).toBeNull();
		handle.update("+1 −0, 1 file changed");
		expect(popup()?.textContent).toBe("+1 −0, 1 file changed");
		node.dispatchEvent(new MouseEvent("mouseleave"));
		handle.update("+2 −0, 2 files changed");
		expect(popup()).toBeNull();
	});

	it("keeps an oversized report open while the reader moves into it to scroll", () => {
		vi.spyOn(node, "getBoundingClientRect").mockReturnValue(
			new DOMRect(20, 20, 80, 28),
		);
		const height = vi
			.spyOn(HTMLElement.prototype, "offsetHeight", "get")
			.mockReturnValue(window.innerHeight + 500);
		try {
			node.dispatchEvent(new MouseEvent("mouseenter"));
			vi.advanceTimersByTime(SHOW_DELAY_MS);
			const report = document.querySelector<HTMLElement>(
				".tooltip-pop-scrollable",
			);
			if (!report) throw new Error("scrollable tooltip missing");
			expect(
				Number.parseFloat(report.style.top) +
					Number.parseFloat(report.style.maxHeight),
			).toBeLessThanOrEqual(window.innerHeight);
			node.dispatchEvent(
				new MouseEvent("mouseleave", { relatedTarget: report }),
			);
			expect(popup()).toBe(report);
			report.dispatchEvent(
				new MouseEvent("mouseleave", { relatedTarget: document.body }),
			);
			expect(popup()).toBeNull();
		} finally {
			height.mockRestore();
		}
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

	it("keeps a multiline freshness report readable when its label updates", () => {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);

		handle.update("Pull\norigin: last checked\nbackup: fetch failed");

		expect(popup()?.classList.contains("tooltip-pop-multiline")).toBe(true);
		expect(popup()?.textContent).toContain("\nbackup: fetch failed");
		handle.update("Pull");
		expect(popup()?.classList.contains("tooltip-pop-multiline")).toBe(false);
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

describe("cutTooltip", () => {
	let node: HTMLSpanElement;
	let handle: { update(t: string): void; destroy(): void };

	function hover() {
		node.dispatchEvent(new MouseEvent("mouseenter"));
		vi.advanceTimersByTime(SHOW_DELAY_MS);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		node = document.createElement("span");
		node.textContent = "feat: a summary too long for its column";
		document.body.appendChild(node);
		handle = cutTooltip(node, "feat: a summary too long for its column");
	});

	afterEach(() => {
		handle.destroy();
		node.remove();
		restoreTextLayout();
		vi.useRealTimers();
	});

	it("shows the full text on hover when the text runs past its box", () => {
		layOutText(node, 300, 120);

		hover();

		expect(document.querySelector(".tooltip-pop")?.textContent).toBe(
			"feat: a summary too long for its column",
		);
	});

	it("follows changes in the width available to a hovered label", () => {
		layOutText(node, 300, 120);
		hover();
		expect(document.querySelector(".tooltip-pop")).not.toBeNull();
		layOutText(node, 300, 360);
		window.dispatchEvent(new Event("resize"));
		expect(document.querySelector(".tooltip-pop")).toBeNull();
		layOutText(node, 300, 120);
		window.dispatchEvent(new Event("resize"));
		expect(document.querySelector(".tooltip-pop")).not.toBeNull();
	});

	describe("when the text fits its box", () => {
		it("shows nothing on hover", () => {
			layOutText(node, 120, 120);

			hover();

			expect(document.querySelector(".tooltip-pop")).toBeNull();
		});

		// A flex column's box is often a fraction of a pixel wide, and the text
		// fits it with no ellipsis drawn.
		it("shows nothing when the box is a fraction wider than clientWidth says", () => {
			layOutText(node, 150.3, 150.4);

			hover();

			expect(document.querySelector(".tooltip-pop")).toBeNull();
		});
	});
});
