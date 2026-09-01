# Scrollbars

Every scroller in the app hides its native scrollbar and gets a themed thumb painted from
JavaScript instead. The reason is layout, not taste, and the rule that forces it is easy to
re-derive wrongly.

## The pieces

| File | Holds |
|---|---|
| `src/app.css` | `::-webkit-scrollbar { display: none }`, applied to everything, and the `.scrollbar-overlay-thumb` class the tracker paints. |
| `src/lib/scrollbar-activity.ts` | The tracker. One capture-phase `scroll` listener covers every scroller in the app, creates and positions the thumb, and runs the drag. |
| `src/lib/app-services.ts` | Wires the tracker once, at startup. |
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

## Dragging it

The thumb takes `pointer-events: auto` and carries its own handlers:

- `pointerdown` on the thumb records the press and the scroller's geometry.
- `pointermove` on `window` maps the pointer's travel to `scrollTop` through
  `dragScrollTop()`, the inverse of `thumbGeometry()`, clamped at both ends.
- `pointerup` and `pointercancel` on `window` end it.
- `pointerenter` and `pointerleave` on the thumb hold and release the linger timer, so the
  thumb cannot fade out from under a cursor that is reaching for it.

Two consequences worth knowing. For the 900ms the thumb is visible, a 5px column at the
pane's right edge belongs to the scrollbar rather than the content beneath it, which is
inseparable from making it grabbable. And a wider grab box is not free: a thumb that is
tall, because the pane barely scrolls, will swallow clicks down its whole height.

## The trap that produced three cards

A pane that has nothing to scroll must report no scroll range, or the tracker paints a
near-full-height thumb on a list that fits.

`CommitGraph` sets `padding-top` and `padding-bottom` on `.virtual-list-viewport` for
breathing room above the first row and below the last. `VirtualList` used to size its
content from the *container's* border box, which does not account for that padding, so
`.virtual-list-content` came out taller than the content box it lives in by exactly the
padding. Every list under the graph carried a 16px scroll range it had not earned, forever.

`VirtualList` now measures the viewport's **content box**: its `clientHeight` less its own
padding. Keep it that way. If a pane scrolls when it should not, compare
`scrollHeight - clientHeight` against that viewport's computed padding before theorising.
Two earlier passes missed this, one by looking at a 0.33px content excess that was the wrong
quantity entirely.

## Testing it

jsdom computes no layout and does no hit testing, so it can answer none of the questions
that matter here. The unit suites cover what is left: the pure geometry in `thumbGeometry`
and `dragScrollTop`, the tracker's create and remove behaviour driven by dispatched events,
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
