import { FakeClipboard } from "../../../tests/app/fakes/clipboard.js";
import { FakeDialog } from "../../../tests/app/fakes/dialog.js";
import { FakeMenu } from "../../../tests/app/fakes/menu.js";
import { FakeOpener } from "../../../tests/app/fakes/opener.js";
import { FakePath } from "../../../tests/app/fakes/path.js";
import { FakeWebview } from "../../../tests/app/fakes/webview.js";
import { FakeWindow } from "../../../tests/app/fakes/window.js";
import type { EventHandler } from "../../../tests/app/harness/host-client.js";
import {
	type HostChannel,
	TauriInternals,
} from "../../../tests/app/harness/internals.js";
import type { RepoChanged } from "../../lib/repo-change-subscription.js";
import type { GraphResponse } from "../../lib/types.js";

interface HeldReply {
	entered: Promise<Record<string, unknown>>;
	release(value: unknown): void;
	reject(error: { code: string; message: string }): void;
}

export class RepositoryReadHost implements HostChannel {
	readonly preferences = new Map<string, unknown>();
	readonly requests: Array<{ cmd: string; args: Record<string, unknown> }> = [];
	private readonly responses = new Map<string, unknown>();
	private graph: GraphResponse | undefined;
	private readonly barriers = new Map<
		string,
		Array<(args: Record<string, unknown>) => Promise<unknown>>
	>();
	private readonly eventHandlers: EventHandler[] = [];
	private readonly registrations = new Map<string, number[]>();
	private nextListener = 1;
	private readonly transport = new TauriInternals(this);
	readonly contextMenu = new FakeMenu(this.transport);

	install(): void {
		this.transport.route([
			new FakeWindow(),
			new FakeWebview(),
			new FakePath("/test"),
			this.contextMenu,
			new FakeDialog(),
			new FakeClipboard(),
			new FakeOpener(),
		]);
		this.transport.install();
	}

	dispose(): void {
		this.transport.uninstall();
	}

	reset(): void {
		this.preferences.clear();
		this.responses.clear();
		this.graph = undefined;
		this.barriers.clear();
		this.registrations.clear();
		this.requests.length = 0;
	}

	holdCommand(command: string): () => void {
		return this.transport.holdCommand(command);
	}

	seedGraph(response: GraphResponse): void {
		this.graph = response;
	}

	seedResponse(command: string, response: unknown): void {
		this.responses.set(command, response);
	}

	holdNextReply(command: string): HeldReply {
		let entered!: (args: Record<string, unknown>) => void;
		let release!: (value: unknown) => void;
		let reject!: (error: string) => void;
		const observed = new Promise<Record<string, unknown>>((resolve) => {
			entered = resolve;
		});
		const answer = new Promise<unknown>((resolve, fail) => {
			release = resolve;
			reject = fail;
		});
		const queued = this.barriers.get(command) ?? [];
		queued.push((args) => {
			entered(args);
			return answer;
		});
		this.barriers.set(command, queued);

		return {
			entered: observed,
			release,
			reject: (error) => reject(JSON.stringify(error)),
		};
	}

	async emitRepoChanged(payload: RepoChanged): Promise<void> {
		await this.emit("repo-changed", payload);
	}

	async emit(event: string, payload: unknown): Promise<void> {
		await this.transport.registrationsSettled();
		for (const handler of this.eventHandlers) handler(event, payload);
	}

	count(command: string): number {
		return this.requests.filter(({ cmd }) => cmd === command).length;
	}

	listenerIds(event: string): readonly number[] {
		return this.registrations.get(event) ?? [];
	}

	onEvent(handler: EventHandler): void {
		this.eventHandlers.push(handler);
	}

	async invoke<T>(
		cmd: string,
		args: unknown = {},
		onReply?: (value: T) => void,
	): Promise<T> {
		const input = args as Record<string, unknown>;
		this.requests.push({ cmd, args: input });
		const answer = await this.answer(cmd, input);
		if (cmd === "plugin:event|listen" && typeof answer === "number") {
			const event = String(input.event);
			const ids = this.registrations.get(event) ?? [];
			ids.push(answer);
			this.registrations.set(event, ids);
		}
		onReply?.(answer as T);

		return answer as T;
	}

	private async answer(
		cmd: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		const barrier = this.barriers.get(cmd)?.shift();
		if (barrier) return barrier(args);
		if (cmd === "get_commit_graph" && this.graph) {
			const offset = Number(args.offset ?? 0);
			const count = Number(args.loaded ?? 200);
			return {
				...this.graph,
				commits: this.graph.commits.slice(offset, offset + count),
			};
		}
		if (cmd === "get_commit_stats" && this.graph && this.responses.has(cmd)) {
			const stats = this.responses.get(cmd) as Record<string, unknown>;
			const offset = Number(args.offset ?? 0);
			const count = Math.min(200, Number(args.count ?? 200));
			return Object.fromEntries(
				this.graph.commits
					.slice(offset, offset + count)
					.filter(({ oid }) => oid in stats)
					.map(({ oid }) => [oid, stats[oid]]),
			);
		}
		if (this.responses.has(cmd)) return this.responses.get(cmd);

		switch (cmd) {
			case "plugin:event|listen":
				return this.nextListener++;
			case "plugin:event|unlisten":
				return null;
			case "prefs_get":
				return this.preferences.get(String(args.key)) ?? null;
			case "prefs_set":
				this.preferences.set(String(args.key), args.value);
				return null;
			case "canonical_repo_path":
				return args.path;
			case "get_commit_graph":
				return { commits: [], max_columns: 0, revision: 1 };
			case "get_commit_stats":
				return {};
			case "get_wip_diff_stats":
				return { files_changed: 0, insertions: 0, deletions: 0 };
			case "list_refs":
				return { local: [], remote: [], tags: [], stashes: [] };
			case "list_stashes":
			case "list_reviews":
			case "list_threads":
			case "list_session_commits":
				return [];
			case "get_active_review":
				return null;
			case "get_review_snapshots":
				return { working_tree_snapshot: null, index_snapshot: null };
			case "get_status":
				return { unstaged: [], staged: [], conflicted: [] };
			case "get_dirty_counts":
				return { staged: 0, unstaged: 0, conflicted: 0 };
			case "get_operation_state":
				return {
					op_type: "None",
					source_branch: null,
					target_branch: null,
					onto_oid: null,
					progress: null,
					rebase_message: null,
				};
			default:
				return null;
		}
	}
}
