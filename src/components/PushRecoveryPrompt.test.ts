import { ask } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke, type TrunkError } from "../lib/invoke.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
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

function err(code: string, message = "boom"): TrunkError {
	return { code, message };
}

function stateWith(error: TrunkError | null) {
	const rs = createRemoteState();
	rs.error = error;
	return rs;
}

function baseProps(error: TrunkError | null, overrides = {}) {
	return {
		repoPath: "/repo",
		remoteState: stateWith(error),
		branch: "feature",
		remote: "origin",
		onclear: vi.fn(),
		...overrides,
	};
}

function propsFor(rs: ReturnType<typeof createRemoteState>, overrides = {}) {
	return {
		repoPath: "/repo",
		remoteState: rs,
		branch: "feature",
		remote: "origin",
		onclear: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation((cmd: string) => {
		if (cmd === "get_operation_state") return Promise.resolve(NONE_OP);
		return Promise.resolve(undefined);
	});
	mockToast.mockReset();
	mockAsk.mockReset();
	mockAsk.mockResolvedValue(true);
});

describe("PushRecoveryPrompt", () => {
	it("renders nothing when there is no error", () => {
		const { container } = render(PushRecoveryPrompt, {
			props: baseProps(null),
		});
		expect(container.textContent?.trim()).toBe("");
	});

	it("offers Force Push and Cancel for a diverged push, naming branch and remote", async () => {
		render(PushRecoveryPrompt, { props: baseProps(err("non_fast_forward")) });

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
		render(PushRecoveryPrompt, { props: baseProps(refusal) });

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
		const rs = createRemoteState();
		rs.error = err("non_fast_forward");

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

	it("sends nothing when the confirmation is declined", async () => {
		mockAsk.mockResolvedValue(false);
		const rs = createRemoteState();
		rs.error = err("non_fast_forward");

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await fireEvent.click(await screen.findByText("Force Push"));

		await waitFor(() => expect(mockAsk).toHaveBeenCalled());
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"git_push_force",
			expect.anything(),
		);
	});

	it("re-opens the two recovery choices when the force push is refused by if-includes (C12)", async () => {
		mockAsk.mockResolvedValue(true);
		const rs = createRemoteState();
		rs.error = err("non_fast_forward");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(NONE_OP);
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
			const rs = createRemoteState();
			rs.error = err(code, "raw failure text");

			render(PushRecoveryPrompt, { props: propsFor(rs) });

			const surface = await screen.findByRole("alert");
			expect(surface.textContent?.trim().length ?? 0).toBeGreaterThan(0);
			expect(screen.getByText("Dismiss")).toBeInTheDocument();
			expect(screen.queryByText("Force Push")).toBeNull();
			expect(screen.getAllByRole("button")).toHaveLength(1);
		},
	);
});

describe("PushRecoveryPrompt scoping and clearing", () => {
	it("renders a surface only for the tab whose remote state carries the error (C17)", async () => {
		const withError = createRemoteState();
		withError.error = err("non_fast_forward");
		const clean = createRemoteState();

		render(PushRecoveryPrompt, {
			props: propsFor(withError, { branch: "feature", remote: "origin" }),
		});
		render(PushRecoveryPrompt, {
			props: propsFor(clean, { branch: "other", remote: "upstream" }),
		});

		await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
		expect(screen.getByRole("alert").textContent).toContain("feature");
	});

	it("clears the error and notifies the parent when dismissed (C18)", async () => {
		const rs = createRemoteState();
		rs.error = err("non_fast_forward");
		const onclear = vi.fn();

		render(PushRecoveryPrompt, { props: propsFor(rs, { onclear }) });
		await fireEvent.click(await screen.findByText("Cancel"));

		expect(rs.error).toBeNull();
		expect(onclear).toHaveBeenCalledTimes(1);
	});

	it("hides the surface when a subsequent successful op clears the error (C18)", async () => {
		const rs = createRemoteState();
		rs.error = err("non_fast_forward");

		render(PushRecoveryPrompt, { props: propsFor(rs) });
		await screen.findByRole("alert");

		// A later successful remote op resets error at the start of runRemote.
		rs.error = null;

		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});
});

describe("PushRecoveryPrompt defensive gate (D6)", () => {
	it("shows a message, not recovery actions, when a diverged push fails mid-operation", async () => {
		const rs = createRemoteState();
		rs.error = err("non_fast_forward");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_operation_state") return Promise.resolve(REBASE_OP);
			return Promise.resolve(undefined);
		});

		render(PushRecoveryPrompt, { props: propsFor(rs) });

		await screen.findByRole("alert");
		expect(screen.getByText("Dismiss")).toBeInTheDocument();
		expect(screen.queryByText("Force Push")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
