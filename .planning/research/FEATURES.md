# Feature Landscape

**Domain:** Desktop Git GUI client
**Researched:** 2026-03-03
**Confidence note:** WebSearch and WebFetch tools unavailable in this session. Analysis derived from training-data knowledge of GitKraken, Fork, Sourcetree, Tower, GitHub Desktop, and Sublime Merge — all mature products with stable feature sets as of mid-2025. Confidence is MEDIUM for table-stakes categories (well-established), LOW for specific UX micro-details.

---

## Table Stakes

Features every serious Git GUI must have. Their absence causes users to immediately dismiss the tool or return to the terminal.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Visual commit graph / history view | Every competitor has it; it is the core reason to use a GUI over `git log` | High | Lane calculation must be correct. Merge commits create multiple parents — lane merging/forking must render cleanly. Virtual scrolling required for large repos. |
| Branch list in sidebar | Users navigate repos by branches; no sidebar = no discoverability | Low | Must show local branches, remote branches, tags, and stashes at minimum. Active branch highlighted. |
| Working tree status (staged vs unstaged) | Staging is git's most fundamental operation | Medium | Must show new, modified, deleted, renamed files split into two panels. Untracked files must appear. |
| Whole-file stage / unstage | Minimum viable staging workflow | Low | Single-click to move a file from unstaged to staged or back. |
| Commit with message | Core write operation | Low | Subject line + optional body. Validation that message is non-empty before submit. |
| File diff view | Users need to see what changed before staging | Medium | Unified diff with +/- lines, line numbers, old/new side. Must handle binary files gracefully (show "Binary file"). |
| Checkout branch | Branch switching is daily work | Low | Must detect dirty workdir and surface a clear error — not silently fail. |
| Commit detail view | Clicking a commit in the graph must show what changed | Medium | Show author, date, SHA, message, parent SHAs, and the full file diff for that commit. |
| Open repository from disk | Entry point to the app | Low | Native file-picker dialog to select a repo folder. Validate it is actually a git repo. |
| Auto-refresh on external changes | Terminal and IDE activity happens alongside the GUI | Medium | Filesystem watch + debounce. Users expect the UI to reflect reality without manual refresh. |
| Dark and light theme | Developers work in both environments | Low | Dark default is fine for v0.1; light theme can come later, but the theming architecture must support it. |

---

## Differentiators

Features that are present in some — but not all — competitors, and that users praise loudly when done well.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Performance at scale | Repos with 100k+ commits expose slowness in GitKraken and Sourcetree; Fork and Sublime Merge are praised for staying fast | High | This is Trunk's primary differentiator opportunity. Rust lane algorithm + virtual scrolling addresses it. |
| Hunk-level staging | Users frequently want to stage only part of a file | High | Not in v0.1 scope per PROJECT.md — but absence will be noticed by power users. Plan for v0.2+. |
| Inline diff in staging panel | See the diff without switching panels | Medium | Fork does this well. Instead of two separate views, diff appears inline when file is selected in staging area. |
| Clean, uncluttered UI | GitKraken grew bloated with subscription banners and AI upsells; Tower is praised for restraint | Medium | Directly available to an indie/open-source tool without monetization pressure. |
| Native feel | Electron-based GUIs (GitKraken, Sourcetree) feel heavy; Fork and Tower (native Swift/AppKit) feel snappy | High | Tauri/Rust architecture directly enables this. Load time and memory usage are differentiators. |
| Keyboard-driven navigation | Power users want shortcuts for everything | Medium | Can be added incrementally. At minimum: arrow keys in graph, Enter for commit, Escape to cancel. |
| Search / filter commits | Filter history by author, message, file path | Medium | Not day-one, but absence is felt in medium-to-large repos. |
| Stash management (create/pop) | Stash is a daily workflow item for many devs | Medium | Sidebar listing is in v0.1 scope; create/pop deferred. Users will notice the gap. |
| Multi-repo tabs | Working across multiple repos simultaneously | High | Tabs visible in v0.1 but non-functional per PROJECT.md. Architecture must support it from the start. |
| Conflict resolution UI | 3-way merge tool or at minimum visual conflict marker highlighting | Very High | Deliberately deferred to v0.3+. This is a differentiator because doing it well is rare. |

---

## Anti-Features

