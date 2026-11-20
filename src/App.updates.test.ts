import { fireEvent, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupHarness } from "./__tests__/helpers/startup-harness.js";
import { REPO_CHANGE_DELAY_MS } from "./lib/coalesced-task.js";
import type { UpdateStatus } from "./lib/updates.js";

let app: StartupHarness;
afterEach(() => app?.teardown());

const manual: UpdateStatus = {
	phase: "manual",
	current_version: "1.0.0",
	version: null,
	notes: null,
	message: null,
	downloaded: 0,
	total: null,
	eligible: false,
	adopted: false,
};
function startup() {
	app = new StartupHarness(
		[{ id: "active", repoPath: "/active", repoName: "active" }],
		"active",
	);
	app.host.seedResponse("updates_status", manual);
	app.host.seedResponse("updates_ready", manual);
	return app;
}

describe("App update readiness", () => {
	it("surfaces an initial status failure and retries only on request", async () => {
		startup();
		const status = app.host.holdNextReply("updates_status");
		app.start();
		await status.entered;

		status.reject({
			code: "update_error",
			message: "Could not read update state",
		});
		await app.settle();

		expect(screen.queryByRole("alert")).toHaveTextContent(
			"Could not read update state",
		);
		expect(app.host.count("updates_status")).toBe(1);
		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toBeVisible();
		await fireEvent.click(
			screen.getByRole("button", { name: "Retry update status" }),
		);
		await app.settle();
		expect(app.host.count("updates_status")).toBe(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});
	it("retries failed readiness explicitly while retaining the manual recovery route", async () => {
		startup();
		app.host.seedResponse("updates_status", { ...manual, phase: "recovery" });
		const readiness = app.host.holdNextReply("updates_ready");
		app.start();
		await readiness.entered;

		readiness.reject({
			code: "update_error",
			message: "Could not save readiness",
		});
		await app.settle();

		expect(screen.queryByRole("alert")).toHaveTextContent(
			"Could not save readiness",
		);
		expect(app.host.count("updates_ready")).toBe(1);
		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toBeVisible();
		await fireEvent.click(
			screen.getByRole("button", { name: "Retry startup verification" }),
		);
		await app.settle();
		expect(app.host.count("updates_ready")).toBe(2);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
	});
	it("keeps manual recovery and retry available when startup verification is still blocked", async () => {
		startup();
		app.host.seedResponse("updates_status", { ...manual, phase: "recovery" });
		const initial = app.host.holdNextReply("updates_ready");
		app.start();
		await initial.entered;
		initial.reject({
			code: "update_error",
			message: "Stored data needs recovery",
		});
		await app.settle();
		const retry = app.host.holdNextReply("updates_ready");

		await fireEvent.click(
			screen.getByRole("button", { name: "Retry startup verification" }),
		);
		await retry.entered;
		retry.reject({
			code: "update_error",
			message: "Stored data still needs recovery",
		});
		await app.settle();

		expect(app.host.count("updates_ready")).toBe(2);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Stored data still needs recovery",
		);
		expect(
			screen.getByRole("button", { name: "Retry startup verification" }),
		).toBeEnabled();
		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toBeVisible();
	});

	it("acknowledges startup after the active repository has restored its drafts", async () => {
		startup();
		app.host.preferences.set("commit_drafts", {
			"/active": { subject: "restored draft", body: "restored body" },
		});
		const opening = app.host.holdNextReply("open_repo");
		app.start();
		await opening.entered;
		await app.settle();
		expect(app.host.count("updates_ready")).toBe(0);

		opening.release(null);
		await screen.findByDisplayValue("restored draft");
		await app.settle();

		expect(app.host.count("updates_ready")).toBe(1);
	});
	it("retains the install intent when mounted draft recovery fails", async () => {
		startup();
		app.host.preferences.set("update_review_composer:/active", {
			corrupt: true,
		});

		app.start();
		await screen.findByRole("region", { name: "Trunk updates" });
		await app.settle();

		expect(app.host.count("updates_ready")).toBe(0);
		expect(app.host.preferences.get("update_review_composer:/active")).toEqual({
			corrupt: true,
		});
	});
});

