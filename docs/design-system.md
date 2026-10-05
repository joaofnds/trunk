# Design system

Where a visual value comes from, what checks that it does, and how to add one.
The vocabulary is Tailwind's and the tooling is Biome's; nothing else is
installed for this. The migration onto these tokens kept every pixel but the type
merges that `docs/decisions/2026-10-03-design-system-migration-pixels.md` lists.

## Tokens

`src/tokens.css` is the one stylesheet where a color, a length, a radius or a
shadow is written as a literal. It declares them on `:root`, grouped by role,
and every other stylesheet, a component's `<style>` block included, reads them
through `var(--...)`.

| Group | Tokens | Rule |
|-------|--------|------|
| Unit and spacing | `--u`, `--space-N` | Every length is a whole multiple of `--u` (4px). `src/app.css.test.ts` fails on one that is not, and on a length token nothing reads. |
| Chrome heights | `--bar-h`, `--row-h`, `--control-*-h`, `--banded-*-h`, `--target-min` | `--bar-h` and `--row-h` are mirrored by the constants in `src/lib/chrome-heights.ts`, which the same test holds equal. A band that paints a rule adds that rule's pixel, `calc(N * var(--u) + 1px)`. |
| Radii | `--radius`, `--radius-pill` | A pill is round, not a multiple of anything. |
| Type | `--text-<step>` with `--text-<step>--line-height`: caption 10/13, small 11/14, callout 12/15, body 13/16, title 15/20, display 22/26. `--weight-regular`, `--weight-medium`, `--weight-semibold` (400, 500, 600). `--leading-none`, `--leading-tight`, `--leading-normal` (1, 1.25, 1.5). `--tracking-wide`, `--tracking-wider`, `--tracking-widest` (0.02, 0.04, 0.08em). | The sizes and line heights are the macOS text styles Caption 1, Subheadline, Callout, Body, Title 3 and Title 1. A single-line label sets a step and that step's line height together, never a px size; an em-sized prose block or a wrapping paragraph reads a unitless `--leading-*` so the leading follows the size, and code is `--font-mono` at the step its context uses rather than a step of its own. The same test pins the scale and fails on a `--text-*` outside it. |
| Colors | the oklch ramps (`--bg-*`, `--fg-*`, `--line`, `--accent`, the status hues) and the `--color-*` roles over them | A component reads a role, never a ramp step: the role is the name the theme mapping will declare, and the step is a raw value `src/tokens.css` reads alone. The lane colors are the exception, read by the graph as `--lane-N`. Every text/background pair is in `scripts/contrast/re-audit-verify.mjs`, which `just contrast` runs inside `just check`. |
| Shadows | `--shadow-1`, `--shadow-2`, the `--shadow-sm/md/lg` roles over them, and `--shadow-hairline` | Declared once here. A component reads one, or writes offsets with a token color. `--shadow-hairline` is the 1px rule a bar paints inside its own box (`shadow-hairline` in markup), so the band keeps the height its token declares. |

### The theme

`src/theme.css` maps the tokens into Tailwind's namespaces with `@theme inline`,
one line per token, so markup reads the same vocabulary a `<style>` block does:
`bg-surface`, `text-text-muted`, `p-2`, `gap-1`, `h-row`, `h-control`,
`text-body`, `font-medium`, `font-mono`, `leading-none`, `tracking-widest`,
`shadow-lg`, `max-w-welcome`. The file holds no literal, only `var()` over a
token, and `src/theme.css.test.ts` fails on a color role, spacing step, chrome
height or text step that tokens.css declares and the theme does not map.

`inline` makes a utility carry the token's `var()` itself. Tailwind still writes
the theme variables it saw used onto `:root` inside `@layer theme`, and where a
theme key and a token share a name that line reads `--color-text:
var(--color-text)`, a cycle. It never wins: tokens.css declares its `:root`
outside every layer, and an unlayered declaration beats a layered one in the
cascade, which the same test pins by refusing an `@layer` in tokens.css.
Tailwind's `reference` modifier would stop the emission instead, but Biome's
parser takes one modifier after `@theme`, and `inline` is the one the utilities
need. A pill is `rounded-full`, which Tailwind generates without a theme value,
so `--radius-pill` has no mapping.

