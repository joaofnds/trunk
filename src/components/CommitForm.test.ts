import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../__tests__/helpers/tauri-mock";
import { safeInvoke } from "../lib/invoke.js";
import type { HeadCommitMessage } from "../lib/types.js";
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

	it("draws the submit as the large primary action across the form", () => {
		render(CommitForm, { props: defaultProps });

		const submit = screen.getByTestId("commit-form-submit");
		expect(submit).toHaveClass("bg-accent", "h-control-lg");
		expect(submit.parentElement).toHaveClass("grid");
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
		const tabLabels = screen
			.getAllByRole("tab")
			.map((tab) => tab.textContent?.trim());
		expect(tabLabels).toEqual(["Commit", "Amend", "Stash"]);
	});

	describe("mode-switch field handling", () => {
		beforeEach(() => {
			vi.mocked(safeInvoke).mockReset();
			vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
				if (cmd === "get_head_commit_message") {
					return Promise.resolve({
						oid: "head-1",
						subject: "Prev subject",
						body: "Prev body",
					});
				}
				return Promise.resolve(undefined);
			});
		});

		function tab(label: string): HTMLElement {
			return screen.getByRole("tab", { name: label });
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
			let resolveHead: (msg: HeadCommitMessage) => void = () => {};
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

			resolveHead({
				oid: "head-1",
				subject: "Prev subject",
				body: "Prev body",
			});
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
			let resolveHead: (msg: HeadCommitMessage) => void = () => {};
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

			resolveHead({
				oid: "head-1",
				subject: "Prev subject",
				body: "Prev body",
			});
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

	describe("the summary the uncommitted-changes row labels", () => {
		const DRAFT = "fix: draft";
		let amend: Promise<void>;
		let finishAmend: () => void;

		beforeEach(() => {
			amend = new Promise((resolve) => {
				finishAmend = resolve;
			});
			vi.mocked(safeInvoke).mockReset();
			vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
				if (cmd === "get_head_commit_message") {
					return Promise.resolve({
						oid: "head-1",
						subject: "Prev subject",
						body: null,
					});
				}
				if (cmd === "amend_commit") return amend;
				return Promise.resolve(undefined);
			});
		});

		function renderForm() {
			const focus: boolean[] = [];
			const { component, unmount } = render(CommitForm, {
				props: {
					...defaultProps,
					initialSubject: DRAFT,
					ondraftsummaryfocuschange: (focused: boolean) => focus.push(focused),
				},
			});
			const subject = screen.getByTestId(
				"commit-form-subject",
			) as HTMLInputElement;

			return { form: component, subject, focus, unmount };
		}

		async function openAmend(subject: HTMLInputElement) {
			await fireEvent.click(screen.getByRole("tab", { name: "Amend" }));
			await waitFor(() => expect(subject.value).toBe("Prev subject"));
		}

		function selectedMode() {
			return screen
				.getAllByRole("tab")
				.find((tab) => tab.getAttribute("aria-selected") === "true")
				?.textContent?.trim();
		}

		it("takes the focus with the caret after the draft", async () => {
			const { form, subject } = renderForm();
			subject.setSelectionRange(0, 0);

			await form.focusDraftSummary();

			expect(document.activeElement).toBe(subject);
			expect([subject.selectionStart, subject.selectionEnd]).toEqual([
				DRAFT.length,
				DRAFT.length,
			]);
		});

		it.each(["Amend", "Stash"])(
			"returns the form from %s to the commit draft",
			async (mode) => {
				const { form, subject } = renderForm();
				await fireEvent.click(screen.getByRole("tab", { name: mode }));

				await form.focusDraftSummary();

				expect(selectedMode()).toBe("Commit");
				expect(subject.value).toBe(DRAFT);
				expect(document.activeElement).toBe(subject);
			},
		);

		it("leaves an amend in flight in Amend", async () => {
			const { form, subject } = renderForm();
			await openAmend(subject);
			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await form.focusDraftSummary();

			expect(selectedMode()).toBe("Amend");
		});

		it("reports the draft's summary taking and losing the focus", async () => {
			const { subject, focus } = renderForm();

			await fireEvent.focus(subject);
			await fireEvent.blur(subject);

			expect(focus).toEqual([true, false]);
		});

		it("reports the draft's summary losing the focus when the form goes away", async () => {
			const { subject, focus, unmount } = renderForm();
			await fireEvent.focus(subject);

			unmount();

			expect(focus).toEqual([true, false]);
		});

		it("counts Stash's name as the draft's summary, since typing there edits it", async () => {
			const { subject, focus } = renderForm();
			await fireEvent.click(screen.getByRole("tab", { name: "Stash" }));

			await fireEvent.focus(subject);

			expect(focus).toEqual([true]);
		});

		it("reports no draft focus while the field holds an amend message", async () => {
			const { subject, focus } = renderForm();
			await openAmend(subject);

			await fireEvent.focus(subject);

			expect(focus).toEqual([]);
		});

		it("reports the draft's summary focused once a submitted amend returns the field to it", async () => {
			const { subject, focus } = renderForm();
			await openAmend(subject);
			await fireEvent.focus(subject);
			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			finishAmend();
			await waitFor(() => expect(selectedMode()).toBe("Commit"));

			expect(focus).toEqual([true]);
		});
	});

	describe("aiming an amend at the commit the user saw", () => {
		const stale = {
			code: "amend_stale",
			message:
				"HEAD is no longer the commit this amend was opened on, so nothing was amended",
		};
		let message: typeof import("@tauri-apps/plugin-dialog").message;
		let head: { oid: string; subject: string };
		let refuseNextAmend: boolean;
		let amends: unknown[];

		beforeEach(async () => {
			({ message } = await import("@tauri-apps/plugin-dialog"));
			vi.mocked(message).mockClear();
			vi.mocked(safeInvoke).mockReset();
			head = { oid: "head-1", subject: "Prev subject" };
			refuseNextAmend = false;
			amends = [];
			vi.mocked(safeInvoke).mockImplementation((cmd: string, args) => {
				if (cmd === "get_head_commit_message") {
					return Promise.resolve({ ...head, body: null });
				}
				if (cmd === "amend_commit") {
					amends.push(args);
					if (refuseNextAmend) {
						refuseNextAmend = false;
						return Promise.reject(stale);
					}
				}
				return Promise.resolve(undefined);
			});
		});

		function subjectInput(): HTMLInputElement {
			return screen.getByTestId("commit-form-subject") as HTMLInputElement;
		}

		function tab(name: string) {
			return screen.getByRole("tab", { name });
		}

		async function openAmend(subject = "Prev subject") {
			await fireEvent.click(tab("Amend"));
			await waitFor(() => expect(subjectInput().value).toBe(subject));
		}

		function submit() {
			return fireEvent.click(screen.getByTestId("commit-form-submit"));
		}

		function pullLands() {
			head = { oid: "head-2", subject: "Pulled subject" };
		}

		it("names the commit whose message the amend was opened on", async () => {
			render(CommitForm, { props: defaultProps });
			await openAmend();
			pullLands();

			await submit();

			await waitFor(() =>
				expect(amends).toEqual([
					expect.objectContaining({ expectedHeadOid: "head-1" }),
				]),
			);
		});

		it("shows HEAD's message on re-entry when the buffer was not edited", async () => {
			render(CommitForm, { props: defaultProps });
			await openAmend();
			await fireEvent.click(tab("Commit"));
			pullLands();

			await openAmend("Pulled subject");
			await submit();

			await waitFor(() =>
				expect(amends).toEqual([
					expect.objectContaining({
						subject: "Pulled subject",
						expectedHeadOid: "head-2",
					}),
				]),
			);
		});

		it("keeps edits aimed at the commit they were written for across a mode switch", async () => {
			render(CommitForm, { props: defaultProps });
			await openAmend();
			await fireEvent.input(subjectInput(), {
				target: { value: "fixed subject" },
			});
			await fireEvent.click(tab("Commit"));
			pullLands();
			await fireEvent.click(tab("Amend"));

			await submit();

			await waitFor(() =>
				expect(amends).toEqual([
					expect.objectContaining({
						subject: "fixed subject",
						expectedHeadOid: "head-1",
					}),
				]),
			);
		});

		describe("once HEAD moved under the amend", () => {
			it("names the commit an edited amend would now replace", async () => {
				render(CommitForm, { props: defaultProps });
				await openAmend();
				await fireEvent.input(subjectInput(), {
					target: { value: "fixed subject" },
				});
				pullLands();
				refuseNextAmend = true;

				await submit();

				await waitFor(() =>
					expect(message).toHaveBeenCalledWith(
						`${stale.message}. HEAD is now "Pulled subject". Amend again to amend it with this message.`,
						{ title: "Amend Error", kind: "error" },
					),
				);
				expect(subjectInput().value).toBe("fixed subject");
			});

			it("aims the next amend of an edited buffer at the commit the dialog named", async () => {
				render(CommitForm, { props: defaultProps });
				await openAmend();
				await fireEvent.input(subjectInput(), {
					target: { value: "fixed subject" },
				});
				pullLands();
				refuseNextAmend = true;
				await submit();
				await waitFor(() => expect(message).toHaveBeenCalled());
				head = { oid: "head-3", subject: "Pulled again" };

				await submit();

				await waitFor(() =>
					expect(amends).toEqual([
						expect.objectContaining({ expectedHeadOid: "head-1" }),
						expect.objectContaining({
							subject: "fixed subject",
							expectedHeadOid: "head-2",
						}),
					]),
				);
			});

			it("shows the new HEAD's message in a buffer the user had not edited", async () => {
				render(CommitForm, { props: defaultProps });
				await openAmend();
				pullLands();
				refuseNextAmend = true;

				await submit();

				await waitFor(() =>
					expect(subjectInput().value).toBe("Pulled subject"),
				);
				expect(message).toHaveBeenCalledWith(
					`${stale.message}. HEAD is now "Pulled subject". The form now shows its message.`,
					{ title: "Amend Error", kind: "error" },
				);
			});
		});
	});

	describe("when git refuses the commit", () => {
		const hookOutput = "lint-staged failed:\n  src/a.ts: missing semicolon";

		// The dialog module the form sees is the one the shared tauri-mock
		// helper registers, which a static import here would resolve before.
		let message: typeof import("@tauri-apps/plugin-dialog").message;

		beforeEach(async () => {
			({ message } = await import("@tauri-apps/plugin-dialog"));
			vi.mocked(message).mockClear();
			vi.mocked(safeInvoke).mockReset();
			vi.mocked(safeInvoke).mockImplementation((cmd: string) => {
				if (cmd === "get_head_commit_message") {
					return Promise.resolve({
						oid: "head-1",
						subject: "Prev subject",
						body: null,
					});
				}
				if (cmd === "create_commit" || cmd === "amend_commit") {
					return Promise.reject({ code: "commit_error", message: hookOutput });
				}
				return Promise.resolve(undefined);
			});
		});

		function subjectInput(): HTMLInputElement {
			return screen.getByTestId("commit-form-subject") as HTMLInputElement;
		}

		it("shows git's whole output in a dialog the user dismisses", async () => {
			render(CommitForm, { props: defaultProps });
			await fireEvent.input(subjectInput(), { target: { value: "wip draft" } });

			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await waitFor(() =>
				expect(message).toHaveBeenCalledWith(hookOutput, {
					title: "Commit Error",
					kind: "error",
				}),
			);
			expect(subjectInput().value).toBe("wip draft");
		});

		it("shows git's whole output for a refused amend and keeps the edited message", async () => {
			render(CommitForm, { props: defaultProps });
			await fireEvent.click(screen.getByRole("tab", { name: "Amend" }));
			await waitFor(() => expect(subjectInput().value).toBe("Prev subject"));
			await fireEvent.input(subjectInput(), {
				target: { value: "fixed subject" },
			});

			await fireEvent.click(screen.getByTestId("commit-form-submit"));

			await waitFor(() =>
				expect(message).toHaveBeenCalledWith(hookOutput, {
					title: "Amend Error",
					kind: "error",
				}),
			);
			expect(subjectInput().value).toBe("fixed subject");
		});
	});

	describe("submitting with nothing staged", () => {
		beforeEach(() => {
			vi.mocked(safeInvoke).mockReset();
			vi.mocked(safeInvoke).mockResolvedValue(undefined);
		});

		function submit(): HTMLElement {
			return screen.getByTestId("commit-form-submit");
		}

		function stashTab(): HTMLElement {
			return screen.getByRole("tab", { name: "Stash" });
		}

		it("tells the user to stage first in stash mode", async () => {
			render(CommitForm, { props: { ...defaultProps, stagedCount: 0 } });

			await fireEvent.click(stashTab());
			await fireEvent.click(submit());

			expect(
				await screen.findByText("Nothing to stash — stage changes first."),
			).toBeInTheDocument();
			expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
				"stash_save",
				expect.anything(),
			);
		});

		it("names the empty staging area in commit mode", async () => {
			render(CommitForm, { props: { ...defaultProps, stagedCount: 0 } });

			await fireEvent.input(screen.getByTestId("commit-form-subject"), {
				target: { value: "a subject" },
			});
			await fireEvent.click(submit());

			expect(await screen.findByText("No files staged")).toBeInTheDocument();
			expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
				"create_commit",
				expect.anything(),
			);
		});

		it("drops the warning once a file is staged", async () => {
			const { rerender } = render(CommitForm, {
				props: { ...defaultProps, stagedCount: 0 },
			});
			await fireEvent.click(stashTab());
			await fireEvent.click(submit());
			await screen.findByText("Nothing to stash — stage changes first.");

			await rerender({ stagedCount: 1 });

			expect(
				screen.queryByText("Nothing to stash — stage changes first."),
			).not.toBeInTheDocument();
		});

		it("drops the warning when the mode changes", async () => {
			render(CommitForm, { props: { ...defaultProps, stagedCount: 0 } });
			await fireEvent.click(stashTab());
			await fireEvent.click(submit());
			await screen.findByText("Nothing to stash — stage changes first.");

			await fireEvent.click(screen.getByRole("tab", { name: "Commit" }));

			expect(
				screen.queryByText("Nothing to stash — stage changes first."),
			).not.toBeInTheDocument();
		});
	});

	describe("when Cmd+Enter is pressed in the message", () => {
		function commits(): unknown[] {
			return vi
				.mocked(safeInvoke)
				.mock.calls.filter(([cmd]) => cmd === "create_commit");
		}

		beforeEach(() => {
			vi.mocked(safeInvoke).mockReset();
			vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
				cmd === "create_commit"
					? new Promise(() => {})
					: Promise.resolve(undefined),
			);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it.each([
			["summary", () => screen.getByTestId("commit-form-subject")],
			[
				"description",
				() => screen.getByPlaceholderText("Description (optional)"),
			],
		])("commits from the %s field", async (_field, field) => {
			render(CommitForm, { props: defaultProps });
			await fireEvent.input(screen.getByTestId("commit-form-subject"), {
				target: { value: "ship it" },
			});

			await fireEvent.keyDown(field(), {
				key: "Enter",
				metaKey: true,
			});

			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("create_commit", {
				path: "/repo",
				subject: "ship it",
				body: null,
			});
		});

		it("commits on Ctrl+Enter off macOS", async () => {
			vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
			render(CommitForm, { props: defaultProps });
			const subject = screen.getByTestId("commit-form-subject");
			await fireEvent.input(subject, { target: { value: "ship it" } });

			await fireEvent.keyDown(subject, { key: "Enter", ctrlKey: true });

			expect(commits()).toHaveLength(1);
		});

		it("commits once when pressed again while the commit runs", async () => {
			render(CommitForm, { props: defaultProps });
			const subject = screen.getByTestId("commit-form-subject");
			await fireEvent.input(subject, { target: { value: "ship it" } });

			await fireEvent.keyDown(subject, { key: "Enter", metaKey: true });
			await fireEvent.keyDown(subject, { key: "Enter", metaKey: true });

			expect(commits()).toHaveLength(1);
		});

		it("leaves a plain Enter in the description as a new line", async () => {
			render(CommitForm, { props: defaultProps });
			await fireEvent.input(screen.getByTestId("commit-form-subject"), {
				target: { value: "ship it" },
			});

			const typed = await fireEvent.keyDown(
				screen.getByPlaceholderText("Description (optional)"),
				{ key: "Enter" },
			);

			expect(typed).toBe(true);
			expect(commits()).toHaveLength(0);
		});
	});
});
