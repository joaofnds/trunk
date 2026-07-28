const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_MONTH = 43200;
const MINUTES_PER_YEAR = 525600;

/** Widest labels the ladder emits; a column sized from anything narrower clips.
 *  `12mo ago` outranks `1y ago` because the month divisor is 30 days while the
 *  year threshold is 365, so commits 360-365 days old land in the month bucket. */
export const WIDEST_LABELS = ["just now", "12mo ago"] as const;

export function relativeLabel(tsSeconds: number, nowMinute: number): string {
	if (tsSeconds === 0) return "";
	const minutesAgo = nowMinute - Math.floor(tsSeconds / SECONDS_PER_MINUTE);
	if (minutesAgo <= 0) return "just now";
	if (minutesAgo < MINUTES_PER_HOUR) return `${minutesAgo}m ago`;
	if (minutesAgo < MINUTES_PER_DAY)
		return `${Math.floor(minutesAgo / MINUTES_PER_HOUR)}h ago`;
	if (minutesAgo < MINUTES_PER_MONTH)
		return `${Math.floor(minutesAgo / MINUTES_PER_DAY)}d ago`;
	if (minutesAgo < MINUTES_PER_YEAR)
		return `${Math.floor(minutesAgo / MINUTES_PER_MONTH)}mo ago`;
	return `${Math.floor(minutesAgo / MINUTES_PER_YEAR)}y ago`;
}
