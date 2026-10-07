// A field that opens in place of the text it edits takes the focus with that
// text selected, so typing replaces it and Escape and blur reach the field.
export function selectOnOpen(node: HTMLInputElement) {
	node.focus();
	node.select();
}