The block opens with `--*: initial`, which drops Tailwind's default theme. A
utility generates CSS only for a value the mapping names, so `text-sm`, `py-1.5`,
`bg-white` and the default palette emit nothing, and a class the markup spells
wrong fails `src/markup-classes.test.ts` rather than silently styling nothing.

### Runtime-set properties

A component that computes a length for a stylesheet to read, a diff view's row
heights, the split view's pan offset, the inset a markdown container pads its
prose with, hands it over as a custom property: a `style:--name` directive, or a
rule in its own `<style>`. `src/properties.css` registers each one with
`@property`, its syntax, whether it inherits and the value it holds where nothing
set it, so the read side is typed and never falls through to an invalid value. A
token has a value and belongs in `tokens.css`; a property here has none until a
component supplies one. `src/properties.css.test.ts` fails a registration
nothing sets or nothing reads, one missing a descriptor, which a browser drops
without a word, and a `style:--` directive with no registration behind it.

### Adding a token

1. Declare it in `src/tokens.css` under its group. A length is `calc(N * var(--u))`; a color is `oklch(...)` or a `color-mix(in oklch, ...)` of tokens.
2. Give it a reader in the same commit. An unread length token fails the test above.
3. A text or background color gets its pair in `scripts/contrast/re-audit-verify.mjs`, with the WCAG target it must clear.

## Primitives

`src/lib/ui/` holds the components a screen is built from. Each is plain Svelte
over the theme's utilities, with a typed variant map and no `class` or `style`
prop: a caller that needs a different look adds a variant, which the catalog
then shows, rather than overriding one call site.

