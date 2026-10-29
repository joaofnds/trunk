import { afterEach, describe, expect, it } from "vitest";
import {
	AmbiguousControl,
	click,
	findByRole,
	isEnabled,
	namesOf,
	pressKey,
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
		document.body.innerHTML =
			'<div role="option">new two</div><div role="tab">Commit</div>';

		expect(findByRole("option", "new two")).not.toBeNull();
		expect(findByRole("button", "Commit")).toBeNull();
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
			["the hidden attribute", "<div hidden><button>Commit</button></div>"],
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
	});
});

describe("namesOf", () => {
	it("lists the name of every shown element with the role, in page order", () => {
		document.body.innerHTML =
			'<div role="option">new two</div><div role="option" hidden>gone</div><div role="option">base one</div>';

		expect(namesOf("option")).toEqual(["new two", "base one"]);
	});
});

describe("click", () => {
	it("sends the events a pointer click sends, in order", () => {
		document.body.innerHTML = "<button>Commit</button>";
		const button = document.querySelector("button") as HTMLButtonElement;
		const seen: string[] = [];
		for (const type of [
			"pointerdown",
			"mousedown",
			"focus",
			"pointerup",
			"mouseup",
			"click",
		]) {
			button.addEventListener(type, () => seen.push(type));
		}

		click(button);

		expect(seen).toEqual([
			"pointerdown",
			"mousedown",
			"focus",
			"pointerup",
			"mouseup",
			"click",
		]);
	});
});

describe("isEnabled", () => {
	it.each([
		["an enabled button", "<button>Go</button>", true],
		["a disabled button", "<button disabled>Go</button>", false],
		[
			"one aria-disabled",
			'<div role="button" aria-disabled="true">Go</div>',
			false,
		],
		[
			"one inside a disabled fieldset",
			"<fieldset disabled><button>Go</button></fieldset>",
			false,
		],
	])("reads %s", (_what, markup, enabled) => {
		document.body.innerHTML = markup;

		expect(isEnabled(findByRole("button", "Go") as HTMLElement)).toBe(enabled);
	});
});

describe("typeInto", () => {
	it("appends the text and tells the field's listeners it changed", () => {
		document.body.innerHTML = '<input type="text" value="fix: ">';
		const field = document.querySelector("input") as HTMLInputElement;
		let heard = "";
		field.addEventListener("input", () => {
			heard = field.value;
		});

		typeInto(field, "keep the drive window back");

		expect(heard).toBe("fix: keep the drive window back");
		expect(document.activeElement).toBe(field);
	});
});

describe("pressKey", () => {
	it("sends keydown then keyup with the modifiers to the focused element", () => {
		document.body.innerHTML = "<textarea></textarea>";
		const field = document.querySelector("textarea") as HTMLTextAreaElement;
		field.focus();
		const seen: string[] = [];
		const record = (event: KeyboardEvent) =>
			seen.push(
				`${event.type} ${event.key} meta=${event.metaKey} shift=${event.shiftKey}`,
			);
		field.addEventListener("keydown", record);
		field.addEventListener("keyup", record);

		pressKey("Meta+Enter");

		expect(seen).toEqual([
			"keydown Enter meta=true shift=false",
			"keyup Enter meta=true shift=false",
		]);
	});

	it("names a modifier the platform does not have", () => {
		expect(() => pressKey("Hyper+K")).toThrow('"Hyper" is not a modifier');
	});
});
