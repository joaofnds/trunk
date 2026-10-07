import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { type AST, parse } from "svelte/compiler";
import { __unstable__loadDesignSystem } from "tailwindcss";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "src");
const require = createRequire(import.meta.url);

function files(dir: string, extension: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return files(full, extension);
		return entry.name.endsWith(extension) ? [full] : [];
	});
}

const stripped = (file: string) =>
	readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The design system the app builds: Tailwind over theme.css and nothing else,
 *  so a class the reset removed generates no CSS here either. */
const theme = await __unstable__loadDesignSystem(
	`@import "tailwindcss";\n${stripped(join(root, "theme.css"))}`,
	{
		base: root,
		loadStylesheet: async (id, base) => ({
			path: id,
			base,
			content: readFileSync(
				require.resolve(id === "tailwindcss" ? "tailwindcss/index.css" : id),
				"utf8",
			),
		}),
	},
);
const generated = new Map<string, boolean>();
function utility(word: string): boolean {
	const known = generated.get(word);
	if (known !== undefined) return known;

	const result = theme.candidatesToCss([word])[0] !== null;
	generated.set(word, result);
	return result;
}

/** Tailwind's variant anchors. `group` emits nothing itself; `group-hover:` reads it.
 *  A named one, `group/head`, is read only by `group-hover/head:`, so a group
 *  nested in another answers to its own pointer. */
const MARKERS = new Set(["group", "peer"]);
const NAMED_MARKER = /^(?:group|peer)\/[a-z][a-z-]*$/;

