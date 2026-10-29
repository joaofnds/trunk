import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AmbiguousControl,
	click,
	control,
	findByRole,
	isEnabled,
	namesOf,
	pressKey,
	rightClick,
	typeInto,
} from "./drive-gestures.js";

afterEach(() => {
	document.body.innerHTML = "";
});

describe("findByRole", () => {
	it("finds a button by the text it shows", () => {
		document.body.innerHTML =
			"<button>Cancel</button><button> Commit </button>";

		const found = findByRole("button", "Commit");

		expect(found?.textContent).toBe(" Commit ");
	});

	it("finds a text field by its placeholder", () => {
		document.body.innerHTML =
			'<input type="text" placeholder="Summary (required)"><textarea placeholder="Description (optional)"></textarea>';

		const found = findByRole("textbox", "Description (optional)");

		expect(found?.tagName).toBe("TEXTAREA");
	});

	it("names a control by its aria-label over its content", () => {
		document.body.innerHTML =
			'<button aria-label="Stage all changes">+</button>';

		expect(findByRole("button", "Stage all changes")).not.toBeNull();
		expect(findByRole("button", "+")).toBeNull();
	});

	it("names a field by the label that points at it", () => {
		document.body.innerHTML =
			'<label for="branch">Branch name</label><input id="branch">';

		expect(findByRole("textbox", "Branch name")?.id).toBe("branch");
	});

	it("reads an explicit role over the element's own", () => {
		document.body.innerHTML = '<button role="tab">Commit</button>';

		expect(findByRole("tab", "Commit")).not.toBeNull();
		expect(findByRole("button", "Commit")).toBeNull();
	});

	it("leaves text a screen reader skips out of the name", () => {
		document.body.innerHTML =
			'<div role="option">new two <span aria-hidden="true">QF</span> 669d4d8</div>';

		expect(findByRole("option", "new two 669d4d8")).not.toBeNull();
	});

	it("collapses runs of whitespace in a name", () => {
		document.body.innerHTML = "<button>Fast-forward\n\t <b>old</b></button>";

		expect(findByRole("button", "Fast-forward old")).not.toBeNull();
	});

	it("returns null while no control matches, so a caller can wait", () => {
		document.body.innerHTML = "<button>Commit</button>";

		expect(findByRole("button", "Push")).toBeNull();
	});

	describe("when a control is hidden", () => {
		it.each([
			[
				"the hidden attribute under a display rule",
				'<div hidden style="display: block"><button>Commit</button></div>',
			],
			["aria-hidden", '<div aria-hidden="true"><button>Commit</button></div>'],
			[
				"display none",
				'<div style="display: none"><button>Commit</button></div>',
			],
			[
				"visibility hidden",
				'<button style="visibility: hidden">Commit</button>',
			],
		])("skips one hidden by %s", (_how, markup) => {
			document.body.innerHTML = markup;

			expect(findByRole("button", "Commit")).toBeNull();
		});
	});

	describe("when two controls match", () => {
		it("refuses to pick one", () => {
			document.body.innerHTML = "<button>OK</button><button>OK</button>";

			expect(() => findByRole("button", "OK")).toThrow(AmbiguousControl);
		});

		it("picks the one inside the landmark it is scoped to", () => {
			document.body.innerHTML =
				'<aside><button id="row">feature</button></aside><div role="listbox"><button>feature</button></div>';

			expect(findByRole("button", "feature", "complementary")?.id).toBe("row");
		});

		it("refuses a scope whose landmark shows more than once", () => {
			document.body.innerHTML =
				"<nav><button>feature</button></nav><nav><button>main</button></nav>";

			expect(() => findByRole("button", "feature", "navigation")).toThrow(
				new AmbiguousControl("2 shown navigations to look within"),
			);
		});

		it("finds nothing inside a landmark that is not showing", () => {
			document.body.innerHTML = "<button>feature</button>";

			expect(findByRole("button", "feature", "complementary")).toBeNull();
		});
	});

	it.each([
		["ASIDE", "complementary", "<aside>Branches</aside>"],
		["NAV", "navigation", "<nav>Branches</nav>"],
		["MAIN", "main", "<main>Branches</main>"],
		["DIALOG", "dialog", "<dialog open>Branches</dialog>"],
	])("reads an %s as the %s role", (tag, role, markup) => {
		document.body.innerHTML = markup;

		expect(findByRole(role, "Branches")?.tagName).toBe(tag);
	});
});

describe("namesOf", () => {
	it("lists the name of every shown element with the role, in page order", () => {
		document.body.innerHTML =
			'<div role="option">new two</div><div role="option" hidden>gone</div><div role="option">base one</div>';

		expect(namesOf("option")).toEqual(["new two", "base one"]);
	});
});

describe("rightClick", () => {
	it("sends the events a secondary click sends, in order, up to the document", () => {
		document.body.innerHTML = "<button>main</button>";
		const row = findByRole("button", "main") as HTMLElement;
		const seen: string[] = [];
		for (const type of [
			"pointerdown",
			"mousedown",
			"contextmenu",
			"pointerup",
			"mouseup",
		]) {
			document.addEventListener(
				type,
				(event) => seen.push(`${type} ${(event as MouseEvent).button}`),
				{ once: true },
			);
		}

		rightClick(row);

		expect(seen).toEqual([
			"pointerdown 2",
			"mousedown 2",
			"contextmenu 2",
			"pointerup 2",
			"mouseup 2",
		]);
	});

	it("lets the app replace the browser's own menu", () => {
		document.body.innerHTML = "<button>main</button>";
		const row = findByRole("button", "main") as HTMLElement;
		let replaced = false;
		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			replaced = event.defaultPrevented;
		});

		rightClick(row);

		expect(replaced).toBe(true);
	});
});

