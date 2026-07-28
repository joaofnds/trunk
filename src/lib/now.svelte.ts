import { createSubscriber } from "svelte/reactivity";

const MS_PER_MINUTE = 60_000;
const EARLY_FIRE_MARGIN_MS = 20;

function clockMinute(): number {
	return Math.floor(Date.now() / MS_PER_MINUTE);
}

let minute = $state(clockMinute());
let timer: ReturnType<typeof setTimeout> | undefined;

const subscribe = createSubscriber(() => {
	minute = clockMinute();
	scheduleNextTick();
	return () => {
		clearTimeout(timer);
		timer = undefined;
	};
});

function scheduleNextTick(): void {
	const delay =
		MS_PER_MINUTE - (Date.now() % MS_PER_MINUTE) + EARLY_FIRE_MARGIN_MS;
	timer = setTimeout(() => {
		minute = clockMinute();
		scheduleNextTick();
	}, delay);
}

/** Reactive only when read from markup or a `$derived` — elsewhere it silently
 *  returns a frozen value. */
export function currentMinute(): number {
	subscribe();
	return minute;
}
