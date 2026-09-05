import { describe, expect, it } from "vitest";
import { focusInEditable, keyChord } from "./keyboard.js";

describe("keyChord", () => {
	it.each([
		{ name: "a plain letter", init: { key: "j" }, chord: "j" },
		{ name: "a named key", init: { key: "ArrowDown" }, chord: "ArrowDown" },
		{
			name: "Cmd with a letter",
			init: { key: "j", metaKey: true },
			chord: "Meta+j",
		},
		{
			name: "Ctrl with a letter",
			init: { key: "j", ctrlKey: true },
			chord: "Ctrl+j",
		},
		{
			name: "Alt with a letter",
			init: { key: "k", altKey: true },
			chord: "Alt+k",
		},
		{
			name: "Shift with an uppercased letter",
			init: { key: "W", shiftKey: true },
			chord: "Shift+w",
		},
		{
			name: "Cmd+Shift with a letter",
			init: { key: "W", metaKey: true, shiftKey: true },
			chord: "Meta+Shift+w",
		},
		{
			name: "Ctrl with Tab",
			init: { key: "Tab", ctrlKey: true },
			chord: "Ctrl+Tab",
		},
		{
			name: "Cmd with a symbol",
			init: { key: "=", metaKey: true },
			chord: "Meta+=",
		},
		{
			name: "a shifted symbol as the layout reports it",
			init: { key: "+", metaKey: true, shiftKey: true },
			chord: "Meta+Shift++",
		},
		{
			name: "every modifier in a fixed order",
			init: {
				key: "a",
				shiftKey: true,
				altKey: true,
				ctrlKey: true,
				metaKey: true,
			},
			chord: "Meta+Ctrl+Alt+Shift+a",
		},
		{
			name: "a modifier pressed alone",
			init: { key: "Meta", metaKey: true },
			chord: "Meta",
		},
		{
			name: "Shift pressed alone",
			init: { key: "Shift", shiftKey: true },
			chord: "Shift",
		},
	])("reads $name", ({ init, chord }) => {
		expect(keyChord(new KeyboardEvent("keydown", init))).toBe(chord);
	});
});

describe("focusInEditable", () => {
	it.each([
		{ name: "an input", make: () => document.createElement("input") },
		{ name: "a textarea", make: () => document.createElement("textarea") },
		{ name: "a select", make: () => document.createElement("select") },
		{
			name: "a contenteditable element",
			make: () => {
				const el = document.createElement("div");
				el.setAttribute("contenteditable", "true");
				return el;
			},
		},
	])("is true for $name", ({ make }) => {
		expect(focusInEditable(make())).toBe(true);
	});

	it.each([
		{ name: "a button", make: () => document.createElement("button") },
		{ name: "a listbox div", make: () => document.createElement("div") },
		{ name: "the body", make: () => document.body },
		{ name: "nothing focused", make: () => null },
	])("is false for $name", ({ make }) => {
		expect(focusInEditable(make())).toBe(false);
	});
});