| Primitive | Props | Use |
|-----------|-------|-----|
| `Button` | `variant`: `primary` (the one action a surface commits, solid accent), `secondary` (the default: outlined, neutral), `ghost` (borderless, for chrome like a close or chevron), `accent`, `danger`, `success`, `warning` (soft tinted, for an action whose tone carries meaning: stage, discard, confirm a rebase). `size`: `sm`, `md` (default), `lg`, one control height each. `icon` squares it to its height and drops the side padding; give it an `aria-label`. An `icon` button may also take `xs`, the 16px square a tab's close takes; text stays off it, since nothing needs it there and the caption line box it would take splits unevenly in 16px. `tooltip` attaches the visual tooltip. Its colors fade over the fast motion duration under the pointer, and change at once where reduced motion is preferred. Everything else (`onclick`, `disabled`, `aria-pressed`, `type`) passes through to the element, and `type` defaults to `button`. `joined` is for a button inside a `ButtonGroup`: it gives up its own frame and height to the group and rounds only the corners at the group's ends. | Every button. A pressed toggle sets `aria-pressed`, which the primitive paints. |
| `ButtonGroup` | `tone`: `neutral` (the default, one border-colored frame) or `accent` (the soft tinted sleeve around a control that is switched on). Its children are `<Button joined>`, or a control styled to the same height. | A split button (an action and the chevron that opens its other strategies), or a toggle and the selector it reveals, drawn as one control. It is a `fieldset`, which is a group to assistive tech without a `role`, and it draws the frame as an inset ring and the seams as dividers, so the buttons keep the height their token declares. |
| `LinkButton` | `tone`: `inherit` (the default: the color of the text around it), `muted`, `accent` or `danger`. The first two take the accent under the pointer and the focus ring; `accent` and `danger` keep their color and gain only the underline. `mono` sets it in the mono face, for a SHA, a path or an id. `truncate` fills its parent's width and ends an overflowing label with an ellipsis. It takes its size and weight from the text around it, so the caller sets those on the parent. Everything else passes through to the element, and `type` defaults to `button`. | A trigger that reads as text: a commit summary that jumps to the commit, a SHA that copies itself, a review title that activates it, a file ref that opens the code. It draws no frame and underlines under the pointer and the focus ring. |
| `RowAction` | `tone`: `subtle` (the default, for an action a row reveals under the pointer), `muted`, `text`, `success` or `danger`. `size`: `target` (the default) fills the minimum hit target, `compact` hugs its glyph inside a row's text line. It draws no frame and no fill, so the glyph is the whole control; give it an `aria-label`. Everything else passes through to the element, and `type` defaults to `button`. | An icon-only action on a row or a section header: the eye that hides a ref, the plus that creates a branch or stages a file. The caller decides when it shows, with the `hidden` attribute or a wrapper the row reveals. |
| `Row` | `variant`: `inset` (the default) is a rounded row held off the list's edges and `flush` one that runs to them and keeps the arrow cursor, both taking the hover color under the pointer; `header` is the bar over a section, edge to edge at the chrome-bar height, which takes none and sets no type, so its label does; `band` is the header of a panel's section, with a hairline under it; both keep their label's whole width and let their actions run off the edge when the pane is too narrow for both; `entry` is a rounded row of a list that stands alone, as tall as its label inside its padding, which takes the hover color; `title` is the surface bar with a hairline and a medium label that names the rows under it in a scrolling list, and `divider` the surface bar ruled above and below that parts two runs of them, both as tall as the frame the list's layout reserves; `item` is a row of a list or a tree at the row height, edge to edge, which takes the hover color, and `parent` the row that folds the items under it, which takes the surface color instead; `fill` takes the whole box of a frame its caller sizes and paints and pads nothing, so its children do, for a row whose height and background are computed at runtime. `tone`: `plain` (the default) and `muted`, which dims its text; `current` marks the one row that is checked out with the accent tint and stronger text, which the pointer does not change. `actions` is a snippet of `RowAction`s or `Button`s drawn at its trailing edge, beside the primary button and never inside it; put them at the snippet's top level, since a click between two actions lands on the row only when no wrapper holds them. `reveal`: `hover` (the default) shows them under the pointer or while focus is in the row and gives the label their width otherwise, `fade` shows them on the same terms while holding their width at rest, `pointer` shows them under the pointer alone, for a row that keeps the focus after a click, and `always` keeps them. `role`: `option` or `treeitem`, for a row whose list holds the focus and the keys; give that row `tabindex={-1}`, and hand the focus back to the list from `onfocus` unless the row answers Enter and Space itself, as a directory does. `selected` paints the row the list's cursor is on and sets `aria-selected`. `indent` is a length that steps the label in for a row nested in a tree. Its children are the label, laid on one line. Everything else (`onclick`, `ondblclick`, `oncontextmenu`, `aria-label`) passes through to the primary button, `type` defaults to `button`, and `tabindex` defaults to `0`, since WebKit leaves a button without one out of the Tab order and does not focus it on a click. | One row of a list whose whole width is a control: a branch or a stash in the sidebar, a recent repository on the welcome screen, a file or a directory in a file list, a conflict's header or one of its lines in the merge editor, the header that folds a file in the diff, or the header that folds its section in the sidebar or the staging panel. A right-click on an action reaches only that action, so the caller hands it the row's menu where it should open there too. |
| `ListOption` | `role`: `option` (the default, in a `role="listbox"`) or `menuitem` (in a `role="menu"`). `layout`: `row` (the default) lays its children on one line, `stack` puts each on its own. An option takes `selected`, which sets `aria-selected`, and `highlight`: `selection` (the default) paints the selected one in the selected-row color, `hover` paints it in the hover color. A menu item takes neither, since a menu has no cursor, and fills with the accent under the pointer. It fills the list's width, aligns left and takes its type from the list around it, so the caller sets the size on the listbox or menu. Everything else passes through to the element, and `type` defaults to `button`. | One row of a popup list: a file in the finder, a repository in the picker, a strategy in the pull menu. |
| `Chip` | `tone`: `accent` (the default) tints it with the accent, `neutral` with the muted tint and the border color, for a chip that sits beside the accent one. It is a pill of the small control height, set in the mono face, and its children are a glyph and the short SHA. Everything else passes through to the element, and `type` defaults to `button`. | A pill that names a commit and jumps to it: a parent or a child in the detail panel's lineage row, where the first parent is accent and a merge's other parents are neutral. |
| `GutterGrip` | It draws no frame, no fill and no type of its own, so its children, the line-number cells, are the whole control, and it keeps the pointer cursor and stays out of the text selection. It carries `data-gutter-grip`, which the row around it reads to tint itself under the pointer. Everything else (`onmousedown`, `onclick`, `onkeydown`, `aria-label`) passes through to the element, `type` defaults to `button`, and `tabindex` defaults to `0`, since WebKit leaves a button without one out of the Tab order and does not focus it on a click. | The line-number gutter of a diff line that can be selected: a press selects the line and starts a drag across lines, and Enter or Space selects it from the keyboard. A line that cannot be selected draws the same cells in a plain span. |
| `TabStrip`, `Tab` | `TabStrip` is the `role="tablist"` bar, one chrome-bar height with the hairline rule painted inside its box; give it an `aria-label`. `Tab` is one `role="tab"` button inside it: `selected` sets `aria-selected`, which paints the accent rule along its bottom edge and strengthens its label. Each tab takes an equal share of the strip in the callout step, and `disabled` drops only the pointer cursor, so the strip holds its look while the caller freezes it. `variant`: `strip` (the default) is that tab, and `framed` the target of a tab its caller frames and paints as a grid in its own `role="tablist"`: it fills the grid's one cell, lays its label on one line and ends it with an empty box as wide as an `xs` control, and lays its `trailing` snippet, one `xs` control, over that box as a sibling of the button, and it sets no type, color or focus ring of its own. It borrows no track from the frame, since WebKit does not resize a subgrid's tracks when the label's text changes. A framed tab's `tabindex` defaults to `0`, since WebKit leaves a button without one out of the Tab order and does not focus it on a click. Everything else passes through to the element, and `type` defaults to `button`. | A mode selector at the top of a panel: Commit, Amend and Stash on the commit form. Framed, a repository's tab in the tab bar, with its close beside it; events on the close do not reach the tab, so the caller hands the close what a press, a right click and a middle click on the tab do, and the focus a press gives it. Where SortableJS drags the frame, nothing inside it turns pointer events back on, since SortableJS switches them off on the copy it drags and a descendant that opts back in is hit under the pointer there. |
| `ToastCard` | `tone`: `neutral` (the default) paints it as news on the surface, `danger` as a failure in the error tint. It is a raised card of body type that fills its row, and the whole card is the button, so the message is its accessible name. Everything else passes through to the element, and `type` defaults to `button`. | A notice in the toast stack, dismissed by a click: the confirmation a push leaves, the error a failed command reports. |
| `Dialog` | `title` names the box for assistive tech and is drawn as its heading. `size`: `sm` (the default) or `md`, the width the box may grow to before its content wraps. It is modal for as long as it is mounted, so the caller shows it with an `{#if}` and takes it down from the cancel or submit it reports. Escape reaches the caller as the element's own cancel event, and a click on the backdrop closes nothing. Everything else passes through to the element. | A modal the user answers before going on: the text prompt behind a branch or tag name, the commit message editor. |
| `Splitter` | `variant`: `pane` is the strip between two panes laid side by side and `column` the one over the trailing edge of a table's header cell, both moving left and right and taking the accent under the pointer; `bar` is the strip across a panel between two parts stacked in it, moving up and down. `value`, `min` and `max` are the size in pixels of what it resizes and the limits that size moves between, told to assistive tech in whole pixels; leave `max` unset where nothing caps it. `onstep` reports the 8 pixels an arrow key along its axis moved it, positive to the right or down, and the key reaches nothing above it. `fixed` draws the same strip as a line and no control, for a state in which nothing can be resized; it takes no `value`, `min` or `onstep`. It is a `role="slider"` in the Tab order, so it requires an `aria-label` naming what it resizes, and it draws its focus ring inside its own strip. Everything else (`onmousedown`, `ondblclick`, `hidden`) passes through to the element, except `onkeydown`, which it keeps for the arrow keys. | The handle between two things that share a width or a height: the sidebar and the detail pane against the graph, a column of the graph or of the rebase editor, the rebase form in the staging panel. The caller starts the drag from the press it is handed and resizes by the step through the limits that drag has, and a key press stores what a drag's release stores. |
| `HitArea` | It fills the box its caller places it in and paints nothing. `cursor`: `pointer` or `context-menu`, and unset it keeps the cursor of what is around it. `shape`: `pill` rounds it fully and `row` takes the small radius, so the pointer follows the corners of what it covers, and unset it is a square box. It requires an `aria-label`, and its children, where it has any, keep the alignment of text outside a button. Its `tabindex` is `-1` and the caller cannot change it, so it stays out of the Tab order, and what it does must be reachable another way. `role`: unset it is a button, and `menuitem` is one action in a menu. Everything else (`onmouseenter`, `onmouseleave`, `oncontextmenu`, `ondblclick`, `onfocus`) passes through to the element, and `type` defaults to `button`. | The pointer's target over something drawn elsewhere: a ref pill and its `+N` badge in the graph's svg, each inside a `foreignObject` laid over the shape, and each ref in the two popups a hovered pill opens, the list of a commit's refs and the full name of a ref the column cut short. A press gives it the focus, so a caller whose list holds the keys hands the focus back from `onfocus`. |

