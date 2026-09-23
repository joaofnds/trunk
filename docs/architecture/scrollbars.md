# Scrollbars

Every scroller in the app hides its native scrollbar and gets a themed thumb painted from
JavaScript instead. The reason is layout, not taste, and the rule that forces it is easy to
re-derive wrongly.

## The pieces

| File | Holds |
|---|---|
| `src/app.css` | `::-webkit-scrollbar { display: none }`, applied to everything, and the `.scrollbar-overlay-thumb` class the tracker paints. |
| `src/lib/scrollbar-activity.ts` | The tracker. One capture-phase `scroll` listener covers every scroller in the app, creates and positions the thumb, and runs the drag. A second catches the pans components announce with `announcePan`. |
| `src/lib/app-services.ts` | Wires the tracker once, at startup. |
| `src/lib/scroll-sync.ts` | Mirrors one scroller's `scrollLeft` onto others: the commit list's header follows its rows through it, and the rendered diff's split columns pan as one. |
| `src/components/VirtualList.svelte` | Sizes a virtual list's content, which decides whether a pane has anything to scroll at all. |

## Why the native scrollbar is hidden

WKWebView paints no visible native scrollbar here, so a scroller needs a thumb of its own.
Styling `::-webkit-scrollbar` to supply one costs the thing that matters:

**Any rule that targets `::-webkit-scrollbar` drops WebKit and Blink out of overlay mode.**
The declared width then becomes both the thumb's paint width and a permanently reserved
layout gutter, on every axis, with no way to get one without the other. Measured directly:
`display: none` is the only setting that reserves nothing, and native scrolling by wheel,
trackpad, keyboard and `scrollTop` keeps working with no visible chrome at all.

So the native chrome stays fully hidden and `scrollbar-activity.ts` paints a `position:
fixed` div appended to `<body>`, positioned from `getBoundingClientRect()`. The same
technique `tooltip.ts` uses for its popup. The thumb never joins the scroller's own box, so
it can never affect that box's layout. Radix UI's ScrollArea and the OverlayScrollbars
library both work this way: real native scroll, native chrome hidden, a separate overlay
thumb kept in sync.

One historical constraint explains why the thumb is a plain `<div>` rather than a styled
pseudo-element. WebKit resolves `::-webkit-scrollbar-*` rules once and never re-matches them
when the owner's class or `:hover` state changes, so a state-based reveal lands only when
something else happens to invalidate the scrollbar. That is what "sometimes it shows,
sometimes it doesn't" was. A body-level div has none of that problem.

## When the thumb appears

Only while a pane is scrolling, and for 900ms after it stops. This is a settled product
decision, not an accident: TRUNK-24 shipped an always-on thumb and then a hover-reveal
thumb, and both were rejected on how they looked.

Treat it as load-bearing. Anything that makes the thumb visible more often, a hover reveal,
an always-on mode, a longer linger, has to be measured on a repository whose commits fit on
screen, not only on a large one where a real scroll range hides the failure mode.

A pane that scrolls sideways gets a second thumb along its bottom edge, under the same rule,
with two narrowings the vertical thumb does not have:

- It shows only when the sideways position moved. A pane with a few pixels of incidental
  sideways overflow keeps showing one thumb, the vertical one, while it scrolls up and down.
- It shows only on a pane whose `overflow-x` lets the user scroll it, `auto` or `scroll`. A
  pane that is `hidden` still fires `scroll` when a script writes its `scrollLeft`, which is
  how one pane mirrors another's offset, as the commit list's column header mirrors the
  list, and a mirror must not draw a second thumb for the same scroll.

Once up, the two thumbs share one linger: a pane that goes on scrolling up and down after a
sideways scroll keeps its sideways thumb until 900ms after it stops, and a sideways scroll
shows the vertical thumb too wherever the pane has a vertical range.

Each thumb carries `data-axis`, `vertical` or `horizontal`, and `app.css` gives it its 5px
thickness by that name, so a thumb without it paints nothing.

## A pan the engine does not run

The commit list pans two of its columns by offsets the component keeps itself: the Graph
column's lanes (GLOSSARY "Graph pan") and Message's summaries (GLOSSARY "Message pan").
No `scroll` event reports either, so the component announces a move with
`announcePan(pane, pan)`: a DOM event on the pane it pans inside, which the tracker
catches in the capture phase as it catches `scroll`. The `Pan` it carries says where its
track lies and how far it has gone, as a `ScrollAxisExtent`, and how to move it, so the
thumb is painted along the pane's bottom edge under the pane's shared linger, and dragged
through `dragScrollPosition()` into the pan's own `scrollTo`.

Only the moves the component announces bring a thumb, and both pans announce the
wheel's. The drag repaints its own thumb. A Graph divider double-click that returns the
Graph pan to its start, the clamp that shortens the Graph pan when the column widens or
the lanes fall, and the one that pulls the Message pan back when the summaries on screen
change, move a pan without a thumb, so a thumb still up from a swipe keeps its old place
until it fades or the pane scrolls. The two narrowings above are a pane's own
sideways scroll's and do not apply: a pan's thumb shows whenever a pan is announced.