/** A class a script or test reaches for by selector is a hook, styled or not. */
const SELECTOR = /["'`](?:[^"'`]*[\s>,(+~])?\.(-?[a-zA-Z_][\w-]*)/g;
const selected = (source: string) =>
	[...source.matchAll(SELECTOR)].map(([, name]) => name);

const hooks = new Set(
	[
		...files(root, ".ts"),
		...files(resolve(process.cwd(), "tests"), ".ts"),
	].flatMap((file) => selected(readFileSync(file, "utf8"))),
);
const globalClasses = new Set(
	files(root, ".css").flatMap((file) =>
		[...stripped(file).matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map(
			([, name]) => name,
		),
	),
);

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
	typeof value === "object" && value !== null && "type" in value;

function descendants(tree: unknown, type: string, found: Node[] = []): Node[] {
	if (Array.isArray(tree)) {
		for (const child of tree) descendants(child, type, found);
		return found;
	}
	if (!isNode(tree)) return found;

	if (tree.type === type) found.push(tree);
	for (const value of Object.values(tree)) descendants(value, type, found);
	return found;
}

const isClassSelector = (node: Node): node is Node & AST.CSS.ClassSelector =>
	node.type === "ClassSelector";
const ELEMENTS = ["RegularElement", "Component", "SvelteElement"];
const isElement = (node: Node): node is Node & AST.ElementLike =>
	ELEMENTS.includes(String(node.type));

type Expression = AST.ExpressionTag["expression"];
type Statement = AST.Script["content"]["body"][number];
/** The component's own `const` bindings, so a class string a primitive keeps
 *  in its script is read where the markup spreads it. */
type Scope = Map<string, Expression>;
const OPAQUE = "\u0000";
const PATTERNS = new Set([
	"ObjectPattern",
	"ArrayPattern",
	"RestElement",
	"AssignmentPattern",
]);
const isExpression = (node: { type: string }): node is Expression =>
	!PATTERNS.has(node.type);

function scope(...scripts: (AST.Script | null)[]): Scope {
	const bindings: Scope = new Map();
	const statements: Statement[] = scripts.flatMap(
		(script) => script?.content.body ?? [],
	);
	for (const statement of statements) {
		const declaration =
			statement.type === "ExportNamedDeclaration"
				? statement.declaration
				: statement;
		if (declaration?.type !== "VariableDeclaration") continue;
		if (declaration.kind !== "const") continue;
		for (const { id, init } of declaration.declarations) {
			if (id.type === "Identifier" && init) bindings.set(id.name, init);
		}
	}
	return bindings;
}

/** Every string an attribute's expression can evaluate to, or null when the
 *  value is computed, a call or a binding the scope lacks, and the static text
 *  around it is all a reader can check. A lookup into a const object yields
 *  every value it holds, since which one the markup picks is a runtime matter. */
function literals(node: Expression, bindings: Scope): string[] | null {
	const of = (child: Expression) => literals(child, bindings) ?? [OPAQUE];
	switch (node.type) {
		case "Literal":
			return [typeof node.value === "string" ? node.value : ""];
		case "TemplateLiteral": {
			let acc = [""];
			node.quasis.forEach((quasi, i) => {
				acc = acc.map((a) => a + (quasi.value.cooked ?? ""));
				const expression = node.expressions[i];
				if (expression) acc = product(acc, of(expression));
			});
			return acc;
		}
		case "BinaryExpression":
			return node.operator === "+" && node.left.type !== "PrivateIdentifier"
				? product(of(node.left), of(node.right))
				: null;
		case "ConditionalExpression":
			return [...of(node.consequent), ...of(node.alternate)];
		case "LogicalExpression":
			return node.operator === "&&"
				? [...of(node.right), ""]
				: [...of(node.left), ...of(node.right)];
		case "ArrayExpression":
			return node.elements.flatMap((element) =>
				element && element.type !== "SpreadElement" ? of(element) : [OPAQUE],
			);
		case "ObjectExpression":
			return node.properties.map((property) => {
				if (property.type !== "Property" || property.computed) return OPAQUE;
				const key = property.key;
				if (key.type === "Identifier") return key.name;
				return key.type === "Literal" ? String(key.value) : OPAQUE;
			});
		case "Identifier": {
			if (node.name === "undefined") return [""];

			const bound = bindings.get(node.name);
			return bound ? literals(bound, bindings) : null;
		}
		case "MemberExpression": {
			if (node.object.type !== "Identifier") return null;
			const bound = bindings.get(node.object.name);
			if (bound?.type !== "ObjectExpression") return null;
			return bound.properties.flatMap((property) =>
				property.type === "Property" && isExpression(property.value)
					? of(property.value)
					: [OPAQUE],
			);
		}
		default:
			return null;
	}
}

function product(prefixes: string[], options: string[]): string[] {
	const combined = prefixes.flatMap((p) => options.map((o) => p + o));
	if (combined.length > 512)
		throw new Error("class expression too wide to enumerate");
	return combined;
}

type Chunks = AST.Attribute["value"];
/** The words an attribute can render, a `class` or a `role`. A word holding
 *  OPAQUE has a part the parser cannot see past, and its static prefix is all
 *  that is known of it. */
function words(value: Chunks, bindings: Scope): string[] {
	if (value === true) return [];
	let acc = [""];
	for (const chunk of Array.isArray(value) ? value : [value]) {
		const options =
			chunk.type === "Text"
				? [chunk.data]
				: (literals(chunk.expression, bindings) ?? [OPAQUE]);
		acc = product(acc, options);
	}
	return [...new Set(acc.flatMap((s) => s.split(/\s+/)).filter(Boolean))];
}

const isStatic = (value: AST.StyleDirective["value"]) =>
	Array.isArray(value) && value.every((chunk) => chunk.type === "Text");

function component(file: string) {
	const source = readFileSync(file, "utf8");
	const ast = parse(source, { modern: true });
	const declared = new Set([...globalClasses, ...hooks, ...MARKERS]);
	for (const selector of descendants(ast.css, "ClassSelector")) {
		if (isClassSelector(selector)) declared.add(selector.name);
	}
	if (ast.instance) {
		for (const name of selected(
			source.slice(ast.instance.start, ast.instance.end),
		)) {
			declared.add(name);
		}
	}
	const attributes = descendants(ast.fragment, "RegularElement")
		.concat(
			descendants(ast.fragment, "Component"),
			descendants(ast.fragment, "SvelteElement"),
		)
		.filter(isElement)
		.flatMap((element) => element.attributes);
	return { declared, attributes, bindings: scope(ast.module, ast.instance) };
}

function classOffences(file: string): string[] {
	const { declared, attributes, bindings } = component(file);
	const vouched = (word: string) =>
		declared.has(word) || NAMED_MARKER.test(word) || utility(word);
	const offences = new Set<string>();
	for (const attribute of attributes) {
		if (attribute.type === "ClassDirective" && !vouched(attribute.name)) {
			offences.add(`class:${attribute.name}`);
		}
		if (attribute.type !== "Attribute" || attribute.name !== "class") continue;
		for (const word of words(attribute.value, bindings)) {
			const shown = word.replaceAll(OPAQUE, "{…}");
			if (/\[|\(--/.test(word)) {
				offences.add(`${shown} (an arbitrary value; declare a token)`);
			} else if (word.includes(OPAQUE)) {
				const prefix = word.slice(0, word.indexOf(OPAQUE));
				if (prefix && ![...declared].some((name) => name.startsWith(prefix))) {
					offences.add(`${shown} (no declared class starts with "${prefix}")`);
				}
			} else if (!vouched(word)) {
				offences.add(word);
			}
		}
	}
	return [...offences];
}

function staticStyleDirectives(file: string): string[] {
	return component(file)
		.attributes.filter((attribute) => attribute.type === "StyleDirective")
		.filter(
			(directive) =>
				!directive.name.startsWith("--") && isStatic(directive.value),
		)
		.map((directive) => `style:${directive.name}`);
}

const components = files(root, ".svelte").map((file) => relative(root, file));

/** The primitives live here; everything else draws a control through one of them. */
const PRIMITIVES = "lib/ui/";

const CONTROL_ROLES = ["button", "tab"];
const UNREAD = "{…}";

/** What makes one element a control, as the tag would be written: a `role` or
 *  a `this` that can be a control's, or that the scope cannot enumerate. */
function controlMarks(element: AST.ElementLike, bindings: Scope): string[] {
	const marks: string[] = [];
	if (element.type === "RegularElement" && element.name === "button") {
		marks.push("<button>");
	}

	if (element.type === "SvelteElement") {
		const tags = literals(element.tag, bindings) ?? [OPAQUE];
		if (tags.some((tag) => tag.includes(OPAQUE))) {
			marks.push(`<svelte:element this=${UNREAD}>`);
		} else if (tags.includes("button")) {
			marks.push('<svelte:element this="button">');
		}
	}

	for (const attribute of element.attributes) {
		if (attribute.type !== "Attribute" || attribute.name !== "role") continue;
		for (const role of words(attribute.value, bindings)) {
			if (role.includes(OPAQUE)) {
				marks.push(`<${element.name} role=${UNREAD}>`);
			} else if (CONTROL_ROLES.includes(role)) {
				marks.push(`<${element.name} role="${role}">`);
			}
		}
	}

	return marks;
}

/** A control written where a primitive should be: a `<button>`, an element a
 *  `role` turns into a button or a tab, or a `<svelte:element>` that can render
 *  a `<button>`. A `role` or a `this` the scope cannot enumerate counts, since
 *  it can be either. The primitive carries the frame, the sizes and the focus
 *  ring, and a control in scoped CSS passes every other guard while looking
 *  right (docs/design-system.md, Primitives). */
function rawControls(source: string): string[] {
	const ast = parse(source, { modern: true });
	const bindings = scope(ast.module, ast.instance);
	const elements = descendants(ast.fragment, "RegularElement")
		.concat(descendants(ast.fragment, "SvelteElement"))
		.filter(isElement)
		.sort((a, b) => a.start - b.start);

	return elements.flatMap((element) => {
		const line = source.slice(0, element.start).split("\n").length;

		return controlMarks(element, bindings).map(
			(mark) => `${mark} at line ${line}`,
		);
	});
}

const STEP = /^text-(caption|small|callout|body|title|display)$/;
const LEADING = /^leading-/;

/** A `<textarea>` on a text step without a leading of its own. The step pairs
 *  the line height of a one-line label, and a field that wraps reads a
 *  unitless leading instead (docs/design-system.md, Tokens). */
function textareasOnLabelLeading(source: string): string[] {
	const ast = parse(source, { modern: true });
	const bindings = scope(ast.instance, ast.module);
	return descendants(ast.fragment, "RegularElement")
		.filter(isElement)
		.filter((element) => element.name === "textarea")
		.filter(
			(element) =>
				!element.attributes.some(
					(a) => a.type === "StyleDirective" && a.name === "line-height",
				),
		)
		.filter((element) => {
			const classes = element.attributes
				.filter(
					(a): a is AST.Attribute =>
						a.type === "Attribute" && a.name === "class",
				)
				.flatMap((a) => (a.value === true ? [] : words(a.value, bindings)));
			return (
				classes.some((w) => STEP.test(w)) &&
				!classes.some((w) => LEADING.test(w))
			);
		})
		.map(
			(element) =>
				`<textarea> at line ${source.slice(0, element.start).split("\n").length}`,
		);
}

describe("markup classes", () => {
	it("finds a textarea on a text step with no leading", () => {
		expect(
			textareasOnLabelLeading(
				'<textarea class="text-callout"></textarea>\n<textarea class="text-callout leading-normal"></textarea>\n<textarea class="field"></textarea>',
			),
		).toEqual(["<textarea> at line 1"]);
	});

	it.each(components)(
		"%s gives a textarea on a text step a leading of its own (docs/design-system.md, Tokens)",
		(file) => {
			expect(
				textareasOnLabelLeading(readFileSync(join(root, file), "utf8")),
			).toEqual([]);
		},
	);

	it("generates a utility the theme maps", () => {
		expect(
			["flex", "p-2", "text-body", "text-text-muted", "h-control"].map(utility),
		).toEqual([true, true, true, true, true]);
	});

	it("generates nothing for a step the reset removed", () => {
		expect(
			["p-7", "text-sm", "bg-white", "rounded-md", "shadow-xl"].map(utility),
		).toEqual([false, false, false, false, false]);
	});

	it.each(components)(
		"%s names only utilities or classes a stylesheet, script or test vouches for (docs/design-system.md, Tokens)",
		(file) => {
			expect(classOffences(join(root, file))).toEqual([]);
		},
	);

	it.each(components)(
		"%s puts a static value in a stylesheet rule, not a style directive (docs/design-system.md, Guards)",
		(file) => {
			expect(staticStyleDirectives(join(root, file))).toEqual([]);
		},
	);

	it("finds a raw <button> inside a block", () => {
		expect(
			rawControls("<div>\n{#if open}\n<button>Go</button>\n{/if}\n</div>"),
		).toEqual(["<button> at line 3"]);
	});

	it.each([
		['<div role="button">Go</div>', '<div role="button"> at line 1'],
		['<div role="tab">Files</div>', '<div role="tab"> at line 1'],
		[
			"<span role={pressable ? 'button' : undefined}>Go</span>",
			'<span role="button"> at line 1',
		],
		[
			'<script>const role = "button";</script>\n<div {role}>Go</div>',
			'<div role="button"> at line 2',
		],
		[
			'<svelte:element this="a" role="tab">Files</svelte:element>',
			'<svelte:element role="tab"> at line 1',
		],
		[
			'<svelte:element this="button">Go</svelte:element>',
			'<svelte:element this="button"> at line 1',
		],
		[
			"<svelte:element this={href ? 'a' : 'button'}>Go</svelte:element>",
			'<svelte:element this="button"> at line 1',
		],
	])("finds %s, a control drawn outside a primitive", (markup, offence) => {
		expect(rawControls(markup)).toEqual([offence]);
	});

	it.each([
		["<div role={role}>Go</div>", "<div role={…}> at line 1"],
		[
			'<script>const role = $derived(on ? "button" : undefined);</script>\n<div {role}>Go</div>',
			"<div role={…}> at line 2",
		],
		[
			"<svelte:element this={tag}>Go</svelte:element>",
			"<svelte:element this={…}> at line 1",
		],
		[
			'<script>let tag = "button";</script>\n<svelte:element this={tag}>Go</svelte:element>',
			"<svelte:element this={…}> at line 2",
		],
	])("finds %s, which can be a control for all it shows", (markup, offence) => {
		expect(rawControls(markup)).toEqual([offence]);
	});

	it.each([
		'<div role="menu"></div>',
		'<svelte:element this="div"></svelte:element>',
		"<Row role={role} />",
	])("leaves %s, which is no control", (markup) => {
		expect(rawControls(markup)).toEqual([]);
	});

	it("lists the controls in the order the file writes them", () => {
		expect(
			rawControls(
				'<svelte:element this="button"></svelte:element>\n<button>Go</button>',
			),
		).toEqual([
			'<svelte:element this="button"> at line 1',
			"<button> at line 2",
		]);
	});

	it.each(components.filter((file) => !file.startsWith(PRIMITIVES)))(
		"%s draws a control through a primitive from src/lib/ui, not a raw <button>, a role or a <svelte:element> (docs/design-system.md, Primitives)",
		(file) => {
			expect(rawControls(readFileSync(join(root, file), "utf8"))).toEqual([]);
		},
	);
});
