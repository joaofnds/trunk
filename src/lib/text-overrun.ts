/**
 * How far an element's laid-out content runs past the box that shows it, in px:
 * positive when the box cuts it. A Range measures the content as laid out, so a
 * margin that slides the text, as the Message pan's does, leaves the answer alone.
 * Not a canvas measure: that needs the font as a string, and WebKit serializes a
 * computed `font` as "".
 * The box is the element's own rect, so the element carries no padding or border.
 * Not clientWidth: that rounds to a whole pixel, and a flex column is often a
 * fraction wide, so text that fits with no ellipsis would count as cut.
 */
export function textOverrun(el: HTMLElement): number {
	const laidOut = document.createRange();
	laidOut.selectNodeContents(el);
	return (
		laidOut.getBoundingClientRect().width - el.getBoundingClientRect().width
	);
}
