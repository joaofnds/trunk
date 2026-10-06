import { render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import Keycap from "./Keycap.svelte";

const j = createRawSnippet(() => ({ render: () => "<span>J</span>" }));

describe("Keycap", () => {
	it("marks its key up as keyboard input", () => {
		const { container } = render(Keycap, { props: { children: j } });

		expect(container.querySelector("kbd")).toHaveTextContent("J");
	});
});
