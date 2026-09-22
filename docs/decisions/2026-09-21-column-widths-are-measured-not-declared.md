# Column widths are measured, not declared

The commit list's sized columns fit what they render. A fixed default width is
wrong for every repository that is not the one it was chosen against, so the only
number written down is a starting point the measurement replaces.

Decided 2026-09-21, after the Branch/Tag column shipped pinned at 120px.

## What went wrong

Graph, author, date and sha each measured their content and auto-fit. Branch/Tag
had neither a content-width function nor an effect, so it alone kept its default
for every repository.

One number could not be right for both directions at once. `backup-pre-rebase`
needs about 138px and truncated at 120. A repository whose only ref is `main`
needs about 58 and spent the remaining 62 on dead space before the lanes. Because
the lanes begin at exactly the ref column's width, that single number produced
both the truncation and the misalignment in the same screenshot.

## The rule

A sized column's width comes from measuring the thing it draws, in the font it
draws it in, including any chrome that shares the cell. Sizing for the label alone
is the failure this rule exists to prevent: the ref column measured its pill's
text but not the `+N` badge beside it, and a branch called `feature` rendered as
`f…` on any row carrying two refs.

Message is the exception and takes what the sized columns leave. It carries a
minimum width instead, because a column with no intrinsic width and no floor
reaches zero before anything on screen suggests that a width is what went wrong.

## Fitting the widest thing has a ceiling

"Fit the widest thing found" is only right while the widest thing is
representative. A backup branch carrying a timestamp runs past forty characters
and took the ref column to about 360px; a history with deep merge nesting reports
twenty-odd lanes and took the graph to nearly 400. Together they pushed Message,
the column actually worth reading, down to a clipped sliver beside a wide band of
empty space.

Auto-fit stops at `REF_AUTOFIT_MAX_WIDTH` and `GRAPH_AUTOFIT_MAX_WIDTH`, both
below `MAX_COLUMN_WIDTH`, which a drag still reaches. The cap bounds what the app
decides on its own, not what the user may ask for. Past it a pill truncates with
its full name a hover away and the graph pans to the lanes it cannot show, so the
capped column loses nothing that cannot be recovered.

This and the fixed 120px default are the same defect from opposite ends, and
neither was visible from the test suite — the first was reported from a
screenshot, the second only showed up on opening the built app against a real
repository.

## What a stored width means

A width in the pref file is a claim about the user's intent, and the widths alone
cannot carry it: every column's number looks the same whether the user dragged it
or auto-fit computed it. `resized_columns` records which ones the user chose, and
only those are restored. Everything else re-fits to the page that just loaded.

A restored width does not grow to meet content. The user's number wins until they
change it, which is what GitKraken does and what AG Grid's grid documents as
exempting user-resized columns from later auto-fits.

Before this, the restore replaced the whole object after the auto-fits had already
run. Those effects untrack the widths they write, so nothing re-ran to correct it
and every auto-fit result was discarded in favour of the previous session's
numbers — including for columns the user had never touched. The graph column was
affected too, which is why 39 render goldens were drawing the edge-fade mask that
says the lanes run past the column when they did not.

## The pref file is untrusted

Nothing upstream validates it: `prefs_get` hands back whatever JSON the file holds,
and the widths were spread over the defaults unchecked. A stored `null`, string or
`NaN` became the live width, and `NaN` was unrecoverable — the drag clamp is
`max(floor, min(max, start + delta))`, which is `NaN` for a `NaN` start, so every
drag produced `NaN` and persisted it. The column could not be dragged back and
there is no in-app reset.

Widths are sanitized on the way in: a value survives only if it is a finite
positive number, then it is rounded and clamped to that column's floor and
`MAX_COLUMN_WIDTH`. Anything else falls back to that column's default.

## Why auto-fit measures only the loaded page

The list is virtualized, so most rows have never been measured. Fitting "the
content" would mean fitting whatever the scroll position happened to have
rendered, which is not stable across launches. Each column keeps a running maximum
over the pages that have loaded, reset when the graph is replaced.

This is the same limit AG Grid documents for its own content auto-size: with
10,000 rows and 50 rendered, only those 50 are measured. It is an approximation,
and the alternative — measuring rows that are not on screen — costs more than the
occasional column that grows once when a wider value pages in.

## Header and rows read one width per column

The header is one flex row and every commit row is another, inside the virtual
list, so a header cell sits over its row cells only while they are the same width.
Each sized column's width reaches the cells through one custom property on the
list's root: `columnWidthProperty` names it, `columnWidthDeclarations` writes all
six, and every header cell and row cell takes its width from it. A test in
`CommitGraph.test.ts` sets the property on the root and expects a header cell and a
row cell to follow, so a cell that takes a width of its own fails it.

The widths themselves are the component's `columnWidths` state, and the properties
are how the cells receive it. Script reads the state directly wherever it needs a
number: the graph overlay's geometry, the header's choice between its word and its
icon, and the graph pan's hit test and limit.

Two other inputs to alignment are still written on both sides. The header row and
the list's content area each apply the `COLUMN_PADDING_X` gutter, and the header
orders its cells from `columnLabels` while `CommitRow` fixes its order in markup.
Changing either on one side moves every column.

On a drag, script writes one style attribute, the root's, where it used to write the
dragged column's cell in every rendered row, and a row the virtual list mounts later
reads the current width without being handed it. TanStack Table's column sizing
guide recommends CSS variables for column widths as React performance advice and
says of its Svelte adapter that "similar principles apply". VS Code's table
(`src/vs/base/browser/ui/table/tableWidget.ts`) reads the size through a callback
when it builds a row and, on each resize, writes the resized column's cell in every
rendered row, the per-row write this avoids. A grid template shared through
`subgrid` would declare every column in one place, but the virtual list's viewport
and items container are absolutely positioned, and an absolutely positioned child of
a grid container is not a grid item, so the rows cannot join a grid the header
belongs to.

## What this does not solve

Widths are absolute pixels and carry no record of the lane pitch they were chosen
under. Nothing writes `displaySettings` today, so a persisted graph width cannot
yet disagree with `laneWidth`. When a display-settings pref lands, it will, and
the graph column's auto-fit already shrinks a width that exceeds its target.

Nothing validates the widths against the container. The window has a floor and
Message has a minimum, so the failure is now clipping rather than a column
squeezed to nothing, but a sum wider than the viewport still overflows rather than
redistributing.
