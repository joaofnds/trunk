<script lang="ts" module>
import type { DiffMatch } from "../../lib/diff-find.js";
import {
	splitInvisibles,
	trailingWhitespaceStart,
} from "../../lib/diff-utils.js";
import type { DiffLine } from "../../lib/types.js";

export { diffLineText };
</script>

{#snippet spanText(
	text: string,
	classes: string,
	invisibles: boolean,
	trailing: boolean,
)}
	{#if invisibles}
		{#each splitInvisibles(text, trailing) as segment}
			<span
				class="{classes}{segment.isInvisible
					? " invisible-char"
					: ""}{segment.isTrailing ? " trailing-ws" : ""}"
				data-glyph={segment.glyph}
				>{segment.text}</span
			>
		{/each}
	{:else if classes}
		<span class={classes}>{text}</span>
	{:else}
		{text}
	{/if}
{/snippet}

{#snippet tokens(
	line: DiffLine,
	invisibles: boolean,
	from = 0,
	to = line.content.length,
)}
	{#if line.spans.length}
		{@const trail = invisibles
			? trailingWhitespaceStart(line.content)
			: line.content.length}
		{@const spans =
			from === 0 && to === line.content.length
				? line.spans
				: line.spans.filter((span) => span.start < to && from < span.end)}
		{#each spans as span}
			{@const text = line.content.slice(
				Math.max(from, span.start),
				Math.min(to, span.end),
			)}
			{@const classes =
				span.syntax_class +
				(span.emphasized
					? line.origin === "Add"
						? " word-add"
						: " word-delete"
					: "")}
			{@render spanText(text, classes, invisibles, span.end > trail)}
		{/each}
	{:else}
		{@render spanText(line.content.slice(from, to), "", invisibles, false)}
	{/if}
{/snippet}

{#snippet diffLineText(
	line: DiffLine,
	invisibles: boolean,
	match: DiffMatch | null,
)}
	{#if match}
		<span>{@render tokens(line, invisibles, 0, match.start)}</span
		><mark data-diff-match
			>{@render spanText(
				line.content.slice(match.start, match.end),
				"",
				invisibles,
				false,
			)}</mark
		><span
			>{@render tokens(line, invisibles, match.end, line.content.length)}</span
		>
	{:else}
		{@render tokens(line, invisibles)}
	{/if}
{/snippet}

<style>
.word-add {
	background-color: var(--color-diff-word-add-bg);
	border-radius: var(--radius);
}
.word-delete {
	background-color: var(--color-diff-word-delete-bg);
	border-radius: var(--radius);
}

/* Syntax highlighting classes */
.syn-keyword {
	color: var(--color-syn-keyword);
}
.syn-string {
	color: var(--color-syn-string);
}
.syn-comment {
	color: var(--color-syn-comment);
}
.syn-number {
	color: var(--color-syn-number);
}
.syn-type {
	color: var(--color-syn-type);
}
.syn-function {
	color: var(--color-syn-function);
}
.syn-variable {
	color: var(--color-syn-variable);
}
.syn-constant {
	color: var(--color-syn-constant);
}
.syn-operator {
	color: var(--color-syn-operator);
}
.syn-punctuation {
	color: var(--color-syn-punctuation);
}
.syn-attribute {
	color: var(--color-syn-attribute);
}
.syn-tag {
	color: var(--color-syn-tag);
}
.syn-property {
	color: var(--color-syn-property);
}
.syn-regex {
	color: var(--color-syn-regex);
}
.syn-escape {
	color: var(--color-syn-escape);
}

/* Invisible character styling (Phase 63 -- WHSP-03, D-11). Real whitespace stays
     in the text node (so it copies faithfully) at zero width via font-size:0; the
     ·/→ glyph is painted by a pseudo-element, never part of the selection/clipboard.
     font-size:0 also keeps a real tab at one visual cell, not a tab stop. */
.invisible-char {
	font-size: 0;
}
.invisible-char::before {
	content: attr(data-glyph);
	font-size: var(--text-callout);
	color: var(--color-invisible);
}

/* Trailing whitespace warning (Phase 63 -- D-12) */
.trailing-ws {
	background-color: var(--color-trailing-ws-bg);
}
.trailing-ws::before {
	color: var(--color-trailing-ws-fg);
}

/* Text on a word patch is the primary diff color, whatever its syntax class
     or marker role. The patch is strong enough that no syntax hue clears AAA
     on it (see --color-diff-word-add-bg); last so it wins every equal-
     specificity color rule above. */
.word-add,
.word-delete,
.word-add::before,
.word-delete::before {
	color: var(--color-diff-text);
}
/* Trailing whitespace inside a word patch keeps the patch color: its own red
     tint on top would take the glyph below AAA on a selected line, and the
     patch plus the marker glyph already say everything the tint said. */
.word-add.trailing-ws {
	background-color: var(--color-diff-word-add-bg);
}
.word-delete.trailing-ws {
	background-color: var(--color-diff-word-delete-bg);
}

mark {
	background-color: var(--color-accent);
	color: var(--color-on-accent);
}
mark .invisible-char::before {
	color: var(--color-on-accent);
}
</style>
