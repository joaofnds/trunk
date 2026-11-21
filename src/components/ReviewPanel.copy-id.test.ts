import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it } from "vitest";
import { FakeClipboard } from "../../tests/app/fakes/clipboard.js";
import { createFakeReviewComments } from "../__tests__/helpers/fake-review-comments.svelte.js";
import { aReview } from "../__tests__/helpers/review-fixture.js";
import { reviewPanelProps } from "../__tests__/helpers/review-props.js";
import { _resetToasts, toasts } from "../lib/toast.svelte.js";
import ReviewPanel from "./ReviewPanel.svelte";

afterEach(() => {
	clearMocks();
	_resetToasts();
});

it("copies the shown review ID from the header badge", async () => {
	const clipboard = new FakeClipboard();
	mockIPC((command, args) => {
		if (command !== "plugin:clipboard-manager|write_text") return [];

		return clipboard.answer("write_text", args as Record<string, unknown>);
	});
	const active = aReview();
	const shown = aReview({ id: "R3M9K7PW", title: "Graph lane colors" });
	const reviewComments = createFakeReviewComments();
	reviewComments.seed({ reviews: [active, shown], activeReviewId: active.id });
	await reviewComments.refresh();
	await reviewComments.select(shown.id);
	render(ReviewPanel, { props: reviewPanelProps({ reviewComments }) });

	await fireEvent.click(screen.getByRole("button", { name: shown.id }));

	expect(clipboard.text).toBe(shown.id);
	expect(toasts.items.map(({ message }) => message)).toEqual([
		`Copied ${shown.id}`,
	]);
});
