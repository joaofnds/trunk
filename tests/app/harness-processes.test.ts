import { describe, expect, test } from "vitest";
import { descendantsOf } from "./harness/processes.js";

describe("descendantsOf", () => {
	test("names the host's children and theirs, and nothing else", () => {
		const table = [
			"    1     0 10-00:00:00   1:00.00 /sbin/launchd",
			"  400     1    00:20   0:01.00 app_host",
			"  401   400    00:12   0:00.01 git rebase -- feature",
			"  402   401    00:12   0:00.00 /usr/bin/xcrun git rebase -- feature",
			"  500     1    00:30   0:02.00 node vitest",
		].join("\n");

		expect(descendantsOf(table, 400)).toEqual([
			"401   400    00:12   0:00.01 git rebase -- feature",
			"402   401    00:12   0:00.00 /usr/bin/xcrun git rebase -- feature",
		]);
	});

	test("finds none for a host that started nothing", () => {
		expect(
			descendantsOf("  400     1  00:20  0:01.00 app_host\n", 400),
		).toEqual([]);
	});
});
