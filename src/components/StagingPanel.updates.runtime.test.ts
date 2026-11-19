import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeScheduler } from "../../tests/app/fakes/scheduler.js";
import { RepositoryReadHost } from "../__tests__/helpers/repository-read-host.js";
import UpdateStagingHarness from "../__tests__/helpers/update-staging-harness.svelte";
import { SCHEDULER } from "../lib/scheduler.js";
import {
	setUpdateFrozen,
	UpdatePreparation,
} from "../lib/updates-lifecycle.js";

let host: RepositoryReadHost;
beforeEach(() => {
	host = new RepositoryReadHost();
	host.install();
});
afterEach(() => {
	cleanup();
	setUpdateFrozen(false);
	host.dispose();
});

async function openPausedRebase(message: string) {
	host.seedResponse("get_operation_state", {
		op_type: "Rebase",
		source_branch: "feature",
		target_branch: "main",
		onto_oid: null,
		progress: "2/5",
		rebase_message: message,
	});
	const installed: string[] = [];
	const preparation = new UpdatePreparation({
		prepare: async () => "permit",
		drained: async () => {},
		install: async (version) => {
			installed.push(version);
		},
		abort: async () => {},
		freeze: setUpdateFrozen,
		settle: tick,
		waiting: () => {},
	});
	render(UpdateStagingHarness, {
		props: { preparation },
		context: new Map([[SCHEDULER, new FakeScheduler()]]),
	});
	await screen.findByPlaceholderText("Commit message summary");
	await tick();
	return { preparation, installed };
}

describe("StagingPanel update preparation", () => {
	it.each([
		{ name: "one newline", message: "subject\nbody" },
		{ name: "standard separator", message: "subject\n\nbody" },
		{ name: "comment lines", message: "subject\n# comment\n\nbody\n" },
		{
			name: "body whitespace",
			message: "subject\n\n  indented body\n\nsecond paragraph",
		},
	])(
		"accepts an unchanged paused rebase message with $name",
		async ({ message }) => {
			const view = await openPausedRebase(message);

			await view.preparation.install("2.0.0");

			expect(view.installed).toEqual(["2.0.0"]);
		},
	);
	it.each([
		{ field: "Commit message summary", value: "edited subject" },
		{ field: "Description (optional)", value: "edited body" },
		{ field: "Commit message summary", value: "subject " },
		{ field: "Description (optional)", value: "body\n" },
	])("blocks the authored $field edit '$value'", async ({ field, value }) => {
		const view = await openPausedRebase("subject\n\nbody");

		await fireEvent.input(screen.getByPlaceholderText(field), {
			target: { value },
		});
		await expect(view.preparation.install("2.0.0")).rejects.toThrow(
			"paused rebase message",
		);

		expect(view.installed).toEqual([]);
	});
});
