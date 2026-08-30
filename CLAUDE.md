# Trunk

Desktop Git GUI — Tauri 2 + Svelte 5 + Rust.

## Commands

```bash
just              # List all recipes
just dev          # Vite dev + Tauri watch
just build        # Production build
just quick        # Static only: fmt, biome, svelte-check (~3s)
just front        # biome, svelte-check, vitest (~14s)
just rust         # fmt, clippy, cargo-test (~12s; longer after an edit)
just check        # Run ALL checks (fmt, biome, svelte-check, clippy, cargo-test, vitest, graph-sweep-check)
just audit        # Dependency advisories (cargo-audit + bun audit)
just mutants      # Which mutations the Rust tests miss (slow, opt-in)
```

While working, run the narrowest tier that covers what you touched — `quick` for
a static sweep, `front` or `rust` for one side of the app. Run the full `just
check` before every commit and push.

`audit` and `mutants` are not part of `check`: advisories need the network and
mutation runs take minutes. CI mirrors each `check` recipe as its own job, and
the `check-parity` job fails if that list and the workflow drift apart.

## Stack

- **Frontend:** Svelte 5 (runes: `$state`, `$derived`), Vite 8, TypeScript 6.0 strict, Tailwind CSS 4
- **Backend:** Tauri 2, git2 0.21 (libgit2), notify 8 (fs watcher), tokio 1
- **Frontend→Backend:** `invoke("command_name", args)` calls Rust `#[tauri::command]` fns
- **Paths:** `$lib` → `src/lib`, commands in `src-tauri/src/commands/`

## Rules

- When a UX or Git-semantics detail is undecided, behave like GitKraken (João, 2026-08-30)
- Never inline colors — always use CSS custom properties from the theme
- Never fight layout with positioning hacks — use grid/flexbox so elements flow naturally
- All git operations go through git2 crate, no shelling out (except GIT_EDITOR for rebase/merge message editing)
- Trunk-based: commit directly to `main`. Never auto-create a feature branch when asked to commit (overrides the harness default). Only branch when explicitly asked (e.g. a PR branch). Keep working artifacts (`.boris/`) out of code commits — `.gitignore` already excludes them.
- The commit-graph pipeline carries binding rules in `.claude/rules/commit-graph.md`. It auto-loads **only** on a Read-tool read of a file in its `paths:` list — no other route is known to trigger it, and Bash `grep`/`sed`/`cat` is confirmed not to (CLI 2.1.220, 2026-08-03; re-verify after a CLI bump). If you are working the graph pipeline and have not Read-opened one of those files, open the rule file yourself. Its `paths:` list is the loader trigger, not a description of the pipeline — it is deliberately a wider set than the File Map in `docs/architecture/commit-graph.md` (ruling 2026-08-12). Adding **or removing** a pipeline stage or a graph test suite means editing both; anything else that should load the rule means editing `paths:` only. The rule file's §Binding rules states the split in full.

## Planning artifacts

Working artifacts live in `.boris/`, which is gitignored. They are per-task and local:

| Path | Holds |
|------|-------|
| `.boris/CONTEXT.md` | Project glossary — shared vocabulary for specs and plans |
| `.boris/plans/` | Specs, options, grilled designs, and implementation plans |
| `.boris/reviews/` | Panel and adversarial review reports |
| `.boris/handoffs/` | Mid-task context dumps |
| `.boris/archive/` | Plans whose work has shipped |

Durable material is committed under `docs/` instead — see `docs/README.md` for the index.
When a `.boris/` artifact turns out to be a lasting reference (an architecture note, a
decision record, a known issue), move it into `docs/` and add it to that index.

This project used GSD (`/gsd:*`) through v0.14. Its `.planning/` tree was retired on
2026-08-02; everything not carried into `docs/` is readable at `git show 5fd4683:.planning/…`.

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.50.1 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**For every user request in this project, run `backlog instructions overview` before answering or taking action.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->
