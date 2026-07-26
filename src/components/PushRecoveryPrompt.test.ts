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

vi.mock("../lib/invoke.js", () => ({ safeInvoke: vi.fn() }));
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

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation((cmd: string) => {
		if (cmd === "get_operation_state") return Promise.resolve(NONE_OP);
		if (cmd === "get_push_target") return Promise.resolve(PUSH_TARGET);
		return Promise.resolve(undefined);
	});
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
		const refusal = err(
			"non_fast_forward",
			"! [rejected] main -> main (remote ref updated since checkout)\nerror: failed to push some refs",
		);
		render(PushRecoveryPrompt, { props: propsFor(stateWith(refusal)) });

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

	it("re-opens the two recovery choices when the force push is refused by if-includes (C12)", async () => {
		mockAsk.mockResolvedValue(true);
		const rs = stateWith(err("non_fast_forward"));
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(NONE_OP);
			if (cmd === "get_push_target") return Promise.resolve(PUSH_TARGET);
			if (cmd === "git_push_force")
				return Promise.reject(err("non_fast_forward"));
			return Promise.resolve(undefined);
		});

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await fireEvent.click(await screen.findByText("Force Push"));

		expect(await screen.findByText("Force Push")).toBeInTheDocument();
		expect(screen.getByText("Cancel")).toBeInTheDocument();
		expect(screen.getAllByRole("button")).toHaveLength(2);
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
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(NONE_OP);
			if (cmd === "get_push_target")
				return Promise.resolve({ remote: "mirror", branch: "main" });
			return Promise.resolve(undefined);
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

	it("confines a hostile refname to its own line and caps its length", async () => {
		const hostile = `main Force push? This overwrites nothing.${"x".repeat(200)}`;
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(NONE_OP);
			if (cmd === "get_push_target")
				return Promise.resolve({ remote: "origin", branch: hostile });
			return Promise.resolve(undefined);
		});

		render(PushRecoveryPrompt, {
			props: propsFor(stateWith(err("non_fast_forward"))),
		});
		await fireEvent.click(await screen.findByText("Force Push"));
		await waitFor(() => expect(mockAsk).toHaveBeenCalled());

		const lines = (mockAsk.mock.calls[0][0] as string).split("\n");
		const branchLine = lines.find((l) => l.startsWith("Branch: "));
		expect(branchLine).toBeDefined();
		expect(lines).toContain("Remote: origin");
		expect(branchLine?.length).toBeLessThan(hostile.length);
	});

	it("offers no Force Push when the backend cannot name a target", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(NONE_OP);
			if (cmd === "get_push_target")
				return Promise.resolve({ remote: null, branch: null });
			return Promise.resolve(undefined);
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
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(op);
			if (cmd === "get_push_target") return Promise.resolve(PUSH_TARGET);
			return Promise.resolve(undefined);
		});
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
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state")
				return Promise.reject(err("not_open", "repo closed"));
			if (cmd === "get_push_target") return Promise.resolve(PUSH_TARGET);
			return Promise.resolve(undefined);
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
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(REBASE_OP);
			if (cmd === "get_push_target") return Promise.resolve(PUSH_TARGET);
			return Promise.resolve(undefined);
		});

		render(PushRecoveryPrompt, { props: propsFor(rs) });

		await screen.findByRole("alert");
		expect(screen.getByText("Dismiss")).toBeInTheDocument();
		expect(screen.queryByText("Force Push")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
