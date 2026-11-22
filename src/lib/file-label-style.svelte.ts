import { listen } from "@tauri-apps/api/event";
import { getContext, onMount, setContext } from "svelte";
import { safeInvoke } from "./invoke.js";
import { showToast } from "./toast.svelte.js";

type FileLabelStyle = "filename-first" | "full-path";

function isFileLabelStyle(value: unknown): value is FileLabelStyle {
	return value === "filename-first" || value === "full-path";
}

interface FileLabels {
	readonly current: FileLabelStyle;
}

export const FILE_LABEL_STYLE = Symbol("file-label-style");
const defaults: FileLabels = { current: "filename-first" };

export function getFileLabelStyle(): FileLabels {
	return getContext<FileLabels | undefined>(FILE_LABEL_STYLE) ?? defaults;
}

/** The native View menu owns the saved choice. All mounted rows share this one subscription. */
export function provideFileLabelStyle(): void {
	let current = $state<FileLabelStyle>(defaults.current);
	setContext<FileLabels>(FILE_LABEL_STYLE, {
		get current() {
			return current;
		},
	});

	onMount(() => {
		let disposed = false;
		let chosen = false;
		const removals: (() => void)[] = [];
		function own(off: () => void) {
			if (disposed) off();
			else removals.push(off);
		}
		function reportLoadError() {
			if (!disposed) showToast("Could not load file label style", "error");
		}
		const changes = listen<unknown>(
			"file-label-style-changed",
			({ payload }) => {
				if (disposed || !isFileLabelStyle(payload)) return;
				chosen = true;
				current = payload;
			},
		);
		void listen("file-label-style-save-failed", () => {
			if (!disposed) showToast("Could not save file label style", "error");
		})
			.then(own)
			.catch(reportLoadError);

		// Subscribe before reading so a menu choice made during startup wins.
		void changes
			.then(own)
			.catch(reportLoadError)
			.then(async () => {
				if (disposed || chosen) return;
				const saved = await safeInvoke<unknown>("get_file_label_style");
				if (!disposed && !chosen && isFileLabelStyle(saved)) current = saved;
			})
			.catch(() => {
				if (!chosen) reportLoadError();
			});

		return () => {
			disposed = true;
			for (const off of removals) off();
		};
	});
}
