# Trunk

A fast, native desktop Git GUI. Open any repository, read its history as a commit graph, stage work, and commit without touching the terminal.

![Trunk's commit graph, branch sidebar, and commit panel](docs/screenshot.png)

## Why

Most Git GUIs feel heavy or hide what Git is doing. Trunk renders the full commit graph with virtual scrolling, so a 50k-commit history scrolls as smoothly as a tiny one. The graph topology gets computed in Rust through libgit2, not pieced together from CLI output.

## Features

- **Commit graph** with branch, tag, and stash labels and distinct merge dots
- **Staging** files or everything, then commit with a message and body
- **Diffs** for any commit, staged change, or working-tree change
- **Branches** checkout, create, merge, and rebase
- **Remotes** pull, push, and fetch
- **Stashes** create and pop
- **Interactive rebase** with a reorder-and-edit editor
- **Code review** with inline comments anchored to diff lines
- **Live updates** from a filesystem watcher that refreshes status when files change on disk

## Stack

Tauri 2 shell, Svelte 5 frontend (runes, Tailwind CSS 4), Rust backend. All Git operations run through the `git2` crate (libgit2 bindings) rather than shelling out.

## Develop

```bash
just          # list every recipe
just dev      # run Vite + Tauri in watch mode
just build    # production build
just check    # fmt, biome, svelte-check, clippy, cargo test, vitest
```

Run `just check` before you commit.

Architecture notes, decision records, and known issues live in [`docs/`](docs/README.md).

## License

MIT
