import { ask } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke, type TrunkError } from "../lib/invoke.js";
import { reactiveProps } from "../lib/reactive-props.svelte.js";
import {
	createRemoteState,
	type RemoteState,
} from "../lib/remote-state.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import PushRecoveryPrompt from "./PushRecoveryPrompt.svelte";

vi.mock("../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../lib/invoke.js")>()),
	safeInvoke: vi.fn(),
}));
vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

const mockInvoke = vi.mocked(safeInvoke);
const mockToast = vi.mocked(showToast);
const mockAsk = vi.mocked(ask);

const NONE_OP = {
	op_type: "None",
	source_branch: null,
	target_branch: null,
	progress: null,
	source_color_index: null,
	target_color_index: null,
	rebase_message: null,
};

const REBASE_OP = { ...NONE_OP, op_type: "Rebase" };
const MERGE_OP = { ...NONE_OP, op_type: "Merge" };

const PUSH_TARGET = { remote: "origin", branch: "feature" };

function err(code: string, message = "boom"): TrunkError {
	return { code, message };
}

function stateWith(
	error: TrunkError | null,
	lastOp: RemoteState["lastOp"] = "push",
) {
	const rs = createRemoteState();
	rs.error = error;
	rs.lastOp = lastOp;
	return rs;
}

function propsFor(rs: ReturnType<typeof createRemoteState>, overrides = {}) {
	return {
		repoPath: "/repo",
		remoteState: rs,
		refreshSignal: 0,
		...overrides,
	};
}

type InvokeResponder = () => Promise<unknown>;

const DEFAULT_RESPONSES: Record<string, InvokeResponder> = {
	get_operation_state: () => Promise.resolve(NONE_OP),
	get_push_target: () => Promise.resolve(PUSH_TARGET),
};

// The sole `mockImplementation`: every arrange varies one command against these
// defaults, so a test says which response it cares about and nothing else.
function respondWith(overrides: Record<string, InvokeResponder> = {}) {
	const responders = new Map(
		Object.entries({ ...DEFAULT_RESPONSES, ...overrides }),
	);
	mockInvoke.mockImplementation(
		(cmd: string) => responders.get(cmd)?.() ?? Promise.resolve(undefined),
	);
}

beforeEach(() => {
	mockInvoke.mockReset();
	respondWith();
	mockToast.mockReset();
	mockAsk.mockReset();
	mockAsk.mockResolvedValue(true);
});

