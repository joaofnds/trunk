# Design system

Where a visual value comes from, what checks that it does, and how to add one.
The vocabulary is Tailwind's and the tooling is Biome's; nothing else is
installed for this.

## Tokens

`src/tokens.css` is the one stylesheet where a color, a length, a radius or a
shadow is written as a literal. It declares them on `:root`, grouped by role,
and every other stylesheet, a component's `<style>` block included, reads them
through `var(--...)`.

| Group | Tokens | Rule |
|-------|--------|------|
| Unit and spacing | `--u`, `--space-N` | Every length is a whole multiple of `--u` (4px). `src/app.css.test.ts` fails on one that is not, and on a length token nothing reads. |
| Chrome heights | `--bar-h`, `--row-h`, `--control-*-h`, `--banded-*-h`, `--target-min` | Mirrored by the constants in `src/lib/chrome-heights.ts`, which the same test holds equal. A band that paints a rule adds that rule's pixel, `calc(N * var(--u) + 1px)`. |
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
| `Button` | `variant`: `primary` (the one action a surface commits, solid accent), `secondary` (the default: outlined, neutral), `ghost` (borderless, for chrome like a close or chevron), `accent`, `danger`, `success`, `warning` (soft tinted, for an action whose tone carries meaning: stage, discard, confirm a rebase). `size`: `sm`, `md` (default), `lg`, one control height each. `icon` squares it to its height and drops the side padding; give it an `aria-label`. `tooltip` attaches the visual tooltip. Everything else (`onclick`, `disabled`, `aria-pressed`, `type`) passes through to the element, and `type` defaults to `button`. `joined` is for a button inside a `ButtonGroup`: it gives up its own frame and height to the group and rounds only the corners at the group's ends. | Every button. A pressed toggle sets `aria-pressed`, which the primitive paints. |
| `ButtonGroup` | `tone`: `neutral` (the default, one border-colored frame) or `accent` (the soft tinted sleeve around a control that is switched on). Its children are `<Button joined>`, or a control styled to the same height. | A split button (an action and the chevron that opens its other strategies), or a toggle and the selector it reveals, drawn as one control. It draws the frame as an inset ring and the seams as dividers, so the buttons keep the height their token declares. |
| `LinkButton` | `tone`: `inherit` (the default: the color of the text around it), `muted`, `accent` or `danger`. The first two take the accent under the pointer and the focus ring; `accent` and `danger` keep their color and gain only the underline. `mono` sets it in the mono face, for a SHA, a path or an id. `truncate` fills its parent's width and ends an overflowing label with an ellipsis. It takes its size and weight from the text around it, so the caller sets those on the parent. Everything else passes through to the element, and `type` defaults to `button`. | A trigger that reads as text: a commit summary that jumps to the commit, a SHA that copies itself, a review title that activates it, a file ref that opens the code. It draws no frame and underlines under the pointer and the focus ring. |

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
| `tokens-length.grit` | `padding*`, `margin*`, `gap`, `row-gap`, `column-gap`, `inset`, `top`, `right`, `bottom`, `left` | Up to four of: `var(--...)`, a `calc()` over one, `0`, `auto`, a percentage, an `em`. |
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
markup or a style string built in TypeScript, so those sites are unguarded until
they move to `style:` directives. The length plugin waits on its count reaching
zero.

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
is the runtime hand-off and passes.
