# Decision: what the design-system migration may change on screen

Status: **decided** (João, 2026-10-03)
Date: 2026-10-03

## TL;DR

Three calls bound the migration of the UI onto the tokens and primitives in
`docs/design-system.md`:

1. **The typeface is the system font.** `--font-sans` names no `Inter` and carries
   none of the Inter-only `font-feature-settings` tags, so Trunk renders SF, which
   the Apple HIG metrics assume.
2. **Rows keep their pixel sizes.** GitKraken, which `AGENTS.md` defers to on
   undecided UX, is not installed, so 12 versus 13px stays undecided. The migration
   changes no pixel beyond the 1px merges that fold the old sizes onto the type
   scale (9→10, 10.5→10, 12.5→12, 14→13, 16→15, 24→22) and the unitless line
   heights onto one leading per step.
3. **No scoped-CSS line-count ratchet** and no caps on `<style>` blocks.

## Consequences

A token or primitive move that changes a pixel outside those merges is a defect,
however small. A control that needs a size or look the primitive lacks gets it
added to the primitive and shown in the catalog, never a scoped override at the
call site.
