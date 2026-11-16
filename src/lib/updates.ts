import { safeInvoke } from "./invoke.js";

export interface UpdateStatus {
	readonly phase:
		| "manual"
		| "idle"
		| "checking"
		| "available"
		| "downloading"
		| "ready"
		| "preparing"
		| "installing"
		| "recovery";
	readonly current_version: string;
	readonly version: string | null;
	readonly notes: string | null;
	readonly message: string | null;
	readonly downloaded: number;
	readonly total: number | null;
	readonly eligible: boolean;
	readonly adopted: boolean;
}

export function releaseUrl(version: string | null): string {
	return version
		? `https://github.com/joaofnds/trunk/releases/tag/v${encodeURIComponent(version)}`
		: "https://github.com/joaofnds/trunk/releases/latest";
}

export const updates = {
	status: () => safeInvoke<UpdateStatus>("updates_status"),
	ready: () => safeInvoke<UpdateStatus>("updates_ready"),
	resume: () => safeInvoke<void>("updates_resume"),
	enable: (enabled: boolean) =>
		safeInvoke<UpdateStatus>("updates_enable", { enabled }),
	check: () => safeInvoke<UpdateStatus>("updates_check"),
	download: (version: string) =>
		safeInvoke<UpdateStatus>("updates_download", { version }),
	cancel: () => safeInvoke<UpdateStatus>("updates_cancel"),
	prepare: (version: string) =>
		safeInvoke<string>("updates_prepare", { version }),
	abort: (token: string) =>
		safeInvoke<UpdateStatus>("updates_abort", { token }),
	install: (version: string, token: string) =>
		safeInvoke<void>("updates_install", { version, token }),
};
