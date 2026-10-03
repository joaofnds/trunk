<script lang="ts" module>
import tokens from "../../tokens.css?raw";
import type { ButtonSize, ButtonVariant } from "./Button.svelte";
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
const SIZES: ButtonSize[] = ["sm", "md", "lg"];
const TONES: RowActionTone[] = ["subtle", "muted", "text", "success", "danger"];
const FILES = ["src/main.rs", "src/lib.rs", "Cargo.toml"];
const REPOS = ["trunk", "dotfiles"];
const STRATEGIES = ["Fetch", "Fast-forward only", "Pull (rebase)"];
const PARENTS = ["a1b2c3d", "e4f5a6b"];
const MODES = ["Commit", "Amend", "Stash"];
</script>

<script lang="ts">
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import Check from "@lucide/svelte/icons/check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import Eye from "@lucide/svelte/icons/eye";
import Plus from "@lucide/svelte/icons/plus";
import Button from "./Button.svelte";
import ButtonGroup from "./ButtonGroup.svelte";
import Chip from "./Chip.svelte";
import LinkButton from "./LinkButton.svelte";
import ListOption from "./ListOption.svelte";
import RowAction from "./RowAction.svelte";
import Tab from "./Tab.svelte";
import TabStrip from "./TabStrip.svelte";
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
					<ListOption role="menuitem" highlight="accent"
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
</div>
