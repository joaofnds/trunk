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
| Type | `--text-<step>` with `--text-<step>--line-height`: caption 10/13, small 11/14, callout 12/15, body 13/16, title 15/20, display 22/26. `--weight-regular`, `--weight-medium`, `--weight-semibold` (400, 500, 600). `--leading-none`, `--leading-tight`, `--leading-normal` (1, 1.25, 1.5). `--tracking-wide`, `--tracking-wider`, `--tracking-widest` (0.02, 0.04, 0.08em). | The sizes and line heights are the macOS text styles Caption 1, Subheadline, Callout, Body, Title 3 and Title 1. A single-line label sets a step and that step's line height together, never a px size; an em-sized prose block or a wrapping paragraph reads a unitless `--leading-*` so the leading follows the size. and code is `--font-mono` at the step its context uses rather than a step of its own. The same test pins the scale and fails on a `--text-*` outside it. |
| Colors | the oklch ramps (`--bg-*`, `--fg-*`, `--line`, `--accent`, the status hues) and the `--color-*` roles over them | A component reads a role, never a ramp step: the role is the name the theme mapping will declare, and the step is a raw value `src/tokens.css` reads alone. The lane colors are the exception, read by the graph as `--lane-N`. Every text/background pair is in `scripts/contrast/re-audit-verify.mjs`, which `just contrast` runs inside `just check`. |
| Shadows | `--shadow-1`, `--shadow-2`, and the `--shadow-sm/md/lg` roles over them | Declared once here. A component reads one, or writes offsets with a token color. |

### Adding a token

1. Declare it in `src/tokens.css` under its group. A length is `calc(N * var(--u))`; a color is `oklch(...)` or a `color-mix(in oklch, ...)` of tokens.
2. Give it a reader in the same commit. An unread length token fails the test above.
3. A text or background color gets its pair in `scripts/contrast/re-audit-verify.mjs`, with the WCAG target it must clear.

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
a hex literal fails even in a property the plugin does not list. The type and
length plugins wait on their counts reaching zero.