Features to deliberately NOT build in v0.1 — either because they create complexity that will slow the foundation, or because they are not necessary for the core experience.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Push / Pull / Fetch UI | Remote auth (SSH, HTTPS, tokens, keychain) is a deep surface that must be done correctly or it fails for many users | Defer to v0.2. Show a clear "remote operations coming soon" placeholder. Do not ship broken push. |
| Settings / Preferences panel | Settings require infrastructure (persistence, schema, migration) that distracts from core features | Use sensible hardcoded defaults in v0.1. Design the config layer early but expose no UI until v1.0. |
| AI-generated commit messages | Fashionable but divisive. Requires API key management, adds latency, and means nothing for a dev tool judged on reliability | Add only after the core workflow is polished and users ask for it. |
| Merge / Rebase UI | Correctness is hard. A buggy merge tool destroys user trust permanently | Defer to v0.3. Let users fall back to terminal for these operations. |
| Syntax highlighting in diffs | Nice but expensive to implement correctly (tree-sitter or similar). Adds visual noise if done poorly | Plain `+/-` colored diffs are universally readable. Defer to v0.3. |
| Auto-update mechanism | Requires code signing infrastructure, notarization (macOS), and a release pipeline | Ship as a zip/dmg with manual update in v0.1. Add Sparkle or similar for v1.0. |
| Built-in terminal emulator | Adds enormous complexity (PTY, shell integration) and competes with users' existing terminals | Not a Git GUI's job. Open Terminal at repo root is sufficient and is what Tower does. |
| GitHub/GitLab/Bitbucket integration (PR UI, issues) | GitKraken's integration is its biggest complexity and subscription driver | Focus on the git data layer. Remote forge UI is a v1.x feature. |
| Undo/Redo stack | Requires wrapping every mutation in a command pattern. Critical to get right — partial undo is worse than none | Defer until the mutation surface (merge, rebase, amend) is stable enough to reason about. |
| Commit signing (GPG/SSH) | Requires keychain integration and UI for key selection | Defer to v1.0. Not a day-one concern for most users. |

---

## Feature Dependencies

```
Open repository
  → Show commit graph (requires repo open)
      → Click commit → Show commit detail + diff
      → Checkout branch (requires commit/branch selected)
          → Dirty-workdir error handling (blocking checkout requires error UI)

Show working tree status
  → Stage file (requires status list)
      → Unstage file (requires staged list)
          → Create commit (requires at least one staged file)
              → Commit appears in graph (requires graph to refresh)

Filesystem watch
  → Auto-refresh status (requires watch events)
  → Auto-refresh graph (same watch events, different handler)

Branch sidebar
  → Checkout branch (sidebar is the navigation entry point)
  → Display remote branches (requires fetch data — deferred)
```

---

## MVP Recommendation

For a v0.1 that developers will take seriously, prioritize in this order:

**Must ship:**
1. Open repository — nothing works without it
2. Commit graph with visual lanes — this is the "wow" moment that earns trust
3. Branch sidebar (read-only: list local, remote, tags, stashes) — navigation foundation
4. Working tree status panel (staged / unstaged split) — staging workflow entry
5. Whole-file stage and unstage — minimum viable write operation
6. File diff view (workdir, staged, commit) — confidence before staging
7. Create commit with subject + body — completing the write loop
8. Commit detail view (metadata + full diff on click) — history exploration
9. Checkout branch with dirty-workdir error handling — daily workflow
10. Filesystem watch + auto-refresh — makes the app feel alive and trustworthy

**Defer with acknowledgment:**
- Hunk staging — note in README that it is coming. Users will accept this if the whole-file workflow is fast.
- Remote operations (push/pull/fetch) — a clear "coming in v0.2" message prevents frustration.
- Stash create/pop — listing stashes is enough for v0.1.
- Multi-repo tabs — show the tab bar so the architecture is visible, but non-functional tabs are fine.

**Do not defer quietly:**
- Dirty-workdir error handling for checkout — users WILL hit this on day one and an unhandled error destroys trust faster than any missing feature.
- Binary file handling in diffs — attempting to render binary data as text is a crash/hang risk.
- Large repo performance — if the first repo a user opens has 50k commits and the graph hangs for 10 seconds, the tool is dead. The Rust lane algorithm and virtual scrolling must be correct from the start.

---

## Competitive Positioning Observations

| Tool | Strength | Weakness | Lesson for Trunk |
|------|----------|----------|-----------------|
| GitKraken | Feature breadth, PR integration | Electron bloat, subscription upsell noise, slow on large repos | Do less, do it faster. Native feel is worth more than feature count. |
| Fork | Speed, clean UI, inline diffs | macOS/Windows only, paid (one-time) | Target the same user: pragmatic dev who pays for good tools. Match Fork's speed bar. |
| Sourcetree | Free, Atlassian integration | Slow, buggy on macOS, dated UI | Being free is not enough if it feels broken. Quality > free. |
| Tower | Polish, keyboard shortcuts, training resources | $69/year subscription, steep | Match the UI polish level without the subscription model. |
| GitHub Desktop | Extremely simple, GitHub-focused | No visual graph, no staging control, GitHub-only | Trunk is for developers who have outgrown GitHub Desktop. That is the upgrade path. |
| Sublime Merge | Speed, syntax highlighting, keyboard-first | Niche, limited branch management UI | Syntax-highlighted diffs are the one feature worth aspiring to (v0.3+). |

---

## Sources

- Training-data knowledge of GitKraken, Fork, Sourcetree, Tower, GitHub Desktop, Sublime Merge feature sets as of mid-2025 — MEDIUM confidence
- Project context from `.planning/PROJECT.md` for scoping decisions — HIGH confidence (primary source)
- Competitive landscape patterns are well-established across multiple years of community discussion — MEDIUM confidence

**Note:** Web research tools were unavailable during this session. Feature lists for each competitor should be spot-checked against their official feature pages before the roadmap is finalized. The table-stakes categorization is highly stable (unlikely to change). The differentiator categorization reflects community sentiment patterns that may have shifted if any competitor shipped major features after August 2025.
