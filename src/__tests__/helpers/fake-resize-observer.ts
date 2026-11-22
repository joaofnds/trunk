import { vi } from "vitest";

/**
 * Installs a ResizeObserver that reports the elements `reported` picks at a
 * width the test sets, and nothing else, so every other observer behaves like
 * the do-nothing stub in `vitest-setup.ts`. Like the browser's, it reports an
 * element a microtask after it starts observing it. `vi.unstubAllGlobals()`
 * removes it.
 */
export function reportWidthOf(
	reported: (target: Element) => boolean,
	width: number,
): { resize(width: number, height?: number): void } {
	const observations: Observation[] = [];

	vi.stubGlobal(
		"ResizeObserver",
		class ReportingResizeObserver implements ResizeObserver {
			readonly #callback: ResizeObserverCallback;

			constructor(callback: ResizeObserverCallback) {
				this.#callback = callback;
			}

			observe(target: Element): void {
				if (!reported(target)) return;

				const observation = {
					observer: this,
					callback: this.#callback,
					target,
				};
				observations.push(observation);
				queueMicrotask(() => report(observation, width));
			}

			unobserve(target: Element): void {
				remove((observation) => observation.target === target);
			}

			disconnect(): void {
				remove((observation) => observation.observer === this);
			}
		},
	);

	function remove(matches: (observation: Observation) => boolean) {
		const kept = observations.filter((observation) => !matches(observation));
		observations.splice(0, observations.length, ...kept);
	}

	return {
		resize(next: number, height = 0) {
			for (const observation of observations) report(observation, next, height);
		},
	};
}

interface Observation {
	readonly observer: ResizeObserver;
	readonly callback: ResizeObserverCallback;
	readonly target: Element;
}

function report(observation: Observation, width: number, height = 0) {
	const box: ResizeObserverSize = { inlineSize: width, blockSize: height };
	const contentRect: DOMRectReadOnly = {
		x: 0,
		y: 0,
		width,
		height,
		top: 0,
		left: 0,
		right: width,
		bottom: height,
		toJSON: () => ({}),
	};
	const entry: ResizeObserverEntry = {
		target: observation.target,
		contentRect,
		borderBoxSize: [box],
		contentBoxSize: [box],
		devicePixelContentBoxSize: [box],
	};

	observation.callback([entry], observation.observer);
}
