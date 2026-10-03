import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import MessageEditor from "./MessageEditor.svelte";
import "../__tests__/helpers/tauri-mock";

interface Ref {
	open(defaultValue: string): Promise<string | null>;
}

function mount(title = "Merge commit message") {
	const result = render(MessageEditor, { props: { title } });
	const ref: Ref = result.component;
	return { ref, ...result };
}

describe("MessageEditor", () => {
	it("does not render modal markup before open is called", () => {
		mount();

		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("renders title prop in modal heading", async () => {
		const { ref } = mount("Revert commit message");

		ref.open("anything");

		expect(
			await screen.findByText("Revert commit message"),
		).toBeInTheDocument();
	});

	it("pre-fills textarea with the default passed to open", async () => {
		const { ref } = mount();
		const defaultText = "Merge branch 'foo'\n\n# comments preserved verbatim";

		ref.open(defaultText);

		const textarea = (await screen.findByRole(
			"textbox",
		)) as HTMLTextAreaElement;
		expect(textarea.value).toBe(defaultText);
	});

	it("resolves with edited text when Save is clicked", async () => {
		const { ref } = mount();

		const promise = ref.open("");
		const textarea = (await screen.findByRole(
			"textbox",
		)) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "hello world" } });
		await fireEvent.click(screen.getByText("Save"));

		expect(await promise).toBe("hello world");
	});

	it("resolves null on Escape", async () => {
		const { ref } = mount();

		const promise = ref.open("x");
		const textarea = await screen.findByRole("textbox");
		await fireEvent.keyDown(textarea, { key: "Escape" });

		expect(await promise).toBeNull();
	});

	it("resolves null when Cancel button is clicked", async () => {
		const { ref } = mount();

		const promise = ref.open("x");
		await screen.findByRole("textbox");
		await fireEvent.click(screen.getByText("Cancel"));

		expect(await promise).toBeNull();
	});

	it("resolves null when backdrop is clicked", async () => {
		const { ref, container } = mount();

		const promise = ref.open("x");
		await screen.findByRole("textbox");
		const backdrop = container.querySelector(
			'[data-testid="message-editor-backdrop"]',
		) as HTMLElement;
		await fireEvent.click(backdrop);

		expect(await promise).toBeNull();
	});

	it("resolves null when text is empty and Save is clicked", async () => {
		const { ref } = mount();

		const promise = ref.open("");
		await screen.findByRole("textbox");
		await fireEvent.click(screen.getByText("Save"));

		expect(await promise).toBeNull();
	});

	it("resolves null when text is whitespace-only and Save is clicked", async () => {
		const { ref } = mount();

		const promise = ref.open("   \n\n  ");
		await screen.findByRole("textbox");
		await fireEvent.click(screen.getByText("Save"));

		expect(await promise).toBeNull();
	});

	it("resolves with edited text on Cmd+Enter", async () => {
		const { ref } = mount();

		const promise = ref.open("");
		const textarea = (await screen.findByRole(
			"textbox",
		)) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "ship it" } });
		await fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

		expect(await promise).toBe("ship it");
	});

	it("resolves with edited text on Ctrl+Enter", async () => {
		const { ref } = mount();

		const promise = ref.open("");
		const textarea = (await screen.findByRole(
			"textbox",
		)) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "ship it" } });
		await fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

		expect(await promise).toBe("ship it");
	});

	it("preserves trailing whitespace and newlines in the resolved value", async () => {
		const { ref } = mount();

		const promise = ref.open("");
		const textarea = (await screen.findByRole(
			"textbox",
		)) as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "msg\n\n" } });
		await fireEvent.click(screen.getByText("Save"));

		expect(await promise).toBe("msg\n\n");
	});

	it("resolves the previous promise with null when open is called twice", async () => {
		const { ref } = mount();

		const first = ref.open("a");
		const second = ref.open("b");

		expect(await first).toBeNull();

		await screen.findByRole("textbox");
		await fireEvent.click(screen.getByText("Cancel"));
		expect(await second).toBeNull();
	});

	it("hides modal markup after promise resolves", async () => {
		const { ref } = mount();

		const promise = ref.open("x");
		await screen.findByRole("textbox");
		await fireEvent.click(screen.getByText("Save"));
		await promise;

		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("draws Save as the primary action beside a plain Cancel", async () => {
		const { ref } = mount();

		ref.open("");

		expect(await screen.findByText("Save")).toHaveClass("bg-accent");
		expect(screen.getByText("Cancel")).toHaveClass("border-border");
	});
});