A `<style>` block in a component is for what a utility cannot say: keyframes,
the graph's painting, a selector over structure (`:has`, a descendant of a
state class). It reads tokens through `var()` and the Biome plugins hold it to
that. A button, a row, a chip or a panel written in scoped CSS is a copy of a
primitive waiting to drift from it: look in `src/lib/ui/` first, and add the
variant there.

### The catalog

`src/lib/ui/Catalog.svelte` draws every token in `src/tokens.css` and every primitive on
one screen: color roles, graph lanes, the spacing scale, the type steps and weights, radius
and elevation, then each primitive in every variant and size, with its disabled and pressed
states. It reads the token names from `tokens.css` itself, so a new color, lane or space
token appears without an edit. Nothing in the app mounts it. The visual suite captures it
as its `catalog` baseline, with the text masked, so a change to a token or a primitive's
paint fails `just visual` before any screen that uses it does
(`docs/visual-regression.md`, The design catalog). To see it, start `bunx vite` and open
`/tests/visual/page/catalog.html`.

### Adding a primitive

1. Write its test first in `src/lib/ui/<Name>.test.ts`: one case per variant and size, from the DOM it renders, with `@testing-library/svelte`.
2. Build it from utilities. Keep each class string in a `const` in its script, as `Button` does: `src/markup-classes.test.ts` reads those bindings, so a class the theme cannot generate fails there.
3. Document it in the table above, and add a section to `Catalog.svelte` showing every variant and size, each label carrying `data-catalog-text`. The catalog baseline then differs; the one accepting it is the user, with `just visual-accept "<reason>"`.

