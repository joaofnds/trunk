# Column widths are measured, not declared

The commit list's sized columns fit what they render. A fixed default width is
wrong for every repository that is not the one it was chosen against, so the only
number written down is a starting point the measurement replaces.

Decided 2026-09-21, after the Branch/Tag column shipped pinned at 120px.

## What went wrong

Graph, author, date and sha each measured their content and fitted it. Branch/Tag
had neither a content-width function nor an effect, so it alone kept its default
for every repository.

One number could not be right for both directions at once. `backup-pre-rebase`
needs about 138px and truncated at 120. A repository whose only ref is `main`
needs about 61 and spent the rest on dead space before the lanes. Because the
lanes begin at exactly the ref column's width, that single number produced both
the truncation and the misalignment in the same screenshot.

## A fit measures what it draws

A sized column's fit comes from measuring the thing it draws, in the font it draws
it in, including any chrome that shares the cell. Sizing for the label alone is the
failure this rule exists to prevent. A row's Branch/Tag cell draws its
highest-priority ref, bold when it is HEAD, beside a `+N` badge that folds the rest,
so `refContentWidth` measures exactly that pill: measuring every ref's name sized
the column to names the row never shows, and leaving out the badge cut a label that
shared its row with one. The badge's width comes from `overflowBadgeWidth`, the one
function both the layout and the renderer call; two formulas for it once disagreed
by 6px and the badge drew past the room it was given.

Graph fits its lane count, Date the widest label the relative clock can produce,
SHA seven characters, Author the widest name. Diff draws a bar with no intrinsic
width, so its fit is its default.

## A fit has a cap, and the fits share the list

"Fit the widest thing found" is only right while the widest thing is
representative. A backup branch carrying a timestamp runs past forty characters,
and a contributor's full name can too. Fitted exactly, they push Message, the
column worth reading, down to a sliver.

So each fit stops at a cap: 240px for Branch/Tag, 160px for Author, and a third of
the row for Graph, the share Git Graph's auto layout gives its graph. The pixel
caps are starting values, not measurements.

Caps alone cannot keep the layout inside the list. At the 720px window minimum with
the default side panes the list is 244px, while the default sized columns alone sum
to 390. So the fits share a budget: the row's width less Message's floor and less
every user width. `shareBudget` lays each capped fit into it, and when together they
overrun it they yield toward their floors in this order: SHA, Diff, Date, Author,
Branch/Tag, Graph. That is rightmost first, as GitKraken's graph component shrinks
its zones and NSTableView's sequential style does, with two moves: Diff yields ahead
of Date and Author because its bar scales where their text is cut, and Branch/Tag
ahead of Graph because a cut pill's name is a hover away while a lane past the edge
is not. A layout the app chose therefore fits the list whenever the row, the list
less its two 4px gutters, holds the six floors and Message's floor, 346px on macOS;
below that the row is wider than the list and the surplus scrolls sideways.

MUI's outlier exclusion was considered and rejected: a page with three refs has no
distribution to exclude from.

## A user width has a floor and no ceiling

The product owner's rule, 2026-09-22: "you should have like reasonable defaults for
when a graph is open and of course we should not auto-layout in a way that makes
those like columns that look terrible but if the user wants to do that by itself
then we should let'em." The caps and the budget bound what the app decides on its
own. A drag has only the column's floor, a stored width comes back as wide as it was
left, and a user width sits outside the budget: the fits yield to make room for it,
and once they are at their floors a wider drag pushes the row past the list.

## Past the list, the table scrolls sideways

Once the shown sized columns and Message's floor add up to more than the list, the row
is laid out at that sum, `tableMinWidth`, and the surplus scrolls sideways. Message gives
up its slack first, so a layout that fits never scrolls. What scrolls is a user width
dragged past the budget, or a list narrower than the floors: measured in WebKit at a
252px list, whose row is 244px, every column at its floor adds to 346px, and the table
scrolls 102px to bring SHA whole into view.

The list's own viewport is the sideways scroller. VirtualList takes the table's width as
`minContentWidth`, lays its content out at least that wide and lets its viewport scroll
on `x`, so momentum and the horizontal wheel come from the engine, and the graph overlay,
drawn inside that content, moves with the rows with no offset of its own. The column
header mirrors the viewport's `scrollLeft` through `src/lib/scroll-sync.ts`. Its cells
sit in a scroller inside the header's padding, as the rows sit inside the list's, so the
two have one client width and one scroll range. The first build of this (bc13040a,
reverted with the rest at 409d34b3) offset every row, the header and the overlay by one
JavaScript value instead, three places to keep in step.

