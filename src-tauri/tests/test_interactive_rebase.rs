mod common;

use common::context::TestContext;
use trunk_lib::commands::interactive_rebase::{RebaseAction, RebaseStartResult, RebaseTodoAction};

/// Helper to create a repo with 3 linear commits and return the OIDs.
fn make_three_commit_ctx() -> (TestContext, Vec<git2::Oid>) {
    let ctx = TestContext::builder()
        .with_file("file.txt", "initial")
        .with_commit("Initial commit")
        .with_file("file.txt", "second")
        .with_commit("Second commit")
        .with_file("file.txt", "third")
        .with_commit("Third commit")
        .build();

    let repo = ctx.repo();
    let mut revwalk = repo.revwalk().unwrap();
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)
        .unwrap();
    revwalk.push_head().unwrap();
    let oids: Vec<git2::Oid> = revwalk.map(|r| r.unwrap()).collect();

    (ctx, oids)
}

/// The machine running this may sign commits by default; a rebase that shells out to
/// `git` would then try to sign every rewritten commit. Local config wins over global.
fn without_commit_signing(ctx: &TestContext) {
    let repo = ctx.repo();
    let mut cfg = repo.config().unwrap();
    cfg.set_bool("commit.gpgsign", false).unwrap();
}

/// Commits oldest-first, so `oids[0]` is the root.
fn oids_oldest_first(ctx: &TestContext) -> Vec<git2::Oid> {
    let repo = ctx.repo();
    let mut revwalk = repo.revwalk().unwrap();
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)
        .unwrap();
    revwalk.push_head().unwrap();
    revwalk.map(|r| r.unwrap()).collect()
}

