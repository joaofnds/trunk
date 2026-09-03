import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiffViewer from "./DiffViewer.svelte";

// The rendered view fetches its rows through the shared IPC helper; keep the
// real error guard and answer with an empty diff.
const safeInvoke = vi.fn();
vi.mock("../../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/invoke.js")>()),
	safeInvoke: (cmd: string, args: Record<string, unknown>) =>
		safeInvoke(cmd, args),
}));

const noop = () => {};

const baseProps = {
	contentMode: "hunk" as const,
	contextLines: 3,
	layoutMode: "inline" as const,
	renderMode: "source" as const,
	fileDiffs: [],
	commitDetail: null,
	selectedPath: "README.md",
	diffKind: "unstaged" as const,
	loading: false,
	hunkOperationInFlight: false,
	ignoreWhitespace: false,
	showInvisibles: false,
	wordWrap: false,
	selectedHunkKey: null,
	selectedLineIndices: new Set<number>(),
	selectedCount: 0,
	isMerge: false,
	collapsedFiles: new Set<string>(),
	hunkElements: {},
	onfilecollapsetoggle: noop,
	onlineclick: noop,
	onlinemousedown: noop,
	onlineenter: noop,
	onstagehunk: noop,
	onunstagehunk: noop,
	ondiscardhunk: noop,
	onstagelines: noop,
	onunstagelines: noop,
	ondiscardlines: noop,
	oncommentlines: noop,
	oncommenthunk: noop,
	commitOid: "",
	repoPath: "/repo",
	oncommentfullfile: noop,
};

afterEach(() => safeInvoke.mockReset());

// Every view the viewer mounts owns its own scroller. The viewer's wrapper must
// therefore never be a scroll container itself: `hidden` still lets
// scrollIntoView and scroll chaining move it, and WebKit hands it a phantom
// scroll range the size of the rendered pane's content, so a reader who
// reaches the end of the rendered markdown pane then drags the whole pane up
// out of the window behind a second scrollbar (TRUNK-127). `clip` is the one
// value with nothing to scroll.
describe("DiffViewer's wrapper", () => {
	it("is clipped, never a scroll container, around the rendered markdown view", () => {
		safeInvoke.mockResolvedValue({ rows: [], whitespaceOnly: false });
		const { container } = render(DiffViewer, {
			props: { ...baseProps, renderMode: "rendered", loading: true },
		});
		const pane = container.querySelector(".rendered-diff");
		expect(pane).not.toBeNull();
		const wrapper = pane?.parentElement as HTMLElement;
		expect(wrapper.getAttribute("style")).toContain("overflow: clip");
	});

	it("is clipped around the source view too", () => {
		const { container } = render(DiffViewer, { props: baseProps });
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.getAttribute("style")).toContain("overflow: clip");
	});
});