describe("PushRecoveryPrompt", () => {
	it("renders nothing when there is no error", () => {
		const { container } = render(PushRecoveryPrompt, {
			props: propsFor(stateWith(null)),
		});
		expect(container.textContent?.trim()).toBe("");
	});

	it("offers Force Push and Cancel for a diverged push, naming branch and remote", async () => {
		render(PushRecoveryPrompt, {
			props: propsFor(stateWith(err("non_fast_forward"))),
		});

		await waitFor(() => {
			expect(screen.getByText("Force Push")).toBeInTheDocument();
		});
		expect(screen.getByText("Cancel")).toBeInTheDocument();
		expect(screen.queryByText("Pull & Rebase, then Push")).toBeNull();

		const buttons = screen.getAllByRole("button");
		expect(buttons).toHaveLength(2);

		const surface = screen.getByRole("alert");
		expect(surface.textContent).toContain("feature");
		expect(surface.textContent).toContain("origin");
	});

	it("offers Cancel only on a lease/if-includes refusal", async () => {
		render(PushRecoveryPrompt, {
			props: propsFor(stateWith(err("push_lease_refused"))),
		});

		await waitFor(() => {
			expect(screen.getByText("Cancel")).toBeInTheDocument();
		});
		// Force Push would be a guaranteed no-op here, so it must not be offered (D7).
		expect(screen.queryByText("Force Push")).toBeNull();
		expect(screen.queryByText("Pull & Rebase, then Push")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
		expect(screen.getByRole("alert").textContent).toContain("refused");
	});
});

describe("PushRecoveryPrompt force push", () => {
	it("confirms once naming branch and remote, then force-pushes", async () => {
		mockAsk.mockResolvedValue(true);
		const rs = stateWith(err("non_fast_forward"));

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await fireEvent.click(await screen.findByText("Force Push"));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("git_push_force", {
				path: "/repo",
				remote: "origin",
				branch: "feature",
			}),
		);
		expect(mockAsk).toHaveBeenCalledTimes(1);
		const message = mockAsk.mock.calls[0][0] as string;
		expect(message).toContain("feature");
		expect(message).toContain("origin");
	});

	// The declined click is an assertion of absence, so it needs a completion
	// barrier: the second, accepted click cannot land before the first has finished.
	it("sends nothing when the confirmation is declined", async () => {
		mockAsk.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const rs = stateWith(err("non_fast_forward"));

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		const forcePush = await screen.findByText("Force Push");
		await fireEvent.click(forcePush);
		await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(1));
		await fireEvent.click(forcePush);

		await waitFor(() => expect(mockAsk).toHaveBeenCalledTimes(2));
		expect(
			mockInvoke.mock.calls.filter(([cmd]) => cmd === "git_push_force"),
		).toHaveLength(1);
	});

	it("reports a successful force push and releases the surface", async () => {
		const rs = stateWith(err("non_fast_forward"));

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await fireEvent.click(await screen.findByText("Force Push"));

		await waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith(
				"Force pushed successfully",
				"success",
			),
		);
		expect(rs.isRunning).toBe(false);
	});

	// The recovery banner is already on screen before the click, so this needs a barrier
	// proving the SECOND rejection was recorded. Compare by value, not identity: the
	// $state proxy means `rs.error` is never reference-equal to what was assigned.
	it("re-opens the recovery choices when the force push is itself rejected", async () => {
		mockAsk.mockResolvedValue(true);
		const rs = stateWith(err("non_fast_forward", "the original push"));
		respondWith({
			git_push_force: () =>
				Promise.reject(err("non_fast_forward", "the force push")),
		});

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await fireEvent.click(await screen.findByText("Force Push"));

		await waitFor(() => expect(rs.error?.message).toBe("the force push"));
		expect(await screen.findByText("Force Push")).toBeInTheDocument();
		expect(screen.getAllByRole("button")).toHaveLength(2);
	});

	describe("when the repository left the confirmed branch", () => {
		const REFUSAL = err(
			"push_target_changed",
			"You confirmed a force push of feature, but the repository is now on main. Nothing was pushed.",
		);

		async function refusedForcePush() {
			const rs = stateWith(err("non_fast_forward"));
			respondWith({ git_push_force: () => Promise.reject(REFUSAL) });

			render(PushRecoveryPrompt, { props: propsFor(rs) });
			await fireEvent.click(await screen.findByText("Force Push"));
			await waitFor(() => expect(rs.error?.code).toBe("push_target_changed"));
		}

		it("shows the refusal naming both branches, with only a dismiss control", async () => {
			await refusedForcePush();

			expect(screen.getByRole("alert").textContent).toContain(REFUSAL.message);
			expect(screen.getByText("Dismiss")).toBeInTheDocument();
			expect(screen.getAllByRole("button")).toHaveLength(1);
		});

		it("reports no success", async () => {
			await refusedForcePush();

			expect(mockToast).not.toHaveBeenCalled();
		});
	});
});

describe("PushRecoveryPrompt actionless failures", () => {
	it.each(["auth_failure", "remote_error", "no_upstream"])(
		"shows a persistent message with only a dismiss control for %s",
		async (code) => {
			const rs = stateWith(err(code, "raw failure text"));

			render(PushRecoveryPrompt, { props: propsFor(rs) });

			await screen.findByRole("alert");
			expect(screen.getByText("Dismiss")).toBeInTheDocument();
			expect(screen.queryByText("Force Push")).toBeNull();
			expect(screen.getAllByRole("button")).toHaveLength(1);
		},
	);
});