## Guards

Three Biome plugins in `scripts/biome/` state, per property, the forms a value may
take. Each is an allowlist: a value that is not on it is reported as an error
pointing at this document.

| Plugin | Properties | Accepts |
|--------|------------|---------|
| `tokens-color.grit` | `color`, `background`, `background-color`, `border-*-color`, `outline-color`, `text-decoration-color`, `caret-color`, `accent-color`, `fill`, `stroke` | `var(--...)`, `transparent`, `currentColor`, `inherit`, `none`, a `color-mix(in oklch, ...)` of those, a `linear-gradient` whose stops are those. |
| `tokens-type.grit` | `font-size` | `var(--...)`, `inherit`, `0`, or an `em` (prose scales to the text it wraps). |
| | `line-height`, `letter-spacing` | `var(--...)`, `inherit`, `0`. |
| | `font-weight`, `font-family` | `var(--...)`, `inherit`. |
| | `font` | `inherit` only. The shorthand hides the scale. |
| `tokens-length.grit` | `padding*`, `margin*`, `gap`, `row-gap`, `column-gap`, `inset`, `top`, `right`, `bottom`, `left` | Up to four of: `var(--...)`, a `calc()` built only from `var(--...)`, unitless numbers and operators, `0`, `auto`, a percentage, an `em`. |
| | `border`, `border-*`, `outline` | `none`, `0`, or `<N>px solid|dashed <token color>`. |
| | `border-radius` | `var(--radius)`, `var(--radius-pill)`, `50%`, `0`, up to four of them. |
| | `box-shadow` | `none`, `var(--...)`, or layers of offsets with a token color. |

