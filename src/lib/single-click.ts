/**
 * Runs `act` for a click of its own and never for the later clicks of a double
 * click. A staging action takes its row or hunk out of the list, so whatever is
 * next moves up under the pointer before the second click arrives, and that
 * click would act on it. A key press, whose detail is 0, always acts.
 */
export function singleClick(e: MouseEvent, act: () => void): void {
	if (e.detail <= 1) act();
}