describe("App update controls", () => {
	it.each(["manual", "idle", "checking"] as const)(
		"keeps window chrome quiet in %s state",
		async (phase) => {
			startup();
			const status: UpdateStatus = { ...manual, phase };
			app.host.seedResponse("updates_status", status);
			app.host.seedResponse("updates_ready", status);
			app.start();
			await screen.findByText("restored history");
			await app.settle();

			expect(
				screen.queryByRole("button", { name: /Check.*updates/ }),
			).toBeNull();
		},
	);
	it("keeps an available update actionable without an open repository", async () => {
		app = new StartupHarness([], "missing");
		const available: UpdateStatus = {
			...manual,
			phase: "available",
			version: "2.0.0",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", available);
		app.host.seedResponse("updates_ready", available);
		app.host.seedResponse("updates_download", {
			...available,
			phase: "ready",
		});
		app.start();
		const download = await screen.findByRole("button", {
			name: "Download update 2.0.0",
		});

		await fireEvent.click(download);

		expect(
			await screen.findByRole("button", {
				name: "Restart to update to 2.0.0",
			}),
		).toBeEnabled();
	});
	it("downloads the icon's available version and displays the restart action", async () => {
		startup();
		const available: UpdateStatus = {
			...manual,
			phase: "available",
			version: "2.0.0",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", available);
		app.host.seedResponse("updates_ready", available);
		app.host.seedResponse("updates_download", { ...available, phase: "ready" });
		app.start();
		await screen.findByText("restored history");
		await app.settle();

		await fireEvent.click(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);

		expect(
			await screen.findByRole("button", { name: "Restart to update to 2.0.0" }),
		).toBeEnabled();
		expect(
			screen.queryByRole("region", { name: "Update downloaded" }),
		).toBeNull();
		expect(
			app.host.requests.filter(({ cmd }) => cmd === "updates_download"),
		).toEqual([{ cmd: "updates_download", args: { version: "2.0.0" } }]);
	});
	it("shows a returned download failure even when release notes are available", async () => {
		startup();
		const available: UpdateStatus = {
			...manual,
			phase: "available",
			version: "2.0.0",
			notes: "Release changes",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", available);
		app.host.seedResponse("updates_ready", available);
		app.host.seedResponse("updates_download", {
			...available,
			message: "The update signature or signed version is invalid",
		});
		app.start();
		await screen.findByText("restored history");
		await app.settle();

		await fireEvent.click(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);
		await app.settle();

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(
			within(screen.getByRole("region", { name: "Trunk updates" })).getByRole(
				"status",
			),
		).toHaveTextContent("The update signature or signed version is invalid");
		expect(
			screen.getByRole("button", { name: "Download 2.0.0" }),
		).toBeEnabled();
	});
	it("keeps automatic check messages quiet", async () => {
		startup();
		const idle: UpdateStatus = {
			...manual,
			phase: "idle",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", idle);
		app.host.seedResponse("updates_ready", idle);
		app.host.seedResponse("updates_check", {
			...idle,
			message: "Trunk is up to date",
		});
		app.start();
		await screen.findByText("restored history");
		await app.settle();

		app.clock.advanceBy(15_000);
		await app.settle();

		expect(app.host.count("updates_check")).toBe(1);
		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
	});
	it("prepares and installs the confirmed version with its preparation token", async () => {
		startup();
		const ready: UpdateStatus = {
			...manual,
			phase: "ready",
			version: "2.0.0",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", ready);
		app.host.seedResponse("updates_ready", ready);
		app.host.seedResponse("updates_prepare", "prepared-version-2");
		const install = app.host.holdNextReply("updates_install");
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		await fireEvent.click(
			screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Restart and install 2.0.0" }),
		);
		await app.untilRestartBegins();
		const installation = await install.entered;
		install.release(undefined);
		await app.settle();

		expect(
			app.host.requests.filter(({ cmd }) => cmd === "updates_prepare"),
		).toEqual([{ cmd: "updates_prepare", args: { version: "2.0.0" } }]);
		expect(installation).toEqual({
			version: "2.0.0",
			token: "prepared-version-2",
		});
		expect(app.host.count("updates_install")).toBe(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});
	describe("when work is running at the click", () => {
		function seedReady() {
			const ready: UpdateStatus = {
				...manual,
				phase: "ready",
				version: "2.0.0",
				eligible: true,
				adopted: true,
			};
			app.host.seedResponse("updates_status", ready);
			app.host.seedResponse("updates_ready", ready);
			app.host.seedResponse("updates_prepare", "prepared-version-2");
			return ready;
		}

		async function confirmRestart() {
			await fireEvent.click(
				screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Restart and install 2.0.0" }),
			);
			await app.settle();
		}

		async function restartDuringARefresh(fetchIntervalMs = 0) {
			startup();
			seedReady();
			app.host.preferences.set("fetch_interval_ms", fetchIntervalMs);
			app.host.seedResponse("git_fetch_background", {
				outcome: "unchanged",
				remotes: [],
				graph_error: null,
				graph_rebuilds: 0,
			});
			const install = app.host.holdNextReply("updates_install");
			app.start();
			await screen.findByText("restored history");
			await app.settle();
			const refresh = app.host.holdNextReply("get_dirty_counts");
			await app.host.emitRepoChanged({ repo: "/active", paths: ["file.txt"] });
			app.clock.advanceBy(REPO_CHANGE_DELAY_MS);
			await refresh.entered;
			await confirmRestart();
			return { install, refresh };
		}

		it("keeps Trunk usable and restarts once that work finishes", async () => {
			const { install, refresh } = await restartDuringARefresh();

			expect(
				screen.getByText("Trunk will restart when the current work finishes."),
			).toBeVisible();
			expect(app.frozen()).toBe(false);
			expect(app.host.count("updates_prepare")).toBe(0);
			refresh.release({ staged: 0, unstaged: 1 });
			await app.untilRestartBegins();
			await install.entered;
			install.release(undefined);
			await app.settle();

			expect(app.host.count("updates_prepare")).toBe(1);
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("finishes opening a repository picked before the click", async () => {
			startup();
			seedReady();
			app.host.preferences.set("recent_repos", [
				{ path: "/other", name: "other" },
			]);
			const install = app.host.holdNextReply("updates_install");
			app.start();
			await screen.findByText("restored history");
			await app.settle();
			const opening = app.host.holdNextReply("open_repo");
			await app.pickRecent("other");
			await opening.entered;
			await confirmRestart();

			opening.release(null);
			await app.untilRestartBegins();
			await install.entered;
			install.release(undefined);
			await app.settle();

			expect(screen.getByRole("tab", { name: "other" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			expect(app.host.preferences.get("recent_repos")).toEqual([
				expect.objectContaining({ path: "/other" }),
			]);
			expect(app.host.count("updates_prepare")).toBe(1);
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("starts no automatic fetch while it waits", async () => {
			const { install, refresh } = await restartDuringARefresh(60_000);
			const fetchesBefore = app.host.count("git_fetch_background");

			await app.advanceFetches(2);

			expect(app.host.count("git_fetch_background")).toBe(fetchesBefore);
			refresh.release({ staged: 0, unstaged: 1 });
			await app.untilRestartBegins();
			await install.entered;
			install.release(undefined);
			await app.settle();
		});

		it("brings the panel back when the restart freezes Trunk", async () => {
			const { install, refresh } = await restartDuringARefresh();
			await fireEvent.pointerDown(document.body);
			const closed =
				screen.queryByRole("region", { name: "Trunk updates" }) === null;

			refresh.release({ staged: 0, unstaged: 1 });
			await app.untilRestartBegins();
			await install.entered;

			expect(closed).toBe(true);
			expect(
				screen.getByRole("region", { name: "Trunk updates" }),
			).toBeVisible();
			install.release(undefined);
			await app.settle();
		});

		it("calls the restart off while the backend finishes hidden work", async () => {
			startup();
			app.host.seedResponse("updates_abort", seedReady());
			const drain = app.host.holdNextReply("updates_drained");
			app.start();
			await screen.findByText("restored history");
			await app.settle();
			await confirmRestart();
			await app.untilRestartBegins();
			await drain.entered;
			const frozen = app.frozen();

			await fireEvent.click(
				screen.getByRole("button", { name: "Cancel restart" }),
			);
			drain.reject({
				code: "update_preparing",
				message: "Preparation was aborted.",
			});
			await app.settle();

			expect(frozen).toBe(true);
			expect(app.host.count("updates_abort")).toBe(1);
			expect(app.host.count("updates_install")).toBe(0);
			expect(app.frozen()).toBe(false);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(
				screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
			).toBeEnabled();
		});

		it("prepares nothing when the restart is cancelled first", async () => {
			const { refresh } = await restartDuringARefresh();

			await fireEvent.click(
				screen.getByRole("button", { name: "Cancel restart" }),
			);
			refresh.release({ staged: 0, unstaged: 1 });
			await app.settle();

			expect(
				screen.queryByText(
					"Trunk will restart when the current work finishes.",
				),
			).toBeNull();
			expect(app.host.count("updates_prepare")).toBe(0);
		});
	});
	it("keeps manual updates reachable from the native menu", async () => {
		startup().start();
		await screen.findByText("restored history");
		await app.settle();

		await app.host.emit("updates-open", null);
		await app.settle();

		expect(
			screen.getByRole("link", { name: "Download a release" }),
		).toBeVisible();
		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it("keeps an available update in the title bar when the sidebar is collapsed", async () => {
		startup();
		const available: UpdateStatus = {
			...manual,
			phase: "available",
			version: "2.0.0",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", available);
		app.host.seedResponse("updates_ready", available);
		app.start();
		await screen.findByText("restored history");
		await app.settle();

		await fireEvent.keyDown(window, { key: "j", ctrlKey: true });
		await app.settle();

		expect(
			within(screen.getByRole("banner")).getByRole("button", {
				name: "Download update 2.0.0",
			}),
		).toBeVisible();
	});
	it("keeps one app update control when switching repositories", async () => {
		app = new StartupHarness(
			[
				{ id: "active", repoPath: "/active", repoName: "active" },
				{ id: "other", repoPath: "/other", repoName: "other" },
			],
			"active",
		);
		const available: UpdateStatus = {
			...manual,
			phase: "available",
			version: "2.0.0",
			notes: "Changes",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", available);
		app.host.seedResponse("updates_ready", available);
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		await fireEvent.focus(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);
		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();

		await app.activate("other");
		await app.settle();

		expect(
			screen.getAllByRole("button", { name: "Download update 2.0.0" }),
		).toHaveLength(1);
	});
	it("dismisses the update panel before Escape closes the current diff", async () => {
		startup();
		const available: UpdateStatus = {
			...manual,
			phase: "available",
			version: "2.0.0",
			notes: "Changes",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", available);
		app.host.seedResponse("updates_ready", available);
		app.host.seedResponse("get_status", {
			unstaged: [{ path: "README.md", status: "Modified", is_binary: false }],
			staged: [],
			conflicted: [],
		});
		app.host.seedResponse("diff_unstaged", [
			{
				path: "README.md",
				old_path: null,
				status: "Modified",
				is_binary: false,
				hunks: [],
			},
		]);
		app.start();
		await fireEvent.click(await screen.findByText("README.md"));
		await vi.dynamicImportSettled();
		await app.settle();
		expect(screen.getByRole("button", { name: "Close diff" })).toBeVisible();
		const trigger = screen.getByRole("button", {
			name: "Download update 2.0.0",
		});
		trigger.focus();
		await app.settle();

		await fireEvent.keyDown(trigger, { key: "Escape" });

		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
		expect(screen.getByRole("button", { name: "Close diff" })).toBeVisible();

		await fireEvent.keyDown(trigger, { key: "Escape" });
		expect(screen.queryByRole("button", { name: "Close diff" })).toBeNull();
	});
	it("keeps the update panel attached when the sidebar switches to reviews", async () => {
		startup();
		const available: UpdateStatus = {
			...manual,
			phase: "available",
			version: "2.0.0",
			notes: "Changes",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", available);
		app.host.seedResponse("updates_ready", available);
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Download update 2.0.0" }),
		);
		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();

		await app.enterReview();

		expect(screen.getByRole("region", { name: "Trunk updates" })).toBeVisible();
		expect(
			screen.getAllByRole("button", {
				name: "Download update 2.0.0",
				hidden: true,
			}),
		).toHaveLength(1);
	});
	it("asks before restarting and cancels without preparing installation", async () => {
		startup();
		const ready = {
			...manual,
			phase: "ready",
			version: "2.0.0",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", ready);
		app.host.seedResponse("updates_ready", ready);
		app.start();
		await screen.findByText("restored history");
		await app.settle();

		await fireEvent.click(
			screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
		);
		expect(
			screen.getByRole("heading", { name: "Restart and install 2.0.0?" }),
		).toBeVisible();
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			screen.queryByRole("heading", { name: "Restart and install 2.0.0?" }),
		).toBeNull();
		expect(app.host.count("updates_prepare")).toBe(0);
		expect(app.host.count("updates_install")).toBe(0);
	});
	it("invalidates restart confirmation when the downloaded version changes", async () => {
		startup();
		const ready: UpdateStatus = {
			...manual,
			phase: "ready",
			version: "2.0.0",
			eligible: true,
			adopted: true,
		};
		app.host.seedResponse("updates_status", ready);
		app.host.seedResponse("updates_ready", ready);
		app.start();
		await screen.findByText("restored history");
		await app.settle();
		await fireEvent.click(
			screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
		);

		await app.host.emit("updates-changed", { ...ready, version: "3.0.0" });
		await app.settle();

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(
			screen.queryByRole("heading", { name: "Restart and install 2.0.0?" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Restart to update to 3.0.0" }),
		).toBeEnabled();
		expect(app.host.count("updates_prepare")).toBe(0);
	});
	it("keeps downloaded snapshots quiet and exposes restart guidance on hover without notes", async () => {
		startup().start();
		await app.settle();
		const ready: UpdateStatus = {
			...manual,
			phase: "ready",
			version: "2.0.0",
			eligible: true,
			adopted: true,
		};

		await app.host.emit("updates-changed", ready);
		await app.settle();
		await app.host.emit("updates-changed", ready);
		await app.settle();

		expect(
			screen.queryByRole("region", { name: "Update downloaded" }),
		).toBeNull();
		expect(screen.queryByRole("region", { name: "Trunk updates" })).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();

		await fireEvent.mouseEnter(
			screen.getByRole("button", { name: "Restart to update to 2.0.0" }),
		);

		const panel = screen.getByRole("region", { name: "Trunk updates" });
		expect(panel).toHaveTextContent("Restart Trunk");
		expect(panel).toHaveTextContent("2.0.0");
		expect(
			within(panel).getByRole("link", { name: "Update details" }),
		).toHaveAttribute(
			"href",
			"https://github.com/joaofnds/trunk/releases/tag/v2.0.0",
		);
		expect(app.host.count("updates_prepare")).toBe(0);
	});
	it.each(["ready", "available"] as const)(
		"checks from the native menu in %s state",
		async (phase) => {
			startup();
			const status: UpdateStatus = {
				...manual,
				phase,
				version: "2.0.0",
				eligible: true,
				adopted: true,
			};
			app.host.seedResponse("updates_status", status);
			app.host.seedResponse("updates_ready", status);
			app.host.seedResponse("updates_check", status);
			app.start();
			await app.settle();

			await app.host.emit("updates-open", null);
			await app.settle();

			expect(app.host.count("updates_check")).toBe(1);
		},
	);
	it.each(["downloading", "recovery"] as const)(
		"keeps the native menu on details in %s state",
		async (phase) => {
			startup();
			const status = {
				...manual,
				phase,
				eligible: true,
				adopted: true,
			};
			app.host.seedResponse("updates_status", status);
			app.host.seedResponse("updates_ready", status);
			app.start();
			await app.settle();

			await app.host.emit("updates-open", null);
			await app.settle();

			expect(app.host.count("updates_check")).toBe(0);
			expect(
				screen.getByRole("region", { name: "Trunk updates" }),
			).toBeVisible();
		},
	);
	it("checks immediately from the native menu for an adopted installation", async () => {
		startup();
		const idle = { ...manual, phase: "idle", eligible: true, adopted: true };
		app.host.seedResponse("updates_status", idle);
		app.host.seedResponse("updates_ready", idle);
		app.host.seedResponse("updates_check", idle);
		app.start();
		await app.settle();

		await app.host.emit("updates-open", null);
		await app.settle();

		expect(app.host.count("updates_check")).toBe(1);
	});
});
