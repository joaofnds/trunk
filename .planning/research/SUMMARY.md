# Project Research Summary

**Project:** Trunk v0.3
**Domain:** Tauri 2 desktop Git GUI — remote operations, stash management, commit context menu
**Researched:** 2026-03-10
**Confidence:** HIGH

## Executive Summary

Trunk v0.3 adds three self-contained capability groups to an existing, well-structured Tauri 2 + Svelte 5 + Rust desktop Git GUI: remote operations (push/pull/fetch), stash management (create/pop/apply/drop), and a per-commit right-click context menu (copy, checkout, branch, tag, cherry-pick, revert). The codebase already has the foundational architecture in place — the inner-fn command pattern, CommitCache mutation/emit cycle, native Tauri menu API usage, and filesystem watcher. All three feature groups extend existing patterns rather than introducing new ones, and no new Cargo crates or Tauri plugins are required.

The single most critical implementation decision — already validated in PROJECT.md — is that remote operations must shell out to the system `git` CLI rather than use libgit2's remote callbacks. libgit2's SSH agent forwarding and HTTPS credential helper integration are unreliable in GUI app contexts (SSH_AUTH_SOCK is absent when launched from Finder; git2 does not invoke OS credential helpers). All major Tauri-based Git clients (GitButler, Aho) follow the same shell-out approach. Stash operations and commit object manipulation (checkout, tag, branch-from-commit) use git2 natively via existing APIs. Cherry-pick and revert also shell out to the git CLI to avoid reimplementing git's conflict state machine.

The primary risks are: subprocess stdin blocking indefinitely when credentials are unavailable (mitigated by `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND=ssh -o BatchMode=yes`); stale CommitCache after fetch (mitigated by always running `walk_commits` + `repo-changed` emit after any mutation); and stash index instability under concurrent modifications (mitigated by keeping v0.3 stash workflow simple and documented). All pitfalls have clear, low-cost preventions that fit within the existing architecture patterns.

## Key Findings

### Recommended Stack

