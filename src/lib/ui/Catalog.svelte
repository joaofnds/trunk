<script lang="ts" module>
import tokens from "../../tokens.css?raw";
import type { ButtonSize, ButtonVariant } from "./Button.svelte";
import type { RowReveal, RowTone, RowVariant } from "./Row.svelte";
import type { RowActionTone } from "./RowAction.svelte";

const DECLARED = [...tokens.matchAll(/^\t(--[\w-]+):/gm)].map(
	([, name]) => name,
);
const COLORS = DECLARED.filter((name) => name.startsWith("--color-"));
const LANES = DECLARED.filter((name) => /^--lane-\d$/.test(name));
const SPACES = DECLARED.filter((name) => /^--space-\d$/.test(name));

const VARIANTS: ButtonVariant[] = [
	"primary",
	"secondary",
	"ghost",
	"accent",
	"danger",
	"success",
	"warning",
];
const SIZES: ButtonSize[] = ["xs", "sm", "md", "lg"];
const TONES: RowActionTone[] = [
	"subtle",
	"muted",
	"text",
	"success",
	"danger",
	"destructive",
];
const FILES = ["src/main.rs", "src/lib.rs", "Cargo.toml"];
const REPOS = ["trunk", "dotfiles"];
const STRATEGIES = ["Fetch", "Fast-forward only", "Pull (rebase)"];
const PARENTS = ["a1b2c3d", "e4f5a6b"];
const MODES = ["Commit", "Amend", "Stash"];
const LIST_ROWS: RowVariant[] = ["inset", "flush", "entry", "item", "parent"];
const BAR_ROWS: RowVariant[] = ["header", "band"];
const FRAMED_ROWS: RowVariant[] = ["title", "divider", "fill"];
const ROW_TONES: RowTone[] = ["plain", "muted", "current"];
const ROW_REVEALS: RowReveal[] = ["hover", "fade", "pointer"];
const BRANCHES = ["main", "release", "feature/login"];
const LINES = [12, 13, 14];
const PANE_WIDTH = 240;
const PANE_MIN = 120;

const stay = () => undefined;
</script>

<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import Check from "@lucide/svelte/icons/check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import Eye from "@lucide/svelte/icons/eye";
import GitBranch from "@lucide/svelte/icons/git-branch";
import Plus from "@lucide/svelte/icons/plus";
import X from "@lucide/svelte/icons/x";
import { treeIndent } from "../chrome-heights";
import Button from "./Button.svelte";
import ButtonGroup from "./ButtonGroup.svelte";
import Chip from "./Chip.svelte";
import Dialog from "./Dialog.svelte";
import GutterGrip from "./GutterGrip.svelte";
import HitArea from "./HitArea.svelte";
import Keycap from "./Keycap.svelte";
import LinkButton from "./LinkButton.svelte";
import ListOption from "./ListOption.svelte";
import Radio from "./Radio.svelte";
import Row from "./Row.svelte";
import RowAction from "./RowAction.svelte";
import Splitter from "./Splitter.svelte";
import Tab from "./Tab.svelte";
import TabStrip from "./TabStrip.svelte";
import Tag from "./Tag.svelte";
import ToastCard from "./ToastCard.svelte";
</script>

<!--
	Every token and primitive on one screen, for a human in a browser and for
	the visual suite's catalog baseline (docs/visual-regression.md). Nothing in
	the app mounts it. Text carries data-catalog-text so the capture can mask it.
