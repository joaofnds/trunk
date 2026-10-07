import type { Review } from "./types.js";

// Reviews opened before 2026-10-07 were titled `Review <date> · <id>`. Every
// place a title is drawn prints the id beside it, so the id is dropped from
// that one shape when it is the review's own. A title the reader wrote stays
// as written.
export function reviewTitle(review: Pick<Review, "id" | "title">): string {
	const suffix = ` · ${review.id}`;
	if (!review.title.endsWith(suffix)) return review.title;
	const head = review.title.slice(0, -suffix.length);
	return /^Review \d{4}-\d{2}-\d{2}$/.test(head) ? head : review.title;
}

export interface TitleRun {
	text: string;
	// WebKit breaks a line after a date's hyphen, which leaves `2026-09-` on one
	// line and `08` on the next. A whole run is drawn where no line may break.
	whole: boolean;
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;

export function titleRuns(title: string): TitleRun[] {
	const runs: TitleRun[] = [];
	let from = 0;
	for (const match of title.matchAll(ISO_DATE)) {
		if (match.index > from) {
			runs.push({ text: title.slice(from, match.index), whole: false });
		}
		runs.push({ text: match[0], whole: true });
		from = match.index + match[0].length;
	}
	if (from < title.length) runs.push({ text: title.slice(from), whole: false });
	return runs;
}
