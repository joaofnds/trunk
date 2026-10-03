import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function stylesheet(name: string): string {
	return readFileSync(resolve(process.cwd(), "src", name), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);
}

const tokens = stylesheet("tokens.css");
const theme = stylesheet("theme.css");

function declared(css: string, prefix: string): string[] {
	return [...css.matchAll(new RegExp(`^\\t(${prefix}[\\w-]+):`, "gm"))].map(
		([, name]) => name,
	);
}

function mapped(namespace: string): Map<string, string> {
	return new Map(
		[
			...theme.matchAll(
				new RegExp(`^\\t(${namespace}[\\w-]+): ([^;]+);`, "gm"),
			),
		].map(([, name, value]) => [name, value]),
	);
}

describe("theme.css", () => {
	it("declares the theme inline, so a utility reads the token directly", () => {
		expect(theme).toMatch(/^@theme inline \{$/m);
	});

	it("keeps the tokens out of any cascade layer, so the theme's self-referencing root block loses to them", () => {
		expect(tokens).not.toMatch(/@layer/);
	});

	it("writes no literal, only a var() over a token", () => {
		const values = [...theme.matchAll(/^\t--[\w-]+: ([^;]+);/gm)].map(
			([, value]) => value,
		);

		expect(values.filter((v) => !/^var\(--[\w-]+\)$/.test(v))).toEqual([]);
	});

	it("maps every color role", () => {
		const roles = declared(tokens, "--color-");

		expect([...mapped("--color-").keys()]).toEqual(roles);
	});

	it("maps every spacing step", () => {
		const steps = declared(tokens, "--space-");

		expect([...mapped("--spacing-").values()]).toEqual(
			expect.arrayContaining(steps.map((s) => `var(${s})`)),
		);
	});

	it("maps every chrome height into the spacing namespace", () => {
		const heights = declared(tokens, "--").filter((name) =>
			/-h$|^--target-min$/.test(name),
		);

		expect([...mapped("--spacing-").values()]).toEqual(
			expect.arrayContaining(heights.map((h) => `var(${h})`)),
		);
	});

	it("maps every text step with its line height", () => {
		const steps = declared(tokens, "--text-");

		expect([...mapped("--text-").entries()]).toEqual(
			steps.map((s) => [s, `var(${s})`]),
		);
	});

	const roles = [
		...declared(tokens, "--weight-").map((w) =>
			w.replace("--weight-", "--font-weight-"),
		),
		...declared(tokens, "--font-"),
		...declared(tokens, "--leading-"),
		...declared(tokens, "--tracking-"),
		...declared(tokens, "--shadow-").filter((s) => !/-\d$/.test(s)),
		...declared(tokens, "--animate-"),
	];
	it.each(roles)("maps %s onto its token", (role) => {
		expect(theme).toMatch(new RegExp(`^\\t${role}: var\\(--[\\w-]+\\);$`, "m"));
	});

	it("gives every transition the motion tokens' duration and curve", () => {
		expect(theme).toMatch(
			/^\t--default-transition-duration: var\(--duration-fast\);$/m,
		);
		expect(theme).toMatch(
			/^\t--default-transition-timing-function: var\(--ease-standard\);$/m,
		);
	});
});