A `var()` with a fallback, `var(--x, 12px)`, is not on any list: the fallback is a
value nothing on the scale vouches for. A `--custom-property:` declaration is never
matched, so `src/tokens.css` passes every plugin.

`scripts/biome/tokens.test.ts` runs each plugin over a good and a bad fixture in
`scripts/biome/__fixtures__/` and over a Svelte component, and fails if a plugin
stops firing, fires on a compliant form, or fails to compile. A plugin that does
not compile is reported by Biome as an info and would otherwise pass silently.

A plugin is enabled in `biome.json` once no stylesheet under `src/` trips it. To
measure, write a `biome.json` listing that plugin alone, the way the test does,
and run `biome lint --config-path <that dir> src`.

`tokens-color.grit` is on, with Biome's own `style/noHexColors` beside it, so
a hex literal fails even in a property the plugin does not list. `tokens-type.grit`
is on. It reads `<style>` blocks and stylesheets, not a `style="..."` attribute in
markup or a style string built in TypeScript, so Biome's `nursery/noInlineStyles`
is on beside it, as an error, and refuses the attribute itself. A static value
goes through a utility or a `<style>` rule, where the plugins read it, and a value
computed at runtime goes through a `style:` directive, which the rule leaves alone
and `src/markup-classes.test.ts` keeps honest by failing a directive that sets a
literal. `tokens-length.grit` is on, so a length a `<style>` rule states as a
literal fails there, inside a `calc()` or a fallback included, and
`src/spacing-scale.test.ts` holds a gap, padding or margin to the spacing tokens
by name, which the plugin's `var(--...)` does not.

Biome's `nursery/noUndeclaredCustomProperties` is on, as an error. It reports a
`var(--name)` in a stylesheet, a `<style>` block or a `style="..."` attribute that
no stylesheet declares, and an `@property` registration in `src/properties.css`
counts as the declaration. A name built from an expression in markup is outside
its reach, so a property is read by its literal name in a stylesheet rule, as the
commit list's six column widths are in `CommitGraph.svelte`'s `<style>`, and
`src/properties.css.test.ts` demands the registration of every property a
`style:--` directive hands off.

`src/markup-classes.test.ts` guards the markup. It parses every component with
Svelte's compiler, loads `theme.css` into Tailwind's design system, and fails a
class attribute or class directive on any word nothing vouches for. A word is
vouched for when Tailwind generates CSS for it under the reset, when a stylesheet
declares it (the component's own `<style>`, `:global` included, or any
`src/**/*.css`), when a `.ts` file under `src/` or `tests/` or the component's own
script selects it, or when it is one of Tailwind's `group` and `peer` markers. An
arbitrary value (`text-[11px]`, `h-(--row-h)`) fails outright: declare a token and
map it. A word built from an expression is enumerated where the parser can see the
values: a literal, a template, a conditional, an `&&` or `??`, an array, an
object's keys, a `const` the component's own script binds, and a lookup into a
`const` object, which yields every value it holds. Past that, only the word's
static prefix is checked against the declared classes. The same
test fails a `style:` directive whose value is a literal, because a constant belongs
in a stylesheet rule where the token plugins read it; a `style:--name` directive
is the runtime hand-off and passes. The same test fails a control drawn in a
component outside `src/lib/ui/`: a raw `<button>`, an element whose `role` can be
`button` or `tab`, and a `<svelte:element>` whose `this` can be `button`. A `role`
or a `this` written as an expression is enumerated the way a class word is, and
one the parser cannot enumerate, a prop or a `$derived` value among them, fails
too, since it can be either. A `role` handed to a component is that component's
to draw and is not judged. A control drawn there in scoped CSS passes every other
guard while it drifts from the primitives.
