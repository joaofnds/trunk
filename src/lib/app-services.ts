import { startPerfSession } from "./perf-session.js";
import { trackScrollActivity } from "./scrollbar-activity.js";

export function startAppServices(): () => void {
	const untrackScroll = trackScrollActivity();

	startPerfSession().then((path) => {
		if (path) console.info(`perf samples: ${path}`);
	});

	return untrackScroll;
}
