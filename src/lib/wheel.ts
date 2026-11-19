/**
 * Whether a wheel event moves more sideways than up or down. WebKit hands the
 * page a trackpad's sideways drift as it scrolls down, so an event that moves
 * both ways belongs to the axis it moves most along.
 */
export function isSideways(event: WheelEvent): boolean {
	return Math.abs(event.deltaX) > Math.abs(event.deltaY);
}