No new dependencies are required. The entire v0.3 feature set is covered by the existing stack: `git2 0.19.0` (libgit2 1.8.1 vendored), `tokio::process::Command` (Tauri's async runtime is already Tokio), `@tauri-apps/api/menu` (already imported and used in CommitGraph.svelte), and `navigator.clipboard.writeText()` (works in Tauri 2 WebView without a plugin). The `tauri-plugin-shell` plugin was explicitly evaluated and rejected — remote ops run from Rust Tauri commands, not from JS, so exposing shell execution to the frontend would be the wrong abstraction.

**Core technologies:**
- `std::process::Command` / `tokio::process::Command`: shell-out for remote ops — inherits SSH agent, OS credential helpers, SSH config for free; no new crate
- `git2 0.19.0`: stash save/pop/drop, checkout commit (detached HEAD), create tag — all APIs available in this version
- `@tauri-apps/api/menu` (`MenuItem`): commit row context menu — same import already used for column header menu; no new Tauri capability declaration needed
- `navigator.clipboard.writeText()`: copy SHA / copy message — no plugin needed; works in Tauri 2 WebView

**Key version notes:**
- `git2::Repository::stash_pop` signature should be confirmed on docs.rs before writing implementation (MEDIUM confidence on exact API surface)
- All other git2 APIs listed (`stash_save`, `stash_drop`, `set_head_detached`, `tag_lightweight`, `cherrypick`, `revert`) are confirmed present in libgit2 1.8.1

### Expected Features

All surveyed Git GUIs (GitKraken, Fork, Tower, GitHub Desktop, VS Code git-graph) converge on the same feature set for these three groups. The table stakes list is unambiguous and well-established.

**Must have for v0.3 (table stakes):**
- Fetch all remotes — safest remote op; universally expected; read-only
- Pull current branch — core daily workflow
- Push current branch — core daily workflow; handle "no upstream" by offering `-u origin`
- Progress feedback during remote ops — without it the app feels frozen
- Auth failure shown clearly — translate raw git stderr into actionable guidance
- Ahead/behind counts in branch sidebar — makes remote ops visible and meaningful
- Stash create (with optional name) — daily context-switch action
- Stash pop — the complement of create; without it stash is useless
- Stash apply (without drop) — all major tools include both pop and apply
- Stash drop — necessary for list hygiene
- Copy SHA / copy message — trivial to implement, high daily use
- Checkout commit (detached HEAD) — follows existing checkout pattern
- Create branch from commit — high-value; established dialog pattern
- Create tag from commit — same dialog pattern as create branch
- Cherry-pick — core power-user action; universally present in context menus
- Revert — the "safe" counterpart to cherry-pick; always paired with it

**Should have (add after v0.3 validation):**
- Stash preview on sidebar click — reuses existing DiffPanel; no new backend needed
- Push --force-with-lease — add when force-push is first requested; one-line change from `--force`
- Revert with edit message — polish pass after basic revert ships; remove `--no-edit` flag

**Defer to v0.4+:**
- Conflict resolution UI — enormous scope; explicitly deferred in PROJECT.md
- Interactive rebase — high complexity; Tower spent significant engineering on this
- Cherry-pick series (multi-select) — requires multi-select graph first
- SSH key / credential manager UI — platform-specific; multi-week scope per platform

**Anti-features to avoid:**
- In-app SSH key management — rely on system git auth; SourceTree-level scope and bugs
- HTTPS credential manager — rely on git's configured credential helper
- Force push without confirmation — always require an explicit acknowledgment dialog
- Stash include-untracked silently — makes it an explicit checkbox; default off

### Architecture Approach

The existing architecture is clean and extensible. New features slot into three established patterns: the inner-fn pattern (pure `_inner` function + `spawn_blocking` Tauri command wrapper), the cache-repopulate-before-emit pattern (rebuild `CommitCache` before emitting `repo-changed`), and the native Tauri menu pattern (`Menu.new({ items }) + menu.popup()`). Remote ops introduce one new pattern: `tokio::process::Command` (natively async, no `spawn_blocking` wrapper needed) with line-by-line stderr streaming via `app.emit("remote-progress", ...)`.

**Major components:**
1. `commands/remote.rs` (new) — `git_fetch`, `git_pull`, `git_push` using `tokio::process::Command`; emits `remote-progress` events per stderr line
2. `commands/stash.rs` (new) — `stash_save`, `stash_pop`, `stash_drop` using git2; follows inner-fn + spawn_blocking pattern
3. `commands/commit.rs` (extend) — add `checkout_commit`, `create_tag`, `cherry_pick` (shell-out), `revert_commit` (shell-out)
4. `commands/branches.rs` (extend) — add `from_oid: Option<String>` to existing `create_branch` for branch-from-commit support
5. `CommitGraph.svelte` (extend) — add `showCommitContextMenu` handler; pass `oncontextmenu` prop down to `CommitRow`
6. `BranchSidebar.svelte` (extend) — fetch/pull/push buttons + inline `remote-progress` display
7. `StagingPanel.svelte` (extend) — stash save button + stash list with pop/apply/drop per entry

**No changes needed to:** `state.rs`, `watcher.rs`, `error.rs`, `invoke.ts`, `App.svelte` (minimal at most)

### Critical Pitfalls

1. **SSH stdin blocking indefinitely** — git subprocess with no TTY blocks forever waiting for credentials that never arrive; a `spawn_blocking` thread hangs permanently. Prevention: always set `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND=ssh -o BatchMode=yes` on the child process. Use `tokio::process::Command` (natively async) rather than wrapping `std::process::Command` in `spawn_blocking`. Test before any user-facing remote op ships.

2. **CommitCache not refreshed after fetch** — remote tracking branch pills in the commit graph stay at old positions because no git2 mutation was made. Prevention: always run `walk_commits` + `cache.insert` + emit `repo-changed` after every shell-out command exits with code 0, not just after git2 mutations.

3. **Non-fast-forward push rejection shown as raw git stderr** — git's rejection output contains ANSI codes, `remote:` prefixes, and noise that is unreadable in a UI. Prevention: parse stderr for `(non-fast-forward)` / `(fetch first)` patterns; return structured `TrunkError { code: "push_rejected_non_ff" }` so the frontend can show an actionable "Pull first, then push" dialog instead of raw text.

4. **Cherry-pick/revert on merge commits produces cryptic errors** — git requires `-m mainline` for these operations on merge commits; without it the command fails with an opaque error. Prevention: disable cherry-pick and revert menu items when `commit.is_merge === true`. Use `MenuItem::new({ enabled: !commit.is_merge })`. Never silently hide — gray out so users know the action exists but is unavailable.

5. **Stash index instability** — `stash@{0}` shifts when a new stash is created; popping by numeric index after the list shifts applies to the wrong stash. Prevention: for v0.3, document and encourage single-stash workflows. For pop operations, re-verify the OID at the index matches what the user selected before executing, or scan the stash list by OID on the Rust side.

## Implications for Roadmap

Based on the dependency graph in FEATURES.md and the build order in ARCHITECTURE.md, four phases are suggested. Each group is internally self-contained; the ordering reflects risk (lowest first) and logical UX progression.

### Phase 1: Stash Operations

**Rationale:** Stash is purely local, uses git2 (no shell-out complexity), follows the established inner-fn pattern exactly, and can be tested without a remote. No new dependencies. Lowest risk. Completing stash first exercises the cache-repopulate-before-emit pattern that all subsequent phases also use.

**Delivers:** Stash create (with optional name), stash pop, stash apply, stash drop; stash list in sidebar wired to all operations; conflict detection on pop.

**Addresses:** All P1 stash features from FEATURES.md.

**Avoids:** Pitfalls 5 (staged changes behavior — document clearly in UI), 6 (index instability — guard OID match before pop), 7 (apply vs pop distinction — always use `stash_pop` for the pop action). Also requires: guard against stashing on an unborn HEAD (git2 `stash_save` requires at least one commit).

**Needs research during planning:** No — git2 stash API is well-documented; inner-fn pattern is established. Confirm `stash_pop` signature on docs.rs before writing implementation.

### Phase 2: Commit Context Menu

**Rationale:** The Tauri native menu pattern is already working in CommitGraph.svelte (column header menu). The majority of commit menu actions (copy SHA/message, checkout commit, create branch, create tag) use git2 APIs already validated in the codebase. Cherry-pick and revert shell out to the git CLI, but they share infrastructure with remote ops and are simpler (no streaming needed). Building the menu framework in this phase keeps Phase 3 focused on async streaming.

**Delivers:** Right-click context menu on every commit row; copy SHA/message (clipboard, no backend); checkout commit (detached HEAD with warning); create branch from commit (dialog with optional checkout); create tag from commit (lightweight; optional annotation message); cherry-pick (confirmation dialog + conflict detection); revert commit (confirmation dialog + conflict detection).

**Addresses:** All P1 commit context menu features from FEATURES.md.

**Avoids:** Pitfall 8 (use `menu.popup()` with no position arguments — reads OS cursor directly); Pitfall 9 (capture commit OID in local variable before calling `popup()` — OID string is immutable); Pitfalls 10/11 (disable cherry-pick and revert when `commit.is_merge === true`); Pitfall 12 (track pending operation state to prevent double-trigger on rapid right-clicks).

**Needs research during planning:** No — Tauri menu API is proven in the existing codebase. git2 APIs for checkout/tag/branch are established.

### Phase 3: Remote Operations

**Rationale:** Remote ops are the most complex feature group. They introduce a new async pattern (`tokio::process::Command` with event streaming), require careful environment configuration to prevent blocking, and cannot be unit-tested (require a real remote — integration tests with local bare repos are needed). Building last means all simpler infrastructure is in place and the shell-out pattern is already established from Phase 2.

**Delivers:** Fetch all remotes (with progress streaming); pull current branch (merge only; rebase deferred to v0.4); push current branch (with upstream auto-set for new branches); `remote-progress` Tauri event for per-line stderr output; structured error taxonomy for auth failures and non-fast-forward rejections.

**Addresses:** All P1 remote op features from FEATURES.md.

**Avoids:** Pitfall 1 (set `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND=ssh -o BatchMode=yes`, `Stdio::piped()` on all streams); Pitfall 2 (structured non-FF error code, ANSI code stripping); Pitfall 3 (SSH_AUTH_SOCK inheritance — document Finder-launch limitation for v0.3; use `launchctl getenv SSH_AUTH_SOCK` workaround if desired); Pitfall 4 (always rebuild CommitCache after fetch exits with code 0).

**Needs research during planning:** Yes — confirm `tokio::process::Command` stderr streaming pattern against the exact Tauri 2 runtime version. Plan for integration test setup (local bare repos). Verify `GIT_TERMINAL_PROMPT=0` behavior on macOS before writing tests.

### Phase 4: Ahead/Behind Counts + Progress UX Polish

**Rationale:** Ahead/behind counts in the branch sidebar complete the remote ops story — without them, fetch/pull/push have no visible effect on the sidebar. Progress UX polish (parsing git's `\r`-terminated progress lines into structured phase display) elevates the experience from functional to polished. Both are incremental additions on top of working remote ops.

**Delivers:** Ahead/behind commit counts next to each branch in sidebar (updated after fetch/pull/push); improved progress display with phase-by-phase parsing ("Counting objects", "Compressing", "Writing") rather than raw stderr lines.

**Addresses:** `ahead/behind counts` (P1 FEATURES.md), `streaming progress with parsed output` (P2 differentiator from FEATURES.md).

**Avoids:** The UX pitfall of "fetch vs pull confusion" — ahead/behind counts make the distinction visible and meaningful after each operation.

**Needs research during planning:** No — `git rev-list --count HEAD..@{u}` and `@{u}..HEAD` are standard git commands. Progress line format is stable across git versions.

### Phase Ordering Rationale

- **Stash first** because it is purely local (no auth edge cases), uses the established inner-fn/git2 pattern, and is completable in isolation
- **Context menu second** because the Tauri menu pattern is already proven; most actions use git2 (low risk); cherry-pick/revert shell-out bridges into the pattern needed for Phase 3
- **Remote ops third** because they introduce the most complexity (async streaming, credential handling, environment setup) and benefit from the team having internalized all earlier patterns
- **Polish fourth** because ahead/behind and progress parsing are incremental improvements on top of working remote ops, not prerequisites for any other phase

This ordering matches the build order specified in ARCHITECTURE.md (Stash → Context Menu → Remote Ops) with Phase 4 as an explicit polish gate before v0.3 is considered shippable.

### Research Flags

Phases needing deeper research during planning:
- **Phase 3 (Remote Operations):** Confirm `tokio::process::Command` stderr streaming approach against Tauri 2's actual runtime. Validate environment variable behavior (`GIT_TERMINAL_PROMPT`, `GIT_SSH_COMMAND`, `BatchMode`) on macOS. Plan for integration tests with local bare repos — unit tests cannot cover shell-out commands.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Stash):** git2 stash API is well-documented; inner-fn pattern is established in codebase. Only action needed: confirm `stash_pop` exact signature on docs.rs before writing implementation.
- **Phase 2 (Context Menu):** Tauri menu API is proven in production in this codebase. All git2 operations are standard. No research needed.
- **Phase 4 (Polish):** `git rev-list` count commands and git progress line format are stable and well-documented.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All decisions grounded in direct codebase inspection (Cargo.lock, package.json, capabilities/default.json, source files). No new dependencies needed — highest confidence when there is nothing to choose. |
| Features | HIGH | Based on direct analysis of mature, shipping products (GitKraken, Fork, Tower, GitHub Desktop, VS Code git-graph). Feature expectations are well-established and converge across all surveyed tools. |
| Architecture | HIGH | Derived from reading actual source files — not speculation. Integration points (CommitGraph.svelte, CommitRow.svelte, BranchSidebar.svelte, StagingPanel.svelte, commands/*.rs) are specific and concrete. |
| Pitfalls | HIGH | Pitfalls grounded in direct codebase inspection and git/Tauri API knowledge. Pitfall 3 (macOS SSH_AUTH_SOCK on Finder launch) is MEDIUM — well-known pattern but macOS-specific; needs verification at testing time. |

**Overall confidence:** HIGH

### Gaps to Address

- **`git2::stash_pop` exact signature:** Research marked MEDIUM confidence on this specific API. Before writing `stash_pop_inner`, confirm the `index: usize` parameter and `StashApplyOptions` type on docs.rs for git2 0.19.0. Cost: 15 minutes.

- **SSH_AUTH_SOCK on Finder-launched Tauri app:** Research identifies `launchctl getenv SSH_AUTH_SOCK` as the mitigation, but this is MEDIUM confidence (macOS-specific, Electron/Tauri app pattern). For v0.3, document as a known limitation rather than implementing the workaround. Validate by testing with a freshly launched `.app` bundle (not `cargo tauri dev`).

- **Ahead/behind bundling vs separate command:** The current `BranchInfo` struct has `ahead: u32, behind: u32` fields noted as always-0. Confirm during Phase 4 planning whether ahead/behind data should be bundled into the existing `list_refs` response (requires running `git rev-list` per branch) or added as a separate on-demand command to avoid slowing down the sidebar refresh.

- **`tokio::process::Command` stderr streaming spike:** The pattern is architecturally sound but should be validated with a proof-of-concept during Phase 3 planning before writing all three remote commands. A spike that streams `git fetch` stderr to the frontend via Tauri events will confirm the pattern works end-to-end.

## Sources

### Primary (HIGH confidence)
- `/Users/joaofnds/code/trunk/src-tauri/Cargo.lock` — git2 0.19.0, libgit2-sys 0.17.0+1.8.1, tauri 2.10.2 confirmed
- `/Users/joaofnds/code/trunk/src-tauri/Cargo.toml` — full dependency list; no tauri-plugin-shell
- `/Users/joaofnds/code/trunk/src-tauri/capabilities/default.json` — `core:menu:default` already declared; no new capabilities needed
- `/Users/joaofnds/code/trunk/src/components/CommitGraph.svelte` — `Menu`, `CheckMenuItem` from `@tauri-apps/api/menu` already in use with `menu.popup()` pattern (no position args)
- `/Users/joaofnds/code/trunk/.planning/PROJECT.md` — shell-out decision validated; explicit v0.3 feature list; conflict resolution deferred to v0.4+
- Existing codebase: `commands/commit.rs`, `commands/branches.rs`, `commands/repo.rs`, `state.rs`, `watcher.rs`, `CommitRow.svelte`, `App.svelte`, `lib.rs`, `types.ts`, `invoke.ts`

### Secondary (MEDIUM confidence)
- git2 stash API (`stash_save`, `stash_pop`, `stash_drop`) — training data consistent with libgit2-sys 1.8.1; recommend docs.rs confirmation before writing stash commands
- macOS SSH_AUTH_SOCK via `launchctl getenv` — known pattern in Electron/Tauri apps; not directly verified in this codebase
- GitKraken, Fork, Tower, GitHub Desktop, VS Code git-graph — direct product use; feature pages; UX behavior patterns

### Tertiary (LOW confidence)
- Cherry-pick series (multi-select) — deferred to v0.4+; no research done on multi-select graph implementation
- Ahead/behind bundling approach — standard git commands confirmed, but architecture decision (bundle vs separate command) not resolved

---
*Research completed: 2026-03-10*
*Ready for roadmap: yes*
