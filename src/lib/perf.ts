/**
 * Standing performance instrumentation. Off unless something calls
 * `enablePerf`, so a release build and the test suite carry a boolean check per
 * measurement and nothing else.
 *
 * Samples are buffered in memory and written out in batches, because the point
 * is to measure the app rather than the act of measuring it. Nothing here
 * aggregates: the raw durations go to disk and `scripts/perf-report.ts` turns
 * them into distributions, so a better statistic never needs a new run.
 */

export type SampleKind = "span" | "frame-gap";

export interface PerfSample {
	name: string;
	ms: number;
	kind: SampleKind;
	/** Wall clock at the end of the measurement, for correlating with a session. */
	at: number;
}

export interface PerfSink {
	write(lines: string[]): Promise<void>;
}

export interface PerfOptions {
	sink: PerfSink;
	/** Injected so a test states a duration instead of measuring the machine. */
	now?: () => number;
	/** Buffered samples that force a write before the interval comes round. */
	batchSize?: number;
	/** Sample frame gaps off requestAnimationFrame. Off in tests, which call
	 *  `recordFrameGap` directly so a gap is a stated number. */
	frames?: boolean;
}

const DEFAULT_BATCH = 256;

let sink: PerfSink | null = null;
let clock: () => number = () => performance.now();
let batchSize = DEFAULT_BATCH;
let buffer: PerfSample[] = [];
let openSpans: string[] = [];
let frameTimer: number | null = null;

export function perfEnabled(): boolean {
	return sink !== null;
}

export function enablePerf(options: PerfOptions): void {
	sink = options.sink;
	clock = options.now ?? (() => performance.now());
	batchSize = options.batchSize ?? DEFAULT_BATCH;
	buffer = [];
	openSpans = [];

	if (options.frames ?? true) startFrameSampler();
}

export function disablePerf(): void {
	stopFrameSampler();
	sink = null;
	buffer = [];
	openSpans = [];
}

export function record(name: string, ms: number): void {
	push({ name, ms, kind: "span", at: Date.now() });
}

/** A frame gap belongs to whatever the app was doing when it stalled, so it is
 *  filed under the innermost open span. Spans that overlap across an await
 *  attribute to the most recently opened one, which is a naming approximation,
 *  never a timing one. */
export function recordFrameGap(ms: number): void {
	push({
		name: openSpans[openSpans.length - 1] ?? "idle",
		ms,
		kind: "frame-gap",
		at: Date.now(),
	});
}

/** The synchronous half of `span`, for a computation that has to return its
 *  value directly — a derived value, a render pass. */
export function measure<T>(name: string, fn: () => T): T {
	if (sink === null) return fn();

	const started = clock();
	openSpans.push(name);
	try {
		return fn();
	} finally {
		openSpans.pop();
		record(name, clock() - started);
	}
}

export async function span<T>(
	name: string,
	fn: () => T | Promise<T>,
): Promise<T> {
	if (sink === null) return await fn();

	const started = clock();
	openSpans.push(name);
	try {
		return await fn();
	} finally {
		openSpans.pop();
		record(name, clock() - started);
	}
}

export async function flushPerf(): Promise<void> {
	const target = sink;
	if (target === null || buffer.length === 0) return;

	const batch = buffer;
	buffer = [];

	await target.write(batch.map((sample) => JSON.stringify(sample)));
}

function push(sample: PerfSample): void {
	if (sink === null) return;

	buffer.push(sample);
	if (buffer.length >= batchSize) void flushPerf();
}

function startFrameSampler(): void {
	if (typeof requestAnimationFrame !== "function") return;

	let last = performance.now();
	const tick = (t: number) => {
		recordFrameGap(t - last);
		last = t;
		if (sink !== null) frameTimer = requestAnimationFrame(tick);
	};

	frameTimer = requestAnimationFrame(tick);
}

function stopFrameSampler(): void {
	if (frameTimer !== null && typeof cancelAnimationFrame === "function") {
		cancelAnimationFrame(frameTimer);
	}
	frameTimer = null;
}
