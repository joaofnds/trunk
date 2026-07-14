---
title: Markdown Rendering Test
author: trunk
tags:
  - rendering
  - fixture
metadata:
  purpose: exercise every markdown feature the renderer supports
  note: this front matter block should render as a GitHub-style table
---

# Markdown Rendering Test Fixture

This file exists to exercise the **Source ↔ Rendered** toggle and every markdown
feature the renderer supports. Open it in the diff view and flip the toggle. Edit
a section and switch to **Hunk** mode to confirm only the changed hunks render.

## Inline formatting

Regular text with **bold**, _italic_, ***bold italic***, ~~strikethrough~~, and
`inline code`. A footnote-free [external link](https://example.com) (clicking it
should open your browser, not navigate the app) and an [auto link](https://svelte.dev).

## Headings

### Level 3 heading

#### Level 4 heading

##### Level 5 heading

## Lists

Unordered:

- First item
- Second item
  - Nested item
  - Another nested item
- Third item

Ordered:

1. Step one
2. Step two
3. Step three

Task list (static checkboxes):

- [x] Completed task
- [ ] Pending task
- [x] Another done item

## Blockquote

> This is a blockquote. It should render with a left border and muted text.
>
> Second paragraph inside the quote.

## Table

| Feature      | Status | Notes                        |
| ------------ | ------ | ---------------------------- |
| Headings     | ✅     | h1–h6                        |
| Code fences  | ✅     | syntax highlighted           |
| Task lists   | ✅     | static, both states          |
| Images       | ✅     | local (trunk-asset) + remote |

## Code fences (syntax highlighting)

Rust — colors should match the diff view's Rust highlighting:

```rust
fn main() {
    let greeting = "hello, world";
    println!("{greeting}");
}
```

TypeScript:

```typescript
export function add(a: number, b: number): number {
  return a + b;
}
```

Python:

```python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

Unknown language (should render as plain, escaped text — no highlighting):

```notalang
a < b && c > d
```

## Images

Local image (resolved via the `trunk-asset://` protocol, relative to this file):

![Trunk screenshot](screenshot.png)

Remote image (loaded over https, untouched):

![Placeholder](https://placehold.co/120x40/png)

## Horizontal rule

---

That's everything. If the front matter above shows as a table, fences are colored,
the local image loads, task-list checkboxes appear, and the external link opens in
your browser, the renderer is working end to end.
