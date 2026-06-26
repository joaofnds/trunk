import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../__tests__/helpers/tauri-mock";
import { safeInvoke } from "../lib/invoke.js";
import CommitForm from "./CommitForm.svelte";

// Mock safeInvoke at the wrapper layer so tests dispatch by command name.
vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return {
		...actual,
		safeInvoke: vi.fn(),
	};
});

describe("CommitForm", () => {
	const defaultProps = {
		repoPath: "/repo",
		stagedCount: 1,
		clearRedoStack: vi.fn(),
	};

	it("renders Commit button in commit mode", () => {
		render(CommitForm, { props: defaultProps });
		// "Commit" appears both as tab label and submit button text
		const buttons = screen.getAllByText("Commit");
		expect(buttons.length).toBeGreaterThanOrEqual(2);
	});

	it("renders Amend tab button", () => {
		render(CommitForm, { props: defaultProps });
		expect(screen.getByText("Amend")).toBeInTheDocument();
	});

	it("renders Stash tab button", () => {
		render(CommitForm, { props: defaultProps });
		expect(screen.getByText("Stash")).toBeInTheDocument();
	});

	it("renders subject input with commit placeholder", () => {
		render(CommitForm, { props: defaultProps });
		expect(
			screen.getByPlaceholderText("Summary (required)"),
		).toBeInTheDocument();
	});

	it("renders body textarea", () => {
		render(CommitForm, { props: defaultProps });
		expect(
			screen.getByPlaceholderText("Description (optional)"),
		).toBeInTheDocument();
	});

	describe("draft seeding and lifting", () => {
		it("seeds inputs from initialSubject and initialBody at mount", () => {
			render(CommitForm, {
				props: {
					...defaultProps,
					initialSubject: "seeded summary",
					initialBody: "seeded body",
				},
			});
			expect(
				(screen.getByTestId("commit-form-subject") as HTMLInputElement).value,
			).toBe("seeded summary");
			expect(
				(
					screen.getByPlaceholderText(
						"Description (optional)",
					) as HTMLTextAreaElement
				).value,
			).toBe("seeded body");
		});

		it("fires onbodychange when the body is typed", async () => {
			const onbodychange = vi.fn();
			render(CommitForm, { props: { ...defaultProps, onbodychange } });

			await fireEvent.input(
				screen.getByPlaceholderText("Description (optional)"),
				{ target: { value: "new body" } },
			);

			expect(onbodychange).toHaveBeenCalledWith("new body");
		});

		it("emits empty subject and body on successful commit", async () => {
			vi.mocked(safeInvoke).mockReset();
			vi.mocked(safeInvoke).mockResolvedValue(undefined);
			const onsubjectchange = vi.fn();
			const onbodychange = vi.fn();
			render(CommitForm, {
				props: { ...defaultProps, onsubjectchange, onbodychange },
			});

			await fireEvent.input(screen.getByTestId("commit-form-subject"), {
				target: { value: "real commit" },
			});
			await fireEvent.input(
				screen.getByPlaceholderText("Description (optional)"),
				{ target: { value: "real body" } },
			);
			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await waitFor(() => expect(onsubjectchange).toHaveBeenLastCalledWith(""));
			expect(onbodychange).toHaveBeenLastCalledWith("");
		});
	});

	describe("summary char counter", () => {
		function typeSubject(length: number): Promise<boolean> {
			return fireEvent.input(screen.getByTestId("commit-form-subject"), {
				target: { value: "a".repeat(length) },
			});
		}

		it("drops the staged-count footer", () => {
			render(CommitForm, { props: defaultProps });
			expect(screen.queryByText(/staged/i)).not.toBeInTheDocument();
		});

		it("hides the counter below 60 chars", async () => {
			render(CommitForm, { props: defaultProps });
			await typeSubject(59);
			expect(screen.queryByTestId("subject-counter")).not.toBeInTheDocument();
		});

		it("shows the counter at 60 chars", async () => {
			render(CommitForm, { props: defaultProps });
			await typeSubject(60);
			const counter = screen.getByTestId("subject-counter");
			expect(counter).toHaveTextContent("60/72");
			expect(counter).toHaveAttribute("data-over", "false");
		});

		it.each([
			{ length: 72, over: false },
			{ length: 73, over: true },
		])("flags over-limit at $length chars", async ({ length, over }) => {
			render(CommitForm, { props: defaultProps });
			await typeSubject(length);
			const counter = screen.getByTestId("subject-counter");
			expect(counter).toHaveTextContent(`${length}/72`);
			expect(counter).toHaveAttribute("data-over", String(over));
		});
	});

	it("shows all three mode tabs", () => {
		render(CommitForm, { props: defaultProps });
		const buttons = screen.getAllByRole("button");
		const tabLabels = buttons.map((b) => b.textContent?.trim());
		expect(tabLabels).toContain("Commit");
		expect(tabLabels).toContain("Amend");
		expect(tabLabels).toContain("Stash");
	});

	describe("mode-switch field handling", () => {
		beforeEach(() => {
			vi.mocked(safeInvoke).mockReset();
			vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
				if (cmd === "get_head_commit_message") {
					return Promise.resolve({
						subject: "Prev subject",
						body: "Prev body",
					});
				}
				return Promise.resolve(undefined);
			});
		});

		function tab(label: string): HTMLElement {
			const found = screen
				.getAllByRole("button")
				.find(
					(b) =>
						b.getAttribute("data-testid") !== "commit-form-submit" &&
						b.textContent?.trim() === label,
				);
			if (!found) throw new Error(`tab "${label}" not found`);
			return found;
		}

		function subjectInput(): HTMLInputElement {
			return screen.getByTestId("commit-form-subject") as HTMLInputElement;
		}

		function bodyTextarea(): HTMLTextAreaElement {
			return screen.getByPlaceholderText(
				"Description (optional)",
			) as HTMLTextAreaElement;
		}

		it("clears prefilled fields when leaving an untouched amend (commit → amend → commit)", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));
			expect(bodyTextarea().value).toBe("Prev body");

			await fireEvent.click(tab("Commit"));
			await waitFor(() => expect(subjectInput().value).toBe(""));
			expect(bodyTextarea().value).toBe("");
		});

		it("keeps a typed draft and does not fetch HEAD when switching to amend", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.input(subjectInput(), {
				target: { value: "wip draft" },
			});
			await fireEvent.click(tab("Amend"));

			expect(subjectInput().value).toBe("wip draft");
			expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
				"get_head_commit_message",
				expect.anything(),
			);
		});

		it("prefills from HEAD when a draft was typed then cleared back to empty", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.input(subjectInput(), { target: { value: "draft" } });
			await fireEvent.input(subjectInput(), { target: { value: "" } });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));
			expect(bodyTextarea().value).toBe("Prev body");

			// the prefill is injected, not authored: leaving amend clears it
			await fireEvent.click(tab("Commit"));
			await waitFor(() => expect(subjectInput().value).toBe(""));
			expect(bodyTextarea().value).toBe("");
		});

		it("clears prefilled fields when switching from an untouched amend to stash", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));

			await fireEvent.click(tab("Stash"));
			await waitFor(() => expect(subjectInput().value).toBe(""));
			expect(bodyTextarea().value).toBe("");
		});

		it("keeps edited values when leaving amend after editing", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));

			await fireEvent.input(subjectInput(), {
				target: { value: "edited subject" },
			});
			await fireEvent.click(tab("Commit"));

			expect(subjectInput().value).toBe("edited subject");
		});

		it("resets fields and mode after a successful commit", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.input(subjectInput(), {
				target: { value: "real commit" },
			});
			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await waitFor(() => expect(subjectInput().value).toBe(""));
			expect(bodyTextarea().value).toBe("");
			expect(screen.getByTestId("commit-form-submit").textContent).toContain(
				"Commit",
			);
		});
	});
});