/// Commit summaries reachable from HEAD, newest first.
fn summaries_newest_first(ctx: &TestContext) -> Vec<String> {
    let repo = ctx.repo();
    let mut revwalk = repo.revwalk().unwrap();
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL).unwrap();
    revwalk.push_head().unwrap();
    revwalk
        .map(|r| {
            repo.find_commit(r.unwrap())
                .unwrap()
                .summary()
                .ok()
                .flatten()
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

fn full_message_of_head(ctx: &TestContext) -> String {
    let repo = ctx.repo();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    head.message().unwrap_or("").to_string()
}

fn todo(oid: git2::Oid, action: RebaseAction, new_message: Option<&str>) -> RebaseTodoAction {
    RebaseTodoAction {
        oid: oid.to_string(),
        action,
        new_message: new_message.map(str::to_string),
    }
}

/// Five commits, each touching its own file, so nothing conflicts.
fn five_commit_ctx() -> (TestContext, Vec<git2::Oid>) {
    let ctx = TestContext::builder()
        .with_file("f1.txt", "one")
        .with_commit("First commit")
        .with_file("f2.txt", "two")
        .with_commit("Second commit")
        .with_file("f3.txt", "three")
        .with_commit("Third commit")
        .with_file("f4.txt", "four")
        .with_commit("Fourth commit")
        .with_file("f5.txt", "five")
        .with_commit("Fifth commit")
        .build();
    without_commit_signing(&ctx);
    let oids = oids_oldest_first(&ctx);
    (ctx, oids)
}

#[test]
fn a_squash_without_a_message_does_not_steal_the_next_rewords_message() {
    let (ctx, oids) = five_commit_ctx();

    ctx.start_interactive_rebase(
        Some(&oids[0].to_string()),
        &[
            todo(oids[1], RebaseAction::Pick, None),
            todo(oids[2], RebaseAction::Squash, None),
            todo(oids[3], RebaseAction::Reword, Some("Reworded fourth")),
            todo(oids[4], RebaseAction::Pick, None),
        ],
    )
    .expect("rebase should complete");

    let summaries = summaries_newest_first(&ctx);
    assert_eq!(
        summaries[1], "Reworded fourth",
        "the reworded commit must get the message the user typed for it, got {summaries:?}"
    );
    assert_eq!(
        summaries[2], "Second commit",
        "a squash with no new message keeps git's combined default, got {summaries:?}"
    );
}

#[test]
fn a_squash_run_does_not_leave_a_message_behind_for_a_later_reword() {
    let (ctx, oids) = five_commit_ctx();

    ctx.start_interactive_rebase(
        Some(&oids[0].to_string()),
        &[
            todo(oids[1], RebaseAction::Pick, None),
            todo(oids[2], RebaseAction::Squash, Some("Combined A")),
            todo(oids[3], RebaseAction::Squash, Some("Combined B")),
            todo(oids[4], RebaseAction::Reword, Some("Reworded fifth")),
        ],
    )
    .expect("rebase should complete");

    let summaries = summaries_newest_first(&ctx);
    assert_eq!(
        summaries[0], "Reworded fifth",
        "the reword must get its own message, not a leftover from the squash run, got {summaries:?}"
    );
    assert_eq!(
        summaries[1], "Combined B",
        "one squash run produces one message — the last one the user edited, got {summaries:?}"
    );
}

#[test]
fn a_message_survives_a_conflict_and_lands_when_the_rebase_continues() {
    // Every commit rewrites the same file, so omitting one makes the next conflict.
    let ctx = TestContext::builder()
        .with_file("g.txt", "one\n")
        .with_commit("G1 commit")
        .with_file("g.txt", "two\n")
        .with_commit("G2 commit")
        .with_file("g.txt", "three\n")
        .with_commit("G3 commit")
        .with_file("g.txt", "four\n")
        .with_commit("G4 commit")
        .build();
    without_commit_signing(&ctx);
    let oids = oids_oldest_first(&ctx);

    // G2 is dropped, so G3 cannot apply cleanly.
    ctx.start_interactive_rebase(
        Some(&oids[0].to_string()),
        &[
            todo(oids[1], RebaseAction::Drop, None),
            todo(oids[2], RebaseAction::Pick, None),
            todo(
                oids[3],
                RebaseAction::Reword,
                Some("Reworded after the conflict"),
            ),
        ],
    )
    .expect("a conflicted rebase reports the pause, not an error");

    assert!(
        ctx.repo().path().join("rebase-merge").exists(),
        "the rebase should be paused on the conflict"
    );

    {
        let repo = ctx.repo();
        std::fs::write(repo.workdir().unwrap().join("g.txt"), "three\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("g.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.rebase_continue(None).expect("continue should finish");

    let summaries = summaries_newest_first(&ctx);
    assert_eq!(
        summaries[0], "Reworded after the conflict",
        "a message queued before the conflict must still be applied afterwards, got {summaries:?}"
    );
}

#[test]
fn a_skipped_commit_does_not_hand_its_message_to_another_commit() {
    // G4 re-applies G2's content, so dropping G3 makes it an empty pick.
    let ctx = TestContext::builder()
        .with_file("a.txt", "base\n")
        .with_commit("E1 commit")
        .with_file("z.txt", "one\n")
        .with_commit("E2 commit")
        .with_file("z.txt", "two\n")
        .with_commit("E3 commit")
        .with_file("z.txt", "one\n")
        .with_commit("E4 commit")
        .build();
    without_commit_signing(&ctx);
    let oids = oids_oldest_first(&ctx);

    ctx.start_interactive_rebase(
        Some(&oids[0].to_string()),
        &[
            todo(oids[1], RebaseAction::Pick, None),
            todo(oids[2], RebaseAction::Drop, None),
            todo(oids[3], RebaseAction::Reword, Some("Reworded fourth")),
        ],
    )
    .expect("an empty pick reports the pause, not an error");

    ctx.rebase_skip().expect("skip should finish the rebase");

    let summaries = summaries_newest_first(&ctx);
    assert!(
        !summaries.contains(&"Reworded fourth".to_string()),
        "a skipped commit's message must not land on any other commit, got {summaries:?}"
    );
    assert_eq!(
        summaries[0], "E2 commit",
        "the commit before the skipped one keeps its own message, got {summaries:?}"
    );
}

#[test]
fn a_squash_with_no_message_anywhere_keeps_gits_combined_default() {
    let (ctx, oids) = five_commit_ctx();

    ctx.start_interactive_rebase(
        Some(&oids[0].to_string()),
        &[
            todo(oids[1], RebaseAction::Pick, None),
            todo(oids[2], RebaseAction::Squash, None),
            todo(oids[3], RebaseAction::Drop, None),
            todo(oids[4], RebaseAction::Drop, None),
        ],
    )
    .expect("rebase should complete");

    let message = full_message_of_head(&ctx);
    assert!(
        message.contains("Second commit") && message.contains("Third commit"),
        "both original messages belong in the combined default, got {message:?}"
    );
}

#[test]
fn get_rebase_todo_returns_commits_oldest_first() {
    let (ctx, oids) = make_three_commit_ctx();
    let base_oid = oids[0].to_string();

    let items = ctx.get_rebase_todo(&base_oid, false).unwrap().items;

    assert_eq!(items.len(), 2, "Should return 2 commits (excluding base)");
    assert_eq!(
        items[0].summary, "Second commit",
        "First item should be oldest (Second commit)"
    );
    assert_eq!(
        items[1].summary, "Third commit",
        "Second item should be newest (Third commit)"
    );
}

#[test]
fn get_rebase_todo_inclusive_includes_base_commit() {
    let (ctx, oids) = make_three_commit_ctx();
    let base_oid = oids[1].to_string(); // Second commit

    let items = ctx.get_rebase_todo(&base_oid, true).unwrap().items;

    assert_eq!(items.len(), 2, "Should return 2 commits (including base)");
    assert_eq!(
        items[0].summary, "Second commit",
        "Base commit should be included"
    );
    assert_eq!(items[1].summary, "Third commit");
}

#[test]
fn get_rebase_todo_returns_empty_when_base_equals_head() {
    let (ctx, oids) = make_three_commit_ctx();
    let base_oid = oids[2].to_string(); // HEAD commit as base

    let items = ctx.get_rebase_todo(&base_oid, false).unwrap().items;

    assert_eq!(
        items.len(),
        0,
        "Should return empty vec when base equals HEAD"
    );
}

#[test]
fn get_rebase_todo_item_has_correct_fields() {
    let (ctx, oids) = make_three_commit_ctx();
    let base_oid = oids[0].to_string();

    let items = ctx.get_rebase_todo(&base_oid, false).unwrap().items;

    let item = &items[0];
    assert_eq!(
        item.oid,
        oids[1].to_string(),
        "OID should match second commit"
    );
    assert_eq!(
        item.short_oid,
        &oids[1].to_string()[..7],
        "short_oid should be first 7 chars"
    );
    assert_eq!(item.summary, "Second commit");
    assert_eq!(item.author_name, "Test User");
    assert!(
        item.author_timestamp > 0,
        "author_timestamp should be positive"
    );
}

#[test]
fn get_fork_point_returns_merge_base() {
    let (ctx, oids) = make_three_commit_ctx();

    // Create a branch at the initial commit
    {
        let repo = ctx.repo();
        let initial_commit = repo.find_commit(oids[0]).unwrap();
        repo.branch("feature", &initial_commit, false).unwrap();
    }

    let result = ctx.get_fork_point("feature").unwrap();

    assert_eq!(
        result,
        oids[0].to_string(),
        "Fork point should be the initial commit (merge-base of feature and HEAD)"
    );
}

#[test]
fn an_inclusive_todo_resolves_its_base_to_the_clicked_commits_parent() {
    let (ctx, oids) = make_three_commit_ctx();

    let todo = ctx.get_rebase_todo(&oids[1].to_string(), true).unwrap();

    assert_eq!(todo.base_oid, Some(oids[0].to_string()));
    assert_eq!(
        todo.items
            .iter()
            .map(|i| i.summary.as_str())
            .collect::<Vec<_>>(),
        vec!["Second commit", "Third commit"]
    );
}

#[test]
fn an_inclusive_todo_at_the_root_commit_has_no_base() {
    let (ctx, oids) = make_three_commit_ctx();

    let todo = ctx.get_rebase_todo(&oids[0].to_string(), true).unwrap();

    assert_eq!(todo.base_oid, None);
    assert_eq!(
        todo.items
            .iter()
            .map(|i| i.summary.as_str())
            .collect::<Vec<_>>(),
        vec!["Initial commit", "Second commit", "Third commit"]
    );
}

/// Four commits, each touching its own file, so any order applies cleanly.
fn four_commit_ctx() -> (TestContext, Vec<git2::Oid>) {
    let ctx = TestContext::builder()
        .with_file("c1.txt", "one")
        .with_commit("C1")
        .with_file("c2.txt", "two")
        .with_commit("C2")
        .with_file("c3.txt", "three")
        .with_commit("C3")
        .with_file("c4.txt", "four")
        .with_commit("C4")
        .build();
    without_commit_signing(&ctx);
    let oids = oids_oldest_first(&ctx);
    (ctx, oids)
}

#[test]
fn an_inclusive_rebase_applies_a_reordered_base_commit() {
    let (ctx, oids) = four_commit_ctx();
    let listing = ctx.get_rebase_todo(&oids[1].to_string(), true).unwrap();

    ctx.start_interactive_rebase(
        listing.base_oid.as_deref(),
        &[
            todo(oids[2], RebaseAction::Pick, None),
            todo(oids[3], RebaseAction::Pick, None),
            todo(oids[1], RebaseAction::Pick, None),
        ],
    )
    .expect("the reordered list should apply");

    assert_eq!(summaries_newest_first(&ctx), vec!["C2", "C4", "C3", "C1"]);
    assert!(
        !ctx.repo().path().join("rebase-merge").exists(),
        "the rebase should have run to completion"
    );
}

#[test]
fn an_inclusive_rebase_with_no_edits_leaves_history_untouched() {
    let (ctx, oids) = four_commit_ctx();
    let listing = ctx.get_rebase_todo(&oids[1].to_string(), true).unwrap();
    let before = oids_oldest_first(&ctx);

    ctx.start_interactive_rebase(
        listing.base_oid.as_deref(),
        &[
            todo(oids[1], RebaseAction::Pick, None),
            todo(oids[2], RebaseAction::Pick, None),
            todo(oids[3], RebaseAction::Pick, None),
        ],
    )
    .expect("an unedited list should apply");

    assert_eq!(oids_oldest_first(&ctx), before);
    assert!(
        !ctx.repo().path().join("rebase-merge").exists(),
        "an unedited rebase must not leave one in progress"
    );
}

#[test]
fn an_inclusive_rebase_from_the_root_reorders_the_root_commit() {
    let (ctx, oids) = four_commit_ctx();
    let listing = ctx.get_rebase_todo(&oids[0].to_string(), true).unwrap();

    ctx.start_interactive_rebase(
        listing.base_oid.as_deref(),
        &[
            todo(oids[1], RebaseAction::Pick, None),
            todo(oids[0], RebaseAction::Pick, None),
            todo(oids[2], RebaseAction::Pick, None),
            todo(oids[3], RebaseAction::Pick, None),
        ],
    )
    .expect("a rebase from the root should apply");

    assert_eq!(summaries_newest_first(&ctx), vec!["C4", "C3", "C1", "C2"]);
    assert!(
        !ctx.repo().path().join("rebase-merge").exists(),
        "the rebase should have run to completion"
    );
}

#[test]
fn a_rebase_that_stops_reports_the_stop_not_a_completion() {
    // Every commit rewrites the same file, so omitting one makes the next conflict.
    let ctx = TestContext::builder()
        .with_file("g.txt", "one\n")
        .with_commit("G1 commit")
        .with_file("g.txt", "two\n")
        .with_commit("G2 commit")
        .with_file("g.txt", "three\n")
        .with_commit("G3 commit")
        .build();
    without_commit_signing(&ctx);
    let oids = oids_oldest_first(&ctx);

    let (_, outcome) = ctx
        .start_interactive_rebase(
            Some(&oids[0].to_string()),
            &[
                todo(oids[1], RebaseAction::Drop, None),
                todo(oids[2], RebaseAction::Pick, None),
            ],
        )
        .expect("a stopped rebase reports the pause, not an error");

    assert_eq!(outcome, RebaseStartResult::Stopped);
    assert!(
        ctx.repo().path().join("rebase-merge/stopped-sha").exists(),
        "git should have stopped at a commit"
    );
}

#[test]
fn an_unknown_base_is_refused_before_anything_moves() {
    let (ctx, oids) = four_commit_ctx();
    let head_before = head_of_main(&ctx);

    let err = ctx
        .start_interactive_rebase(
            Some(&git2::Oid::ZERO_SHA1.to_string()),
            &[todo(oids[1], RebaseAction::Pick, None)],
        )
        .expect_err("an unknown base must not read as a completed rebase");

    assert_eq!(err.code, "git_not_found");
    assert_nothing_moved(&ctx, head_before);
}

/// A, B, then a side commit S merged back as M, then C on top.
fn merge_in_range_ctx() -> TestContext {
    let ctx = TestContext::builder()
        .with_file("a.txt", "a")
        .with_commit("A")
        .with_file("b.txt", "b")
        .with_commit("B")
        .with_branch("side")
        .checkout("side")
        .with_file("s.txt", "s")
        .with_commit("S")
        .checkout("main")
        .merge("side")
        .with_file("c.txt", "c")
        .with_commit("C")
        .build();
    without_commit_signing(&ctx);
    ctx
}

fn oid_of(ctx: &TestContext, summary: &str) -> git2::Oid {
    let repo = ctx.repo();
    let mut revwalk = repo.revwalk().unwrap();
    revwalk.push_head().unwrap();
    revwalk
        .map(|r| r.unwrap())
        .find(|oid| repo.find_commit(*oid).unwrap().summary().ok().flatten() == Some(summary))
        .unwrap_or_else(|| panic!("no commit named {summary:?} reachable from HEAD"))
}

fn short(oid: git2::Oid) -> String {
    oid.to_string()[..7].to_string()
}

#[test]
fn a_todo_over_a_range_holding_a_merge_is_refused_naming_the_merge() {
    let ctx = merge_in_range_ctx();
    let merge = oid_of(&ctx, "Merge branch 'side'");

    let err = ctx
        .get_rebase_todo(&oid_of(&ctx, "A").to_string(), false)
        .expect_err("a range holding a merge must not list");

    assert_eq!(err.code, "rebase_has_merge");
    assert_eq!(
        err.message,
        format!(
            "Interactive rebase can't replay merge commits. {} Merge branch 'side' is a merge in this range.",
            short(merge)
        )
    );
}

#[test]
fn a_merge_below_the_base_lists_and_replays_the_commits_above_it() {
    let ctx = merge_in_range_ctx();
    let merge = oid_of(&ctx, "Merge branch 'side'");

    let listing = ctx.get_rebase_todo(&merge.to_string(), false).unwrap();
    let listed: Vec<&str> = listing
        .items
        .iter()
        .map(|item| item.summary.as_str())
        .collect();
    assert_eq!(listed, ["C"]);

    let (_, outcome) = ctx
        .start_interactive_rebase(
            listing.base_oid.as_deref(),
            &[todo(
                oid_of(&ctx, "C"),
                RebaseAction::Reword,
                Some("C reworded"),
            )],
        )
        .unwrap();

    assert_eq!(outcome, RebaseStartResult::Completed);
    assert_eq!(full_message_of_head(&ctx).trim_end(), "C reworded");
    assert_eq!(
        ctx.repo()
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent_id(0)
            .unwrap(),
        merge,
        "the merge below the base stays as it was"
    );
}

#[test]
fn a_todo_over_several_merges_names_the_oldest_and_counts_the_rest() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "a")
        .with_commit("A")
        .with_file("b.txt", "b")
        .with_commit("B")
        .with_branch("side1")
        .checkout("side1")
        .with_file("s1.txt", "s1")
        .with_commit("S1")
        .checkout("main")
        .merge("side1")
        .with_branch("side2")
        .checkout("side2")
        .with_file("s2.txt", "s2")
        .with_commit("S2")
        .checkout("main")
        .merge("side2")
        .with_file("c.txt", "c")
        .with_commit("C")
        .build();
    let oldest_merge = oid_of(&ctx, "Merge branch 'side1'");

    let err = ctx
        .get_rebase_todo(&oid_of(&ctx, "A").to_string(), false)
        .expect_err("a range holding merges must not list");

    assert_eq!(
        err.message,
        format!(
            "Interactive rebase can't replay merge commits. {} Merge branch 'side1' is a merge in this range, and 1 more.",
            short(oldest_merge)
        )
    );
}

#[test]
fn an_inclusive_todo_from_the_merge_itself_is_refused() {
    let ctx = merge_in_range_ctx();
    let merge = oid_of(&ctx, "Merge branch 'side'");

    let err = ctx
        .get_rebase_todo(&merge.to_string(), true)
        .expect_err("the clicked merge is in its own range");

    assert_eq!(err.code, "rebase_has_merge");
    assert!(
        err.message.contains(&short(merge)),
        "the refusal names the merge, got {:?}",
        err.message
    );
}

fn head_of_main(ctx: &TestContext) -> git2::Oid {
    let repo = ctx.repo();
    let head = repo.head().unwrap();
    assert_eq!(
        head.name().ok(),
        Some("refs/heads/main"),
        "main is still checked out"
    );
    head.peel_to_commit().unwrap().id()
}

fn assert_nothing_moved(ctx: &TestContext, head_before: git2::Oid) {
    assert!(
        !ctx.repo().path().join("rebase-merge").exists(),
        "a refused start must not leave a rebase in progress"
    );
    assert_eq!(head_of_main(ctx), head_before);
}

/// Commit a new file onto main behind the listing's back, as a terminal would.
fn commit_from_elsewhere(ctx: &TestContext, summary: &str) {
    let repo = ctx.repo();
    let workdir = repo.workdir().unwrap().to_path_buf();
    std::fs::write(workdir.join("elsewhere.txt"), summary).unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_path(std::path::Path::new("elsewhere.txt"))
        .unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, summary, &tree, &[&parent])
        .unwrap();
}

#[test]
fn a_start_over_a_range_holding_a_merge_is_refused_before_git_runs() {
    let ctx = merge_in_range_ctx();
    let head_before = head_of_main(&ctx);

    let err = ctx
        .start_interactive_rebase(
            Some(&oid_of(&ctx, "A").to_string()),
            &[
                todo(oid_of(&ctx, "B"), RebaseAction::Pick, None),
                todo(oid_of(&ctx, "S"), RebaseAction::Pick, None),
                todo(oid_of(&ctx, "C"), RebaseAction::Pick, None),
            ],
        )
        .expect_err("a todo that leaves the merge out must not flatten the branch");

    assert_eq!(err.code, "rebase_has_merge");
    assert_nothing_moved(&ctx, head_before);
}

#[test]
fn a_start_after_a_commit_landed_since_the_listing_is_refused() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "a")
        .with_commit("A")
        .with_file("b.txt", "b")
        .with_commit("B")
        .build();
    without_commit_signing(&ctx);
    let base = oid_of(&ctx, "A").to_string();
    let listing = ctx.get_rebase_todo(&base, false).unwrap();
    commit_from_elsewhere(&ctx, "D");
    let head_before = head_of_main(&ctx);

    let err = ctx
        .start_interactive_rebase(
            listing.base_oid.as_deref(),
            &[todo(oid_of(&ctx, "B"), RebaseAction::Pick, None)],
        )
        .expect_err("a todo that no longer lists the branch must not drop D");

    assert_eq!(err.code, "rebase_todo_stale");
    assert_eq!(
        err.message,
        "The branch changed after the rebase editor opened. Open it again to see the current commits."
    );
    assert_nothing_moved(&ctx, head_before);
}