describe("PushRecoveryPrompt push target", () => {
	it("names the target the backend resolved, in the banner and the confirmation", async () => {
		respondWith({
			get_push_target: () =>
				Promise.resolve({ remote: "mirror", branch: "main" }),
		});

		render(PushRecoveryPrompt, {
			props: propsFor(stateWith(err("non_fast_forward"))),
		});
		await fireEvent.click(await screen.findByText("Force Push"));

		expect(screen.getByRole("alert").textContent).toContain("mirror");
		expect(screen.getByRole("alert").textContent).toContain("main");
		await waitFor(() => expect(mockAsk).toHaveBeenCalled());
		const message = mockAsk.mock.calls[0][0] as string;
		expect(message).toContain("mirror");
		expect(message).toContain("main");
	});

	// Git bans ASCII space in a refname but permits U+2028/U+2029/NBSP and the bidi
	// overrides, and AppKit lays the separators out as hard breaks — so a cloned branch
	// name can add its own lines to the dialog. Splitting on "\n" alone cannot see that.
	const RENDERED_BREAK = /[\n\r\u2028\u2029\u0085]/;

	async function confirmationFor(branch: string, remote = "origin") {
		respondWith({ get_push_target: () => Promise.resolve({ remote, branch }) });

		render(PushRecoveryPrompt, {
			props: propsFor(stateWith(err("non_fast_forward"))),
		});
		await fireEvent.click(await screen.findByText("Force Push"));
		await waitFor(() => expect(mockAsk).toHaveBeenCalled());

		return mockAsk.mock.calls[0][0] as string;
	}

	it("renders four lines whatever separators the refname carries", async () => {
		const message = await confirmationFor(
			"main\u2028Nothing will be overwritten — a dry run",
		);

		expect(message.split(RENDERED_BREAK)).toHaveLength(4);
	});

	it("still names the branch and the remote after neutralising separators", async () => {
		const message = await confirmationFor("main\u2028injected");

		expect(message).toContain("main");
		expect(message).toContain("Remote: origin");
	});

	it("caps an overlong refname at the rendered limit", async () => {
		const message = await confirmationFor("x".repeat(200));

		const branchLine = message
			.split(RENDERED_BREAK)
			.find((l) => l.startsWith("Branch: "));
		expect(branchLine).toHaveLength("Branch: ".length + 61);
	});

	it("sends the raw refname, not the one the display capped", async () => {
		const branch = "x".repeat(200);

		await confirmationFor(branch);

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("git_push_force", {
				path: "/repo",
				remote: "origin",
				branch,
			}),
		);
	});

	it("offers no Force Push when the backend cannot name a target", async () => {
		respondWith({
			get_push_target: () => Promise.resolve({ remote: null, branch: null }),
		});

		render(PushRecoveryPrompt, {
			props: propsFor(stateWith(err("non_fast_forward"))),
		});

		await screen.findByRole("alert");
		expect(screen.queryByText("Force Push")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});

describe("PushRecoveryPrompt when the failed operation was not a push", () => {
	it.each([
		["fetch", "fetch" as const],
		["an unrecorded operation", null],
	])("offers no recovery actions after %s", async (_name, lastOp) => {
		const rs = stateWith(err("non_fast_forward"), lastOp);

		render(PushRecoveryPrompt, { props: propsFor(rs) });

		await screen.findByRole("alert");
		expect(screen.getByText("Dismiss")).toBeInTheDocument();
		expect(screen.queryByText("Force Push")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});

describe("PushRecoveryPrompt scoping and clearing", () => {
	it("renders a surface only for the tab whose remote state carries the error (C17)", async () => {
		const withError = stateWith(err("non_fast_forward"));
		const clean = stateWith(null);

		render(PushRecoveryPrompt, {
			props: propsFor(withError),
		});
		render(PushRecoveryPrompt, { props: propsFor(clean) });

		await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
		expect(screen.getByRole("alert").textContent).toContain("feature");
	});

	it("clears the error when dismissed (C18)", async () => {
		const rs = stateWith(err("non_fast_forward"));

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await fireEvent.click(await screen.findByText("Cancel"));

		expect(rs.error).toBeNull();
	});

	it("hides the surface when a subsequent successful op clears the error (C18)", async () => {
		const rs = stateWith(err("non_fast_forward"));

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await screen.findByRole("alert");

		// A later successful remote op resets error at the start of runRemote.
		rs.error = null;

		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});
});

// svelte's own mount + a fine-grained $state props object: testing-library's
// rerender replaces its whole props object, re-running EVERY effect, so it cannot
// prove the gate depends on refreshSignal
// (memory: testing_library_rerender_reruns_effects).
describe("PushRecoveryPrompt gate liveness", () => {
	let target: HTMLElement;
	let app: Record<string, unknown>;

	beforeEach(() => {
		target = document.body.appendChild(document.createElement("div"));
	});

	afterEach(() => {
		unmount(app);
		target.remove();
	});

	it("restores the recovery actions once the repo change clears the merge", async () => {
		let op: unknown = MERGE_OP;
		respondWith({ get_operation_state: () => Promise.resolve(op) });
		const props = reactiveProps(propsFor(stateWith(err("non_fast_forward"))));
		app = mount(PushRecoveryPrompt, { target, props });
		await screen.findByText("Dismiss");

		op = NONE_OP;
		props.refreshSignal = 1;

		expect(await screen.findByText("Force Push")).toBeInTheDocument();
	});
});

describe("PushRecoveryPrompt when the operation-state probe fails", () => {
	it("offers no Force Push", async () => {
		respondWith({
			get_operation_state: () => Promise.reject(err("not_open", "repo closed")),
		});

		render(PushRecoveryPrompt, {
			props: propsFor(stateWith(err("non_fast_forward"))),
		});

		await screen.findByRole("alert");
		expect(screen.queryByText("Force Push")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});

describe("PushRecoveryPrompt defensive gate (D6)", () => {
	it("shows a message, not recovery actions, when a diverged push fails mid-operation", async () => {
		const rs = stateWith(err("non_fast_forward"));
		respondWith({ get_operation_state: () => Promise.resolve(REBASE_OP) });

		render(PushRecoveryPrompt, { props: propsFor(rs) });

		await screen.findByRole("alert");
		expect(screen.getByText("Dismiss")).toBeInTheDocument();
		expect(screen.queryByText("Force Push")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
