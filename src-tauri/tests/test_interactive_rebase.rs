mod common;

use common::context::TestContext;
use trunk_lib::commands::interactive_rebase::RebaseTodoAction;

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

fn todo(oid: git2::Oid, action: &str, new_message: Option<&str>) -> RebaseTodoAction {
    RebaseTodoAction {
        oid: oid.to_string(),
        action: action.to_string(),
        summary: "todo summary".to_string(),
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
            todo(oids[1], "pick", None),
            todo(oids[2], "squash", None),
            todo(oids[3], "reword", Some("Reworded fourth")),
            todo(oids[4], "pick", None),
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
            todo(oids[1], "pick", None),
            todo(oids[2], "squash", Some("Combined A")),
            todo(oids[3], "squash", Some("Combined B")),
            todo(oids[4], "reword", Some("Reworded fifth")),
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
            todo(oids[2], "pick", None),
            todo(oids[3], "reword", Some("Reworded after the conflict")),
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
            todo(oids[1], "pick", None),
            todo(oids[3], "reword", Some("Reworded fourth")),
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
        &[todo(oids[1], "pick", None), todo(oids[2], "squash", None)],
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
        todo.items.iter().map(|i| i.summary.as_str()).collect::<Vec<_>>(),
        vec!["Second commit", "Third commit"]
    );
}

#[test]
fn an_inclusive_todo_at_the_root_commit_has_no_base() {
    let (ctx, oids) = make_three_commit_ctx();

    let todo = ctx.get_rebase_todo(&oids[0].to_string(), true).unwrap();

    assert_eq!(todo.base_oid, None);
    assert_eq!(
        todo.items.iter().map(|i| i.summary.as_str()).collect::<Vec<_>>(),
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
            todo(oids[2], "pick", None),
            todo(oids[3], "pick", None),
            todo(oids[1], "pick", None),
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
            todo(oids[1], "pick", None),
            todo(oids[2], "pick", None),
            todo(oids[3], "pick", None),
        ],
    )
    .expect("an unedited list should apply");

    assert_eq!(oids_oldest_first(&ctx), before);
    assert!(
        !ctx.repo().path().join("rebase-merge").exists(),
        "an unedited rebase must not leave one in progress"
    );
}