#[test]
fn a_start_listing_a_commit_twice_is_refused() {
    let (ctx, oids) = make_three_commit_ctx();
    without_commit_signing(&ctx);
    let head_before = head_of_main(&ctx);

    let err = ctx
        .start_interactive_rebase(
            Some(&oids[0].to_string()),
            &[
                todo(oids[1], RebaseAction::Pick, None),
                todo(oids[1], RebaseAction::Pick, None),
                todo(oids[2], RebaseAction::Pick, None),
            ],
        )
        .expect_err("a commit listed twice is not the range");

    assert_eq!(err.code, "rebase_todo_stale");
    assert_nothing_moved(&ctx, head_before);
}

#[test]
fn a_start_listing_a_commit_outside_the_range_is_refused() {
    let (ctx, oids) = make_three_commit_ctx();
    without_commit_signing(&ctx);
    let head_before = head_of_main(&ctx);

    let err = ctx
        .start_interactive_rebase(
            Some(&oids[1].to_string()),
            &[todo(oids[1], RebaseAction::Pick, None)],
        )
        .expect_err("the base itself is not in the range, though the count matches");

    assert_eq!(err.code, "rebase_todo_stale");
    assert_nothing_moved(&ctx, head_before);
}

#[test]
fn a_start_git_refuses_is_an_error_that_leaves_no_rebase() {
    let (ctx, oids) = make_three_commit_ctx();
    without_commit_signing(&ctx);
    ctx.repo()
        .config()
        .unwrap()
        .set_bool("rebase.autostash", false)
        .unwrap();
    std::fs::write(ctx.repo().workdir().unwrap().join("file.txt"), "dirty").unwrap();
    let head_before = head_of_main(&ctx);

    let err = ctx
        .start_interactive_rebase(
            Some(&oids[0].to_string()),
            &[
                todo(oids[1], RebaseAction::Pick, None),
                todo(oids[2], RebaseAction::Pick, None),
            ],
        )
        .expect_err("git refuses to rebase a dirty tree without autostash");

    assert_eq!(err.code, "rebase_error");
    assert_nothing_moved(&ctx, head_before);
}