A pan's track is a column of the table its pane scrolls sideways, so whenever the pane
scrolls, a pan's thumb that is up is repainted and follows its column. The column can
run past the pane's edges, partly or wholly scrolled out of view, and the thumb is cut
off at the pane's edge as the column is, down to nothing once the column has left.

A pane can then hold a thumb for each pan besides its own two. A pan's thumb and the
table's own sideways thumb share the bottom edge, all named `horizontal`, and a swipe
that carries on past a pan's end scrolls the table, so both can be up at once. Whether
they overlap depends on where the column lies and how far the table has scrolled, and
where they do, the one created later lies on top and takes the pointer.

The other shape, the pan as a real horizontal scroll container, is not taken for the
Graph: the rails and dots are one SVG as tall as the list inside the virtual list's
content, and a scroller over the Graph band would sit over the rows' clicks and take the
vertical wheel. For Message it would be a scroller per summary, one offset each, which
is the shape of moving each summary only as far as it is cut; one offset for all is one
number every row reads.

### Which wheel events a pan takes

The commit list's wheel handler decides which events go to a pan from what WebKit does
with them, read from its source at commit 7498717a (September 2026) and not observed in
the app. A trackpad drifts sideways as it scrolls down, and WebKit hands the page that
drift: it holds its own scrollers to a swipe's main axis while the finger moves
(`WheelEventDeltaFilterMac`; momentum is not filtered), but filters only the deltas it
scrolls by, never the ones the DOM event carries. It also decides at a swipe's first
event whether the page may cancel the rest: once that event goes uncancelled, no later
event of the swipe can be cancelled, and the engine scrolls them without waiting on the
page (`EventHandler::updateWheelGestureState`,
`ScrollingTree::computeWheelProcessingSteps`).

So a pan takes a wheel event only when it is more sideways than vertical, each event on
its own. Any other event, a diagonal as vertical as it is sideways included, goes to the
engine whole, so a scroll down keeps the engine's own scrolling however it drifts. An
event a pan takes while the table can scroll sideways is cancelled whole, its vertical
part with it; in a table that fits, the engine still scrolls the list by that part.
Before this rule a pan took any event with a sideways part, cancelled it while the table
could scroll sideways and scrolled the list by its vertical part by hand, so by WebKit's
rule above a scroll down that began with drift waited on the page at every event.

Deciding event by event costs two things, both only while the table can scroll sideways.
A sideways swipe whose first event comes out no more sideways than vertical is the
engine's from then on: the pan takes its later events, but none of them can be
cancelled, so the table moves under the pan too. The same holds for a swipe that begins
over another column and carries a pannable column under a still pointer. And a single
event of a sideways swipe that comes out more vertical than sideways goes to the engine
and moves the table by its sideways part: in headless WebKit, one event of 3px sideways
and 4px down among sideways ones moved the table 3px under the pan.

Not taken: holding a swipe to the pan that took it until its events stop for a while.
The page sees no gesture phases, only events and their times, so it cannot tell a
sideways flick's momentum from a scroll down begun just after it. A pan holding the
swipe would take that scroll's drift, and while the table could scroll sideways, cancel
its vertical part, which is worse than a few pixels of table under a pan.

