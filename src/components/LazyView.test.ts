import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import Harness from "../__tests__/helpers/lazy-view-harness.svelte";
import Button from "../lib/ui/Button.svelte";

class ViewLoader {
	private pending = Promise.withResolvers<{ default: typeof Button }>();
	readonly load = () => this.pending.promise;

	resolve(): void {
		this.pending.resolve({ default: Button });
	}

	fail(): void {
		this.pending.reject(new Error("editor unavailable"));
	}

	nextLoad(): void {
		this.pending = Promise.withResolvers<{ default: typeof Button }>();
	}
}

describe("LazyView", () => {
	it("shows loading until the requested view is available", async () => {
		const loader = new ViewLoader();
		render(Harness, { load: loader.load });
		expect(screen.getByRole("status")).toHaveTextContent("Opening editor");

		loader.resolve();

		expect(
			await screen.findByRole("button", { name: "Loaded editor" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("recovers a failed view load through retry", async () => {
		const loader = new ViewLoader();
		render(Harness, { load: loader.load });
		loader.fail();
		await screen.findByRole("alert");
		loader.nextLoad();

		await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		loader.resolve();

		expect(
			await screen.findByRole("button", { name: "Loaded editor" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
