import { invoke } from "@tauri-apps/api/core";
import { enablePerf, flushPerf, type PerfSink } from "./perf.js";

const FLUSH_INTERVAL_MS = 2000;

// Deliberately the raw invoke rather than safeInvoke: safeInvoke is itself
// instrumented, so flushing through it would record a sample per flush and
// feed the buffer it is draining.
const tauriSink: PerfSink = {
	async write(lines) {
		await invoke("perf_append", { lines });
	},
};

/** Turns instrumentation on for a `VITE_PERF=1` dev session and answers where
 *  the samples land, so the path is never something to go looking for. Any
 *  other build leaves it off and pays one boolean per measurement. */
export async function startPerfSession(): Promise<string | null> {
	if (import.meta.env.VITE_PERF !== "1") return null;

	const path = await invoke<string>("perf_reset");
	enablePerf({ sink: tauriSink });

	setInterval(() => void flushPerf(), FLUSH_INTERVAL_MS);
	window.addEventListener("beforeunload", () => void flushPerf());

	return path;
}