Measured in headless WebKit (Playwright's build of WebKit 26.6). Before this rule, at a
900px window, 60 events of 30px down and 2px sideways left the summaries 120px sideways
over Message and slid a narrowed Graph column's lanes 120px, as the Graph pan had done
since it was built; and 150 events of 30px down and 1px sideways over Message dropped
about 19 frames in five seconds, against none before the Message pan, in a run that also
paid the first Message pan's per-step cost (`docs/performance-patterns.md`), so no run
separates the two. With it, the same scrolls leave both pans where they were, and in
every frame scenario probed, pans and scrolls at 1280px and 900px with the table fitting
or able to scroll sideways, neither this build nor the one before the pans had a frame
over 25ms. Whether Playwright's wheel events carry gesture phases was not checked, so
the cancelling costs above rest on the source, not on a measurement.

## Dragging it

The thumb takes `pointer-events: auto` and carries its own handlers:

- `pointerdown` on the thumb records the press and the scroller's geometry.
- `pointermove` on `window` maps the pointer's travel along the thumb's axis to `scrollTop`
  or `scrollLeft` through `dragScrollPosition()`, the inverse of `thumbGeometry()`, clamped
  at both ends.
- `pointerup` and `pointercancel` on `window` end it.
- `pointerenter` and `pointerleave` on the thumb hold and release the linger timer, so the
  thumb cannot fade out from under a cursor that is reaching for it.

Two consequences worth knowing. For the 900ms the thumb is visible, a 5px column at the
pane's right edge, or a 5px row along its bottom for a sideways thumb, belongs to the
scrollbar rather than the content beneath it, which is inseparable from making it
grabbable. And a wider grab box is not free: a thumb that is tall, because the pane barely
scrolls, will swallow clicks down its whole height.

## The trap that produced three cards

A pane that has nothing to scroll must report no scroll range, or the tracker paints a
near-full-height thumb on a list that fits.

`CommitGraph` sets `padding-top` and `padding-bottom` on `.virtual-list-viewport` for
breathing room above the first row and below the last. `VirtualList` used to size its
content from the *container's* border box, which does not account for that padding, so
`.virtual-list-content` came out taller than the content box it lives in by exactly the
padding. Every list under the graph carried a 16px scroll range it had not earned, forever.

`VirtualList` now measures the viewport's **content box**: its `clientHeight` less its own
padding. Keep it that way.

The sideways axis has its own version. The commit list's graph overlay is drawn inside the
virtual list's content and is as wide as the lanes, not the Graph column, and a hovered pill
is as wide as its whole name, so either can reach past a table that fits and hand the list a
sideways range it has not earned. `VirtualList` therefore clips its content at its own width
(`overflow-x: clip`) whenever it is given `minContentWidth`, which is also the only case in
which its viewport scrolls sideways at all. If a pane scrolls when it should not, compare
`scrollHeight - clientHeight` against that viewport's computed padding before theorising.
Two earlier passes missed this, one by looking at a 0.33px content excess that was the wrong
quantity entirely.

## Emptying a scroller destroys its position

A scroller whose content collapses to nothing has its `scrollTop` clamped to zero by the
engine, and the old value is gone. Putting taller content back does not restore it. This is
not the browser being unhelpful: there is no position to keep while there is nothing to
scroll.

So a pane that refetches must not blank itself while the replacement is in flight. Swapping
the content for a loading placeholder empties the scroller, and the reader is returned to
the top of the document. TRUNK-127 was this in the rendered markdown diff, where an
unconditional `state = { kind: "loading" }` on every fetch meant any write under the
repository sent a scrolled reader back to the top, once a minute, because Trunk's own
background fetch rewrites `FETCH_HEAD` on that timer.

The fix is to keep the current content on screen until the replacement arrives, and show a
placeholder only when there is nothing to show yet. Restoring `scrollTop` after the blank
frame is the wrong shape: it flickers, and it lands in the wrong place whenever the new
content's height differs from the old.

jsdom cannot observe the clamp, so the harness test asserts the thing that causes it — that
the pane still holds its blocks mid-refetch — rather than the scroll offset itself.

## A view that owns its scroller sits in a clipped wrapper

`DiffViewer` mounts every diff view inside one wrapper, and every view it mounts owns its own
scroller: the virtual lists, and `.rendered-diff` for rendered markdown. The wrapper is
therefore `overflow: clip`, never `auto` and never `hidden`. Two scrollers on one axis give
the wheel two places to go: when the inner one reaches its end the scroll chains to the
outer, and the whole pane slides up out of the window behind a second scrollbar, with the
wrapper's background showing beneath it. That is what TRUNK-127 looked like on screen.

`hidden` is not enough. A hidden overflow is still a scroll container, which `scrollIntoView`
and scroll chaining can move, and WebKit hands it a phantom scroll range: measured in the
running app, the wrapper reported a `scrollHeight` of the rendered pane's content height
(minus a constant) while its only child was exactly the wrapper's height and clipped its own
overflow. Toggling the wrapper's `position` made the phantom range vanish and it did not
return, so it is stale overflow the engine never recomputed. `clip` removes the scroll
container altogether, so nothing can act on that range whether or not it exists.
`DiffViewer.test.ts` pins the value.

## Testing it

jsdom computes no layout and does no hit testing, so it can answer none of the questions
that matter here. The unit suites cover what is left: the pure geometry in `thumbGeometry`
and `dragScrollPosition`, the tracker's create and remove behaviour driven by dispatched events,
and the stylesheet contract as text.

Everything else needs a real browser. `just measure` serves the real app so
`getBoundingClientRect`, `elementFromPoint` and `offsetWidth - clientWidth` answer. See
[../application-harness.md](../application-harness.md).

Two harness notes:

- `src/__tests__/helpers/virtual-list-layout.ts` fakes layout for both the commit-graph render
  goldens and the application harness, and each property has to be stubbed **by name**. Reading
  one it does not stub collapses every visible range and turns dozens of goldens red for a
  reason that has nothing to do with the graph. It measures by role rather than answering one
  number for everything: answering the viewport's height for a row too makes the list measure a
  row as tall as the viewport, which pins every visible range at 0 and makes a scrolled state
  untestable.
- A backgrounded browser tab throttles `requestAnimationFrame`, so setting `scrollTop` from
  a probe fires no `scroll` event at all. Take a screenshot to force a paint, or drive a
  real wheel scroll, before reading anything scroll-driven.
