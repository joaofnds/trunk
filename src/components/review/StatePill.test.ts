import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import StatePill from "./StatePill.svelte";

describe("StatePill", () => {
	describe("for a thread", () => {
		it.each([
			["open", "Open"],
			["addressed", "Addressed"],
			["done", "Done"],
			["dismissed", "Dismissed"],
		] as const)("labels the %s state as %s", (state, label) => {
			render(StatePill, { props: { state } });
			expect(screen.getByText(label)).toBeInTheDocument();
		});
	});

	describe("for a review", () => {
		it.each([
			["composing", "Composing"],
			["ready", "Ready"],
			["settled", "Settled"],
		] as const)("labels the %s state as %s", (state, label) => {
			render(StatePill, { props: { state } });
			expect(screen.getByText(label)).toBeInTheDocument();
		});
	});

	it("labels a held comment as Pending", () => {
		render(StatePill, { props: { state: "pending" } });

		expect(screen.getByText("Pending")).toBeInTheDocument();
	});

	it("labels the stale marker as Stale", () => {
		render(StatePill, { props: { state: "stale" } });
		expect(screen.getByText("Stale")).toBeInTheDocument();
	});
});
