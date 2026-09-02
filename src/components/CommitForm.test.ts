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

		it("fetches HEAD into the amend field with a draft present, and restores the draft on return", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.input(subjectInput(), {
				target: { value: "wip draft" },
			});
			await fireEvent.click(tab("Amend"));

			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith(
				"get_head_commit_message",
				expect.anything(),
			);

			await fireEvent.click(tab("Commit"));
			expect(subjectInput().value).toBe("wip draft");
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

		it("shows the WIP draft when leaving amend after editing", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.input(subjectInput(), {
				target: { value: "wip draft" },
			});

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));

			await fireEvent.input(subjectInput(), {
				target: { value: "edited subject" },
			});
			await fireEvent.click(tab("Commit"));

			expect(subjectInput().value).toBe("wip draft");
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

		it("shows HEAD in the amend field, then the seeded draft on returning to commit", async () => {
			render(CommitForm, {
				props: {
					...defaultProps,
					initialSubject: "seeded summary",
					initialBody: "seeded body",
				},
			});

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));
			expect(bodyTextarea().value).toBe("Prev body");

			await fireEvent.click(tab("Commit"));
			expect(subjectInput().value).toBe("seeded summary");
			expect(bodyTextarea().value).toBe("seeded body");
		});

		it("never lifts amend edits to the parent draft callbacks", async () => {
			const onsubjectchange = vi.fn();
			const onbodychange = vi.fn();
			render(CommitForm, {
				props: { ...defaultProps, onsubjectchange, onbodychange },
			});

			await fireEvent.input(subjectInput(), { target: { value: "wip draft" } });
			await fireEvent.input(bodyTextarea(), { target: { value: "wip body" } });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));

			await fireEvent.input(subjectInput(), {
				target: { value: "amend subject" },
			});
			await fireEvent.input(bodyTextarea(), {
				target: { value: "amend body" },
			});
			await fireEvent.click(tab("Commit"));

			expect(onsubjectchange).not.toHaveBeenCalledWith("amend subject");
			expect(onbodychange).not.toHaveBeenCalledWith("amend body");
			expect(onsubjectchange).toHaveBeenLastCalledWith("wip draft");
			expect(onbodychange).toHaveBeenLastCalledWith("wip body");
		});

		it("does not lift an edited HEAD prefill when leaving amend with an empty draft", async () => {
			const onsubjectchange = vi.fn();
			const onbodychange = vi.fn();
			render(CommitForm, {
				props: { ...defaultProps, onsubjectchange, onbodychange },
			});

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));

			await fireEvent.input(bodyTextarea(), {
				target: { value: "stray edit" },
			});
			await fireEvent.click(tab("Commit"));

			expect(onsubjectchange).not.toHaveBeenCalledWith("Prev subject");
			expect(onbodychange).not.toHaveBeenCalledWith("stray edit");
			expect(subjectInput().value).toBe("");
			expect(bodyTextarea().value).toBe("");
		});

		it("preserves the WIP draft through a successful amend", async () => {
			const onsubjectchange = vi.fn();
			const onbodychange = vi.fn();
			render(CommitForm, {
				props: { ...defaultProps, onsubjectchange, onbodychange },
			});

			await fireEvent.input(subjectInput(), { target: { value: "wip draft" } });
			await fireEvent.input(bodyTextarea(), { target: { value: "wip body" } });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));
			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await waitFor(() =>
				expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith(
					"amend_commit",
					expect.anything(),
				),
			);
			expect(onsubjectchange).not.toHaveBeenCalledWith("");
			expect(onbodychange).not.toHaveBeenCalledWith("");
			expect(subjectInput().value).toBe("wip draft");
			expect(bodyTextarea().value).toBe("wip body");
		});

		it("keeps text typed during an in-flight HEAD fetch over the stale prefill", async () => {
			let resolveHead: (msg: { subject: string; body: string }) => void =
				() => {};
			vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
				if (cmd === "get_head_commit_message") {
					return new Promise((resolve) => {
						resolveHead = resolve;
					});
				}
				return Promise.resolve(undefined);
			});
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(tab("Amend"));
			await fireEvent.input(subjectInput(), {
				target: { value: "typed fast" },
			});

			resolveHead({ subject: "Prev subject", body: "Prev body" });
			await waitFor(() => expect(subjectInput().value).toBe("typed fast"));
		});

		it("keeps amend edits in memory and does not re-fetch HEAD on re-entry", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));

			await fireEvent.input(subjectInput(), {
				target: { value: "edited subject" },
			});
			await fireEvent.click(tab("Commit"));
			await fireEvent.click(tab("Amend"));

			expect(subjectInput().value).toBe("edited subject");
			const headCalls = vi
				.mocked(safeInvoke)
				.mock.calls.filter((c) => c[0] === "get_head_commit_message");
			expect(headCalls).toHaveLength(1);
		});

		it("clears a stale subject-required error when switching mode", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(screen.getByTestId("commit-form-submit"));
			expect(screen.getByText("Subject is required")).toBeInTheDocument();

			await fireEvent.click(tab("Amend"));
			expect(screen.queryByText("Subject is required")).not.toBeInTheDocument();
		});

		it("drives the subject counter off the amend message while amending", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));

			await fireEvent.input(subjectInput(), {
				target: { value: "a".repeat(60) },
			});
			let counter = screen.getByTestId("subject-counter");
			expect(counter).toHaveTextContent("60/72");
			expect(counter).toHaveAttribute("data-over", "false");

			await fireEvent.input(subjectInput(), {
				target: { value: "a".repeat(73) },
			});
			counter = screen.getByTestId("subject-counter");
			expect(counter).toHaveTextContent("73/72");
			expect(counter).toHaveAttribute("data-over", "true");
		});

		it("keeps the shared draft when switching between commit and stash", async () => {
			render(CommitForm, { props: defaultProps });

			await fireEvent.input(subjectInput(), { target: { value: "wip draft" } });
			await fireEvent.input(bodyTextarea(), { target: { value: "wip body" } });

			await fireEvent.click(tab("Stash"));
			expect(subjectInput().value).toBe("wip draft");
			expect(bodyTextarea().value).toBe("wip body");

			await fireEvent.click(tab("Commit"));
			expect(subjectInput().value).toBe("wip draft");
			expect(bodyTextarea().value).toBe("wip body");
		});

		it("clears the draft on a successful stash", async () => {
			const onsubjectchange = vi.fn();
			const onbodychange = vi.fn();
			render(CommitForm, {
				props: { ...defaultProps, onsubjectchange, onbodychange },
			});

			await fireEvent.input(subjectInput(), { target: { value: "wip draft" } });
			await fireEvent.input(bodyTextarea(), { target: { value: "wip body" } });

			await fireEvent.click(tab("Stash"));
			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await waitFor(() =>
				expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith(
					"stash_save",
					expect.anything(),
				),
			);
			expect(onsubjectchange).toHaveBeenLastCalledWith("");
			expect(onbodychange).toHaveBeenLastCalledWith("");
			expect(subjectInput().value).toBe("");
			expect(bodyTextarea().value).toBe("");
		});

		it("keeps body text typed during an in-flight HEAD fetch over the stale prefill", async () => {
			let resolveHead: (msg: { subject: string; body: string }) => void =
				() => {};
			vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
				if (cmd === "get_head_commit_message") {
					return new Promise((resolve) => {
						resolveHead = resolve;
					});
				}
				return Promise.resolve(undefined);
			});
			render(CommitForm, { props: defaultProps });

			await fireEvent.click(tab("Amend"));
			await fireEvent.input(bodyTextarea(), {
				target: { value: "typed body" },
			});

			resolveHead({ subject: "Prev subject", body: "Prev body" });
			await waitFor(() => expect(bodyTextarea().value).toBe("typed body"));
			expect(subjectInput().value).toBe("");
		});

		it("preserves the draft when a commit submit fails", async () => {
			const onsubjectchange = vi.fn();
			const onbodychange = vi.fn();
			vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
				if (cmd === "create_commit") {
					return Promise.reject(new Error("commit failed"));
				}
				return Promise.resolve(undefined);
			});
			render(CommitForm, {
				props: { ...defaultProps, onsubjectchange, onbodychange },
			});

			await fireEvent.input(subjectInput(), { target: { value: "wip draft" } });
			await fireEvent.input(bodyTextarea(), { target: { value: "wip body" } });

			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await waitFor(() =>
				expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith(
					"create_commit",
					expect.anything(),
				),
			);
			expect(onsubjectchange).not.toHaveBeenCalledWith("");
			expect(onbodychange).not.toHaveBeenCalledWith("");
			expect(subjectInput().value).toBe("wip draft");
			expect(bodyTextarea().value).toBe("wip body");
		});
	});
});