describe("click", () => {
	it("sends the events a pointer click sends, in order, up to the document", () => {
		document.body.innerHTML = "<button>Commit</button>";
		const button = findByRole("button", "Commit") as HTMLElement;
		const seen: string[] = [];
		for (const type of [
			"pointerdown",
			"mousedown",
			"pointerup",
			"mouseup",
			"click",
		]) {
			document.addEventListener(type, () => seen.push(type), { once: true });
		}

		click(button);

		expect(seen).toEqual([
			"pointerdown",
			"mousedown",
			"pointerup",
			"mouseup",
			"click",
		]);
	});

	it("focuses the control, as a pointer press does", () => {
		document.body.innerHTML = "<button>Commit</button>";
		const button = findByRole("button", "Commit") as HTMLElement;

		click(button);

		expect(document.activeElement).toBe(button);
	});
});

describe("isEnabled", () => {
	it.each([
		["an enabled button", "<button>Go</button>", true],
		["a disabled button", "<button disabled>Go</button>", false],
		[
			"a button marked aria-disabled",
			'<div role="button" aria-disabled="true">Go</div>',
			false,
		],
		[
			"a button inside a disabled fieldset",
			"<fieldset disabled><button>Go</button></fieldset>",
			false,
		],
	])("reports %s as %s", (_what, markup, enabled) => {
		document.body.innerHTML = markup;
		const button = document.body.querySelector("button, [role=button]");
		if (!(button instanceof HTMLElement)) throw new Error("no button");

		expect(isEnabled(button)).toBe(enabled);
	});
});

describe("control", () => {
	it("resolves once the control it waits for is enabled", async () => {
		document.body.innerHTML = "<button disabled>Commit</button>";
		let settled = false;
		const waiting = control("button", "Commit", 1_000).then((found) => {
			settled = true;
			return found;
		});
		await Promise.resolve();
		const stillWaiting = !settled;

		document.querySelector("button")?.removeAttribute("disabled");

		expect(stillWaiting).toBe(true);
		expect(await waiting).toBe(document.querySelector("button"));
	});

	describe("when the control never shows", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("rejects naming the control it waited for", async () => {
			vi.useFakeTimers();
			const waiting = control("button", "Push", 1_000);

			vi.advanceTimersByTime(1_000);

			await expect(waiting).rejects.toThrow(
				'waited 1000ms for an enabled button named "Push"',
			);
		});
	});
});

describe("typeInto", () => {
	it("appends the text and tells listeners up to the document it changed", () => {
		document.body.innerHTML = '<input type="text" value="fix: ">';
		const field = document.querySelector("input") as HTMLInputElement;
		let heard = "";
		document.addEventListener("input", () => {
			heard = field.value;
		});

		typeInto(field, "keep the drive window back");

		expect(heard).toBe("fix: keep the drive window back");
	});

	it("types into a text area too", () => {
		document.body.innerHTML = "<textarea>body</textarea>";
		const area = document.querySelector("textarea") as HTMLTextAreaElement;

		typeInto(area, " more");

		expect(area.value).toBe("body more");
	});
});

describe("pressKey", () => {
	it("sends keydown then keyup from the focused element up to the window", () => {
		document.body.innerHTML = "<textarea></textarea>";
		document.querySelector("textarea")?.focus();
		const seen: string[] = [];
		const record = (event: KeyboardEvent) =>
			seen.push(
				`${event.type} ${event.key} in ${(event.target as Element).tagName}`,
			);
		window.addEventListener("keydown", record);
		window.addEventListener("keyup", record);

		pressKey("Escape");

		window.removeEventListener("keydown", record);
		window.removeEventListener("keyup", record);
		expect(seen).toEqual([
			"keydown Escape in TEXTAREA",
			"keyup Escape in TEXTAREA",
		]);
	});

	it.each([
		["Meta", "metaKey"],
		["Cmd", "metaKey"],
		["Control", "ctrlKey"],
		["Ctrl", "ctrlKey"],
		["Alt", "altKey"],
		["Option", "altKey"],
		["Shift", "shiftKey"],
	] as const)("holds %s down as %s", (modifier, flag) => {
		let held: KeyboardEvent | undefined;
		document.addEventListener(
			"keydown",
			(event) => {
				held = event;
			},
			{ once: true },
		);

		pressKey(`${modifier}+Enter`);

		const flags = ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const;
		expect(flags.filter((f) => held?.[f])).toEqual([flag]);
		expect(held?.key).toBe("Enter");
	});

	it.each([
		["+", "+ meta=false"],
		["Meta++", "+ meta=true"],
	])("presses the plus key itself for %s", (combo, expected) => {
		let pressed = "";
		document.addEventListener(
			"keydown",
			(event) => {
				pressed = `${event.key} meta=${event.metaKey}`;
			},
			{ once: true },
		);

		pressKey(combo);

		expect(pressed).toBe(expected);
	});

	it("names a modifier the platform does not have", () => {
		expect(() => pressKey("Hyper+K")).toThrow('"Hyper" is not a modifier');
	});
});