The mirror has a cost. The header follows from the viewport's `scroll` event, and a
scroll is composited before its handler runs, so while the table is moving the header
may trail the rows by a frame; `docs/architecture/diff-virtualization.md` records the
same effect, observed, for a gutter pinned from a scroll handler. The alignment was
measured at rest only: after each scroll, every header cell's left edge equals its row
cell's. A header inside the scroller, sticky to its top, would move with the rows on the
compositor, at the price of a header inside the virtual list's measured height.

The content clips at its own width. The overlay is as wide as the lanes rather than the
Graph column, and a hovered pill shows its whole name, so either can reach past a table
that fits. Measured in WebKit before the clip, with every column fitting: forty lanes in a
56px Graph column at a 700px list, Diff and SHA hidden, left the viewport a `scrollWidth`
of 742 against a `clientWidth` of 692; a long pill hovered at a 280px list left 291
against 272. Either range is one `overflow-x: auto` would let the user scroll into. With
`overflow-x: clip` on the content both measure their `clientWidth`, 692 and 272.

A sideways gesture over a Graph column narrower than its lanes still pans them, until
they reach their end in the gesture's direction; past that end, and anywhere else, it
scrolls the table. That is the product owner's rule, 2026-09-23, taken from how a
browser scrolls a page with a scrollable section in it: the section scrolls to its end
first, and scrolling on from there moves the page. Each wheel event goes one way or the
other, decided by the column under the pointer as the table stands at that event: one
that finds the lanes already at their end goes to the engine whole, and the part of one
that overshoots the end is dropped rather than handed on. So a swipe that begins over
another column and carries the Graph column under a still pointer starts panning the
lanes partway through. Whether WKWebView holds one trackpad gesture to the scroller it
began on, as browsers are generally held to do, has not been observed. When the pan does
move and the table can scroll sideways, the pan cancels the gesture, or the table would
move under it too, and applies the gesture's vertical part to the list itself, so a
diagonal swipe over the lanes still scrolls the commits.
That part is added as pixels without reading `deltaMode`, so a wheel reporting lines,
not tried, would move the list by the line count in pixels. A table that fits has
nothing to move sideways, and the engine keeps the gesture. The pointer is read in table
coordinates, past however far the table has scrolled.

Message pans its summaries under the same rule, on the product owner's direction of
2026-09-23: a summary cut off at the column's edge is read by swiping over it, not by
widening the column. The pan is a negative `text-indent` on every commit's and stash's
summary, read from one custom property on the list's root, so a swipe is one style
write and a row the virtual list mounts later arrives already moved. An indent keeps the
text inline, so the trailing ellipsis stays while the text still overflows and goes once
its end is in view; a transform would need an inline-block, which `text-overflow` treats
as one box to hide whole. The pan ends where the longest cut summary on screen ends: of
the rows the virtual list has mounted, only those inside its viewport count, since it
mounts twenty more past each edge, and a long summary out of view would let the pan slide
the visible ones out of their cells. Because that end moves with the rows on screen, the
pan is pulled back to it whenever they change, by a scroll, new rows or a new width;
otherwise it would outlive the summary that earned it and leave the column blank. The
measure is each summary's own laid-out text, through a `Range`, and not a canvas: a
canvas needs the font as a string, WebKit serializes a computed `font` as an empty
string, and a canvas handed one keeps whatever font it had last, which measured a 747px
summary at 546px. Measured in WebKit with 48 rows mounted, a swipe over Message costs
0.37ms and a scroll with its thumb up 0.13ms. Message's width is the engine's, read from
its header cell, since it is the slack column and no state holds it. Every summary moves
by the same offset, so a short one slides out of view as a long one is read. Moving each
summary only as far as it is cut is the other shape, with a scroll offset per row where
this has one for all; the product owner leans to one offset and picks between the two
after using both in the app (TRUNK-254.6).

The sideways thumb is the scrollbar tracker's, shown only while the table scrolls, as
`docs/architecture/scrollbars.md` settles for every thumb. Each pan gets a thumb of its
own, along its column's width at the list's bottom edge, which the component announces
to the tracker because no scroll event reports a pan.

Not taken: shrinking user widths to fit, which is the ceiling the product owner refused
above; pinning Graph or Branch/Tag while the rest scrolls, since once Message is at its
floor the columns off screen are the ones to its right; and hiding columns by priority,
which would fight the visibility the user set.

## Branch/Tag's floor is a `main` pill

The product owner's direction, 2026-09-23, after seeing the column dragged to a 20px
floor: "let's allow the minimum width to be the width of the main pill with the icon and
everything." The screenshot beside those words showed HEAD's `main` pill alone, with no
`+N` badge. A narrower column cut every pill to a sliver of capsule and icon. The floor
is that pill whole: its capsule, icon and name, with the column's padding and the gap
that mirrors the dot's inset. The name is measured at runtime in the bold font HEAD
draws in, as every fit is. The app bundles no font: the pills ask for Inter and fall
back to the system font, so a declared width holds `main` whole on one machine only.
On macOS the floor is 62px.

