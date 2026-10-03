---
paths:
  - "src/**/*.svelte"
  - "src/**/*.css"
---

# UI rules

`docs/design-system.md` owns these rules and the guards behind them. This file
repeats its Tokens and Primitives sections for a session with a Svelte or CSS file
open, so a change there is a change here.

- Write markup with the theme's utilities. Where no utility says a static value,
  write a `<style>` rule that reads a token through `var()`, and where no token
  holds the value, declare it in `src/tokens.css` and map it in `src/theme.css`,
  because a literal in markup or in a rule is what the guards reject.
- Set a value computed at runtime with a `style:` directive. Hand one to another
  stylesheet as a `style:--name` directive, or as a rule in the component's own
  `<style>`, and register the name in `src/properties.css`.
- Before writing a `<button>`, a link styled as one, or a `<dialog>` outside
  `src/lib/ui`, use the primitive there, and extend it and its entry in
  `src/lib/ui/Catalog.svelte` when a variant is missing, because no check sees
  every shape a control can take, and one drawn without a primitive drifts from
  its frame, size and focus ring and is what the next session copies.
