import { startPerfSession } from "./perf-session.js";
import { trackScrollActivity } from "./scrollbar-activity.js";

export function startAppServices(): () => void {
	const untrackScroll = trackScrollActivity();

	void startPerfSession();

	return untrackScroll;
}