It bounds the column however its width is set: a drag, a stored width, the budget, and
a fit. A page whose refs are all shorter than `main`, one whose only ref is `dev`, shows
them with room to spare rather than fitting below the floor. A fit under the floor made
the first move of a drag jump the column wider, since a drag stops at the floor, and a
third of a very narrow row capped Graph under its one lane. GitKraken's graph component
(11.3.0) stops this zone at 32px, which in this pill's geometry holds the icon alone;
that was the look ruled out.

At the floor a row whose `+N` badge leaves no room for even an ellipsis draws its pill
as the icon alone, capsule whole, beside the badge. A two-digit badge, on a commit
carrying eleven refs or more, is itself cut at the column's edge. A label never draws
wider than the room it was given, and whatever a pill draws is clipped to the column, so
only its connector reaches the lanes.

## Message has a floor

Message is the slack column: it has no fit and no user width, and takes what the
sized columns leave. Without a floor a narrow list drives it to zero before
anything on screen says a width is what went wrong, so the header cell and the row
cell both carry `MESSAGE_FLOOR`, 180px, as their minimum width.

## What a stored width means

A width in the pref file is a claim about the user's intent, and the widths alone
cannot carry it: every column's number looks the same whether the user dragged it
or a fit computed it. `resized_columns` records which ones the user chose, and only
those are restored. Everything else fits the page that just loaded. A pref file
written before `resized_columns` existed reads as nobody having sized anything.

A column joins that set only when a drag moves it. A click on a divider sizes
nothing, and the pref writes are not ordered against each other, so a click that
wrote the set could land after a double-click that had just cleared it.

A restored width does not grow to meet content. The user's number wins until they
double-click the column's divider, which hands the column back to its fit and drops
it from `resized_columns`. That is the one way back, which is what makes a stored
user width safe to keep; AG Grid and MUI both refit on a divider double-click. On the
Graph divider it also returns the pan to its start. Graph's fit is capped at a third of
the row, so a refitted column can still be narrower than its lanes, and a pan left
where it was would keep the lanes it had scrolled out of the view there.

Before this, the restore replaced the whole object after the fits had already run.
Those effects read the widths untracked, so nothing re-ran to correct it, and every
fit was discarded in favour of the previous session's numbers, or of the defaults
when nothing was stored.

## The pref file is untrusted

Nothing upstream validates it: `prefs_get` hands back whatever JSON the file holds,
and the widths were spread over the defaults unchecked. A stored `null`, string or
`NaN` became the live width, and `NaN` was unrecoverable, because a drag computes
from the width it starts at, so every drag produced `NaN` and persisted it.

Widths are sanitized on the way in: a value survives only if it is a finite
positive number, then it is rounded and raised to that column's floor, and
nothing else: a width that is merely large is the user's to choose. Anything else
falls back to that column's default. `resized_columns` keeps only the names of
sized columns.

## When a fit is measured and when the budget applies

Content is measured when a page loads and when the graph is replaced, never on
scroll. The list is virtualized, so most rows have never been measured, and
fitting "the content" would mean fitting whatever the scroll position happened to
render. Each column keeps a running maximum over the pages that have loaded,
reset when the graph is replaced. AG Grid documents the same limit for its own
content auto-size: with 10,000 rows and 50 rendered, only those 50 are measured.

The budget re-applies whenever the list's width changes, read from a
`ResizeObserver` on the list's root, and whenever a column is shown, hidden, sized
by the user or handed back. A user width is never changed by that pass. While the
list is unmeasured there is no budget and only the pixel caps apply.

All of this runs in one effect. The fits share one budget, and separate writers of
the same object cannot share anything.

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
icon, and the Graph and Message pans' hit tests; Message's own width is read from the
layout instead, because no state holds it.

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

A stored `message: false`, which only the pref file can hold since the header menu
cannot hide Message, leaves every row drawing its Message cell while the table's width
counts no floor for it, so the rows' right-hand columns are cut at the table's edge
rather than scrolled to (TRUNK-266).

User widths are one set for every repository, so a graph narrowed for a forty-lane
repository stays narrow on a one-lane one.

Widths are absolute pixels and carry no record of the lane pitch they were chosen
under. Nothing writes `displaySettings` today, so a stored graph width cannot yet
disagree with `laneWidth`. When a display-settings pref lands, a user-sized graph
width will keep its pixels while the lanes change pitch.