-->
<div data-testid="catalog" class="flex flex-col gap-6 bg-bg p-6 text-text">
	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Color roles</h2
		>
		<ul class="grid grid-cols-6 gap-2">
			{#each COLORS as name (name)}
				<li class="flex min-w-0 items-center gap-2">
					<span
						class="size-6 shrink-0 rounded border border-border"
						style:background="var({name})"
					></span>
					<span
						data-catalog-text
						class="min-w-0 flex-1 truncate font-mono text-caption text-text-muted"
						>{name}</span
					>
				</li>
			{/each}
		</ul>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Graph lanes</h2
		>
		<ul class="flex gap-2">
			{#each LANES as name (name)}
				<li class="size-6 rounded" style:background="var({name})"></li>
			{/each}
		</ul>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Spacing</h2
		>
		<ul class="flex flex-col gap-2">
			{#each SPACES as name (name)}
				<li class="flex items-center gap-2">
					<span class="h-4 rounded bg-accent" style:width="var({name})"></span>
					<span
						data-catalog-text
						class="flex-1 font-mono text-caption text-text-muted"
						>{name}</span
					>
				</li>
			{/each}
		</ul>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Type</h2
		>
		<p data-catalog-text class="text-caption"
			>caption: The quick brown fox jumps over the lazy dog</p
		>
		<p data-catalog-text class="text-small"
			>small: The quick brown fox jumps over the lazy dog</p
		>
		<p data-catalog-text class="text-callout"
			>callout: The quick brown fox jumps over the lazy dog</p
		>
		<p data-catalog-text class="text-body"
			>body: The quick brown fox jumps over the lazy dog</p
		>
		<p data-catalog-text class="text-title"
			>title: The quick brown fox jumps over the lazy dog</p
		>
		<p data-catalog-text class="text-display"
			>display: The quick brown fox jumps over the lazy dog</p
		>
		<p data-catalog-text class="font-mono text-body"
			>mono: git rebase --interactive HEAD~3</p
		>
		<p class="grid grid-cols-3 gap-4 text-body">
			<span data-catalog-text class="font-regular">regular</span>
			<span data-catalog-text class="font-medium">medium</span>
			<span data-catalog-text class="font-semibold">semibold</span>
		</p>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Radius and elevation</h2
		>
		<div class="flex items-center gap-6">
			<div
				class="size-control-lg rounded border border-border-strong bg-surface"
			></div>
			<div class="size-control-lg rounded bg-surface-raised shadow-sm"></div>
			<div class="size-control-lg rounded bg-surface-raised shadow-md"></div>
			<div class="size-control-lg rounded bg-surface-raised shadow-lg"></div>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Button</h2
		>
		<ul class="flex flex-col gap-3">
			{#each VARIANTS as variant (variant)}
				<li class="flex items-center gap-4">
					{#each SIZES as size (size)}
						<Button {variant} {size}
							><span data-catalog-text>{variant} {size}</span></Button
						>
					{/each}
					<Button {variant} icon aria-label="Done"><Check size={14} /></Button>
					<Button {variant} icon size="xs" aria-label="Close"
						><X size={12} /></Button
					>
					<Button {variant} disabled
						><span data-catalog-text>disabled</span></Button
					>
					<Button {variant} aria-pressed="true"
						><span data-catalog-text>pressed</span></Button
					>
				</li>
			{/each}
		</ul>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>ButtonGroup</h2
		>
		<div class="flex items-center gap-4">
			<ButtonGroup>
				<Button joined><span data-catalog-text>Pull</span></Button>
				<Button joined icon size="sm" variant="ghost" aria-label="Pull options"
					><ChevronDown size={12} /></Button
				>
			</ButtonGroup>
			<ButtonGroup tone="accent">
				<Button joined variant="ghost"
					><span data-catalog-text>All threads</span></Button
				>
				<Button joined icon aria-pressed="true" aria-label="Hide review threads"
					><Check size={14} /></Button
				>
			</ButtonGroup>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>LinkButton</h2
		>
		<div class="flex items-center gap-2 text-body font-semibold">
			<LinkButton mono><span data-catalog-text>a1b2c3d</span></LinkButton>
			<LinkButton
				><span data-catalog-text
					>fix the thing the summary names</span
				></LinkButton
			>
		</div>
		<div class="flex items-center gap-2 text-small">
			<LinkButton tone="muted" mono
				><span data-catalog-text>r-12</span></LinkButton
			>
			<LinkButton tone="muted"
				><span data-catalog-text
					>src/lib/ui/LinkButton.svelte:L1-L9</span
				></LinkButton
			>
		</div>
		<div class="flex items-center gap-4 text-callout">
			<LinkButton tone="accent"
				><span data-catalog-text>Show 2 more replies</span></LinkButton
			>
			<LinkButton tone="muted"><span data-catalog-text>Edit</span></LinkButton>
			<LinkButton tone="danger"
				><span data-catalog-text>Delete</span></LinkButton
			>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>RowAction</h2
		>
		<ul class="flex flex-col gap-2">
			{#each TONES as tone (tone)}
				<li class="flex items-center gap-4">
					<RowAction {tone} aria-label="Hide {tone}"
						><Eye size={12} /></RowAction
					>
					<RowAction {tone} size="compact" aria-label="Stage {tone}"
						><Plus size={11} /></RowAction
					>
					<span data-catalog-text class="text-caption text-text-muted"
						>{tone}</span
					>
				</li>
			{/each}
		</ul>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Row</h2
		>
		{#snippet eye()}
			<RowAction aria-label="Hide"><Eye size={12} /></RowAction>
		{/snippet}
		<div class="grid grid-cols-3 gap-4">
			<div class="flex flex-col gap-1 bg-surface py-1">
				{#each LIST_ROWS as variant (variant)}
					<Row {variant}><span data-catalog-text>{variant}</span></Row>
				{/each}
				{#each ROW_REVEALS as reveal (reveal)}
					<Row actions={eye} {reveal}
						><span data-catalog-text>{reveal}</span></Row
					>
				{/each}
				<Row variant="entry" actions={eye} reveal="always"
					><span data-catalog-text>entry</span>
					{#snippet detail()}
						<span data-catalog-text>detail</span>
					{/snippet}</Row
				>
			</div>
			<div class="flex flex-col gap-1 bg-surface py-1">
				{#each ROW_TONES as tone (tone)}
					<Row {tone} actions={eye} reveal="always"
						><span data-catalog-text>{tone}</span></Row
					>
				{/each}
				<div role="listbox" aria-label="Branches" class="flex flex-col">
					{#each BRANCHES as branch, i (branch)}
						<Row variant="item" role="option" selected={i === 1} tabindex={-1}
							><span data-catalog-text>{branch}</span></Row
						>
					{/each}
				</div>
				<div role="tree" aria-label="Files" class="flex flex-col">
					<Row variant="parent" role="treeitem" tabindex={-1}
						><span data-catalog-text>src</span></Row
					>
					{#each FILES as file (file)}
						<Row
							variant="item"
							role="treeitem"
							indent={treeIndent(1)}
							tabindex={-1}
							><span data-catalog-text>{file}</span></Row
						>
					{/each}
				</div>
			</div>
			<div class="flex flex-col gap-1 bg-surface py-1">
				{#each BAR_ROWS as variant (variant)}
					<Row {variant} actions={eye} reveal="always"
						><span data-catalog-text class="text-callout">{variant}</span></Row
					>
				{/each}
				{#each FRAMED_ROWS as variant (variant)}
					<div class="h-bar">
						<Row {variant}><span data-catalog-text>{variant}</span></Row>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>ListOption</h2
		>
		<div class="flex gap-4">
			<div role="listbox" aria-label="Files" class="flex-1 text-callout">
				{#each FILES as file, i (file)}
					<ListOption selected={i === 1}
						><span data-catalog-text>{file}</span></ListOption
					>
				{/each}
			</div>
			<div role="listbox" aria-label="Recent repositories" class="flex-1">
				{#each REPOS as repo, i (repo)}
					<ListOption layout="stack" highlight="hover" selected={i === 0}>
						<span data-catalog-text class="text-body font-semibold text-text"
							>{repo}</span
						>
						<span data-catalog-text class="text-callout text-text-muted"
							>~/code/{repo}</span
						>
					</ListOption>
				{/each}
			</div>
			<div
				role="menu"
				aria-label="Pull options"
				class="flex-1 rounded border border-border bg-surface-raised py-1 text-callout"
			>
				{#each STRATEGIES as strategy (strategy)}
					<ListOption role="menuitem"
						><span data-catalog-text>{strategy}</span></ListOption
					>
				{/each}
			</div>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Chip</h2
		>
		<div class="flex items-center gap-2">
			<Chip><ArrowUp size={11} /><span data-catalog-text>c7d8e9f</span></Chip>
			{#each PARENTS as parent, i (parent)}
				<Chip tone={i === 0 ? "accent" : "neutral"}
					><ArrowDown size={11} /><span data-catalog-text>{parent}</span></Chip
				>
			{/each}
			<Chip variant="label"><span data-catalog-text>main</span></Chip>
			<span class="catalog-lane flex"
				><Chip tone="lane"
					><GitBranch size={11} /><span data-catalog-text>feature</span></Chip
				></span
			>
		</div>
		<div class="flex w-dialog-min items-center gap-1">
			<Chip truncate
				><GitBranch size={11} />
				<span data-catalog-text
					>feature/a-branch-name-far-too-long-for-its-row</span
				></Chip
			>
			<Chip truncate
				><GitBranch size={11} /><span data-catalog-text>main</span></Chip
			>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Radio</h2
		>
		<div class="flex items-center gap-2">
			<Radio checked aria-label="Active review" />
			<Radio checked={false} aria-label="Make active" />
			<Radio variant="mark" checked />
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Tag</h2
		>
		<div class="flex items-center gap-2">
			<Tag><span data-catalog-text>Lines 10–11</span></Tag>
			<Tag disabled><span data-catalog-text>Line 4</span></Tag>
			<Tag dashed variant="label"
				><span data-catalog-text>Whole commit</span></Tag
			>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Keycap</h2
		>
		<div class="flex items-center gap-1">
			<Keycap><span data-catalog-text>J</span></Keycap>
			<Keycap><span data-catalog-text>⌘</span></Keycap>
			<Keycap><span data-catalog-text>↵</span></Keycap>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Tab</h2
		>
		<div class="bg-surface-raised">
			<TabStrip aria-label="Commit mode">
				{#each MODES as mode, i (mode)}
					<Tab selected={i === 1}><span data-catalog-text>{mode}</span></Tab>
				{/each}
			</TabStrip>
		</div>
		<div role="tablist" aria-label="Repositories" class="flex gap-1">
			{#each REPOS as repo, i (repo)}
				<div
					role="presentation"
					class={[
						"grid h-control shrink-0 rounded text-callout font-medium whitespace-nowrap",
						i === 0
							? "bg-surface-raised text-text-strong ring-1 ring-inset ring-border"
							: "text-text-muted hover:bg-hover hover:text-text",
					]}
				>
					<Tab variant="framed" selected={i === 0}>
						<span data-catalog-text>{repo}</span>
						{#snippet trailing()}
							<Button icon size="xs" variant="ghost" aria-label="Close {repo}"
								><X size={12} /></Button
							>
						{/snippet}
					</Tab>
				</div>
			{/each}
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>ToastCard</h2
		>
		<div class="flex flex-col gap-2 self-start">
			<ToastCard
				><span data-catalog-text>Pushed main to origin</span></ToastCard
			>
			<ToastCard tone="danger"
				><span data-catalog-text>Push rejected: fetch first</span></ToastCard
			>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Dialog</h2
		>
		<div data-catalog-headings class="w-dialog-max">
			<Dialog variant="anchored" title="Reword commit message">
				<span data-catalog-text class="text-body">feat: add login</span>
				<span data-catalog-text class="text-body text-text-muted"
					>Checks the token before the session opens.</span
				>
			</Dialog>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>GutterGrip</h2
		>
		<div class="flex flex-col self-start bg-surface font-mono text-callout">
			{#each LINES as line (line)}
				<GutterGrip aria-label="Select line {line}">
					<span data-catalog-text class="px-2 text-text-subtle">{line}</span>
					<span data-catalog-text class="px-2 text-text-subtle"
						>{line + 2}</span
					>
				</GutterGrip>
			{/each}
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>HitArea</h2
		>
		<div class="flex items-center gap-4">
			<div
				class="h-control-sm rounded-full bg-accent-bg text-small text-accent"
			>
				<HitArea aria-label="main" cursor="pointer" shape="pill"
					><span data-catalog-text class="px-2">main</span></HitArea
				>
			</div>
			<div
				class="grid h-control-sm w-control-sm place-items-center bg-surface-raised text-small text-text-muted"
			>
				<span data-catalog-text class="col-start-1 row-start-1">+2</span>
				<div class="col-start-1 row-start-1 size-full">
					<HitArea aria-label="main and 2 more" />
				</div>
			</div>
			<div
				role="menu"
				aria-label="Refs on this commit"
				class="rounded border border-border bg-surface-raised px-2 py-1"
			>
				{#each BRANCHES as branch (branch)}
					<div
						class="-mx-1 h-target rounded text-small font-medium whitespace-nowrap hover:bg-hover"
					>
						<HitArea
							role="menuitem"
							aria-label={branch}
							cursor="context-menu"
							shape="row"
							><span data-catalog-text class="px-1">{branch}</span></HitArea
						>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<h2 data-catalog-text class="text-title font-semibold text-text-strong"
			>Splitter</h2
		>
		<div class="grid grid-cols-4 gap-4">
			<div class="flex h-topbar bg-surface">
				<div class="flex-1"></div>
				<Splitter
					variant="pane"
					aria-label="Resize pane"
					value={PANE_WIDTH}
					min={PANE_MIN}
					onstep={stay}
				/>
				<div class="flex-1"></div>
			</div>
			<div class="flex h-topbar bg-surface">
				<div class="relative flex-1">
					<Splitter
						variant="column"
						aria-label="Resize column"
						value={PANE_WIDTH}
						min={PANE_MIN}
						onstep={stay}
					/>
				</div>
				<div class="flex-1"></div>
			</div>
			<div class="flex h-topbar flex-col bg-surface">
				<div class="flex-1"></div>
				<Splitter
					variant="bar"
					aria-label="Resize form"
					value={PANE_WIDTH}
					min={PANE_MIN}
					onstep={stay}
				/>
				<div class="flex-1"></div>
			</div>
			<div class="flex h-topbar flex-col bg-surface">
				<div class="flex-1"></div>
				<Splitter variant="bar" fixed />
				<div class="flex-1"></div>
			</div>
		</div>
	</section>
</div>

<style>
/* A ref chip takes its colour from the graph lane its section hands it. */
.catalog-lane {
	--lane: var(--lane-3);
}
</style>