#[test]
fn a_dropped_commit_survives_git_checking_for_missing_commits() {
    let (ctx, oids) = four_commit_ctx();
    ctx.repo()
        .config()
        .unwrap()
        .set_str("rebase.missingCommitsCheck", "error")
        .unwrap();

    ctx.start_interactive_rebase(
        Some(&oids[0].to_string()),
        &[
            todo(oids[1], RebaseAction::Drop, None),
            todo(oids[2], RebaseAction::Pick, None),
            todo(oids[3], RebaseAction::Pick, None),
        ],
    )
    .expect("a drop the user chose is not a commit missing by accident");

    assert_eq!(summaries_newest_first(&ctx), vec!["C4", "C3", "C1"]);
    assert!(!ctx.repo().path().join("rebase-merge").exists());
}

/// A todo row as the editor sends it over IPC.
fn wire_row(oid: &str, action: &str, summary: &str) -> String {
    serde_json::json!({ "oid": oid, "action": action, "summary": summary, "newMessage": null })
        .to_string()
}

#[test]
fn a_summary_cannot_add_a_line_to_the_todo_git_runs() {
    let (ctx, oids) = four_commit_ctx();
    let marker = ctx.repo().workdir().unwrap().join("ran");
    let tampered: RebaseTodoAction = serde_json::from_str(&wire_row(
        &oids[2].to_string(),
        "pick",
        "C3\n\nexec touch ran",
    ))
    .unwrap();

    ctx.start_interactive_rebase(
        Some(&oids[0].to_string()),
        &[
            todo(oids[1], RebaseAction::Pick, None),
            tampered,
            todo(oids[3], RebaseAction::Pick, None),
        ],
    )
    .expect("the rebase itself is fine");

    assert!(
        !marker.exists(),
        "text after a commit's id must never become a command"
    );
}

macro_rules! an_editor_action_parses {
    ($($name:ident => $wire:literal, $action:expr;)*) => {
        $(
            #[test]
            fn $name() {
                let row = wire_row("0000000000000000000000000000000000000000", $wire, "");

                let parsed: RebaseTodoAction = serde_json::from_str(&row).unwrap();

                assert_eq!(parsed.action, $action);
            }
        )*
    };
}

an_editor_action_parses! {
    the_editors_pick_parses_as_pick => "pick", RebaseAction::Pick;
    the_editors_reword_parses_as_reword => "reword", RebaseAction::Reword;
    the_editors_squash_parses_as_squash => "squash", RebaseAction::Squash;
    the_editors_drop_parses_as_drop => "drop", RebaseAction::Drop;
}

#[test]
fn an_action_git_would_run_as_a_command_is_rejected_at_the_boundary() {
    let row = wire_row("0000000000000000000000000000000000000000", "exec", "");

    let parsed = serde_json::from_str::<RebaseTodoAction>(&row);

    assert!(parsed.is_err(), "got {parsed:?}");
}
