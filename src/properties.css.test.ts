import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "src");
const properties = readFileSync(join(root, "properties.css"), "utf8");

/** Every file that can set or read a property: a component, a stylesheet or a
 *  module, with the registrations themselves left out. */
function sources(dir = root): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sources(full);
		const isSource = /\.(svelte|css|ts)$/.test(entry.name);
		const isExcluded =
			entry.name.endsWith(".test.ts") || entry.name === "properties.css";
		return isSource && !isExcluded ? [readFileSync(full, "utf8")] : [];
	});
}

interface Registration {
	name: string;
	body: string;
}

function registrations(css: string): Registration[] {
	return [...css.matchAll(/@property (--[\w-]+) \{([^}]*)\}/g)].map(
		([, name, body]) => ({ name, body }),
	);
}

describe("properties.css", () => {
	const registered = registrations(properties);
	const names = new Set(registered.map(({ name }) => name));
	const all = sources().join("\n");

	it("registers at least one property", () => {
		expect(registered.length).toBeGreaterThan(0);
	});

	it.each(registered)(
		"$name carries a typed syntax, inherits and an initial value, since a browser drops an incomplete registration without a word",
		({ body }) => {
			expect(body).toMatch(/syntax: "<[a-z-]+>";/);
			expect(body).toMatch(/inherits: (?:true|false);/);
			expect(body).toMatch(/initial-value: [^;]+;/);
		},
	);

	it.each(registered)(
		"$name is set by a component or module at runtime, so the registration is not a token in disguise",
		({ name }) => {
			expect(all).toMatch(new RegExp(`${name}(?=["=:])`));
		},
	);

	it.each(registered)("$name is read by a stylesheet", ({ name }) => {
		expect(all).toMatch(new RegExp(`var\\(${name}[,)]`));
	});

	it("registers every property a component hands off through a style:-- directive", () => {
		const handedOff = [...all.matchAll(/style:(--[\w-]+)=/g)].map(
			([, name]) => name,
		);

		const unregistered = [...new Set(handedOff)].filter(
			(name) => !names.has(name),
		);

		expect(unregistered).toEqual([]);
	});
});
