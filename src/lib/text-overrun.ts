/**
 * How far an element's laid-out content runs past the box that shows it, in px:
 * positive when the box cuts it. A Range measures the content as laid out, so a
 * margin that slides the text, as the Message pan's does, leaves the answer alone.
 * The box is the element's clientWidth, so the element carries no padding.
 */
export function textOverrun(el: HTMLElement): number {
	const laidOut = document.createRange();
	laidOut.selectNodeContents(el);
	return laidOut.getBoundingClientRect().width - el.clientWidth;
}
