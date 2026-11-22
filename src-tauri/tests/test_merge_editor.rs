mod common;

use common::context::TestContext;
use trunk_git::conflicted_file::MergeRegion;
use trunk_lib::commands::merge_editor::{MergeBaseSelection, MergeBaseView, get_merge_base_inner};

fn lines(text: &str) -> Vec<String> {
    text.split('\n').map(str::to_owned).collect()
}

fn conflicted_file_txt() -> TestContext {
    TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build()
}

#[test]
fn indexed_ancestor_shows_only_a_verified_diff3_block() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "start\nancestor\nelsewhere\n")
        .with_commit("base")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "start\nfeature\nelsewhere\n")
        .with_commit("theirs")
        .checkout("main")
        .with_file("file.txt", "start\nmain\nelsewhere\n")
        .with_commit("ours")
        .with_conflict("feature")
        .build();
    let sides = ctx.get_merge_sides("file.txt").unwrap();
    let oid = sides.base_oid.unwrap();
    let selection = MergeBaseSelection {
        ordinal: 0,
        ours: lines("main"),
        theirs: lines("feature"),
    };
    let read = || {
        get_merge_base_inner(
            ctx.path(),
            "file.txt",
            &oid,
            Some(&selection),
            ctx.state_map(),
        )
        .unwrap()
    };
    let file = ctx.repo_path().join("file.txt");
    std::fs::write(
        &file,
        "start\n<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\nelsewhere\n",
    )
    .unwrap();
    assert!(matches!(read(), MergeBaseView::File(text) if text == "start\nancestor\nelsewhere\n"));
    let diff3 = "start\n<<<<<<< HEAD\nmain\n||||||| base\nancestor\n=======\nfeature\n>>>>>>> feature\nelsewhere\n";
    std::fs::write(&file, diff3).unwrap();
    assert!(matches!(read(), MergeBaseView::Conflict(text) if text == "ancestor"));
    std::fs::write(&file, diff3.replace("ancestor", "elsewhere")).unwrap();
    assert!(matches!(read(), MergeBaseView::File(text) if text == "start\nancestor\nelsewhere\n"));
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn approved_output_can_be_staged_again_after_an_index_lock_failure() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let lock = ctx.repo().path().join("index.lock");
    std::fs::File::create_new(&lock).unwrap();
    let err = ctx
        .save_merge_draft("file.txt", "approved draft", &revision)
        .unwrap_err();
    assert_eq!(err.code, "stage_failed");
    assert!(ctx.repo().index().unwrap().has_conflicts());
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        b"approved draft"
    );
    std::fs::remove_file(lock).unwrap();
    ctx.save_merge_draft("file.txt", "approved draft", &revision)
        .unwrap();
    let repo = ctx.repo();
    let index = repo.index().unwrap();
    assert!(!index.has_conflicts());
    let entry = index.get_path(std::path::Path::new("file.txt"), 0).unwrap();
    assert_eq!(
        repo.find_blob(entry.id).unwrap().content(),
        b"approved draft"
    );
}

#[test]
fn manual_draft_preserves_the_index_and_new_working_bytes_if_the_file_changed() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let file = ctx.repo_path().join("file.txt");
    std::fs::write(&file, "external edit").unwrap();
    let err = ctx
        .save_merge_draft("file.txt", "my draft", &revision)
        .unwrap_err();
    assert_eq!(err.code, "conflict_changed");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "external edit");
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[test]
fn manual_draft_is_refused_if_a_stage_changed_with_the_same_working_bytes() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    let path = std::path::Path::new("file.txt");
    let original = std::fs::read(ctx.repo_path().join(path)).unwrap();
    let oid = repo.blob(b"a different incoming side").unwrap();
    let previous = index.get_path(path, 3).unwrap();
    index
        .add(&git2::IndexEntry {
            id: oid,
            ..previous
        })
        .unwrap();
    index.write().unwrap();
    assert_eq!(
        ctx.save_merge_draft("file.txt", "draft", &revision)
            .unwrap_err()
            .code,
        "conflict_changed"
    );
    assert_eq!(std::fs::read(ctx.repo_path().join(path)).unwrap(), original);
    assert_eq!(repo.index().unwrap().get_path(path, 3).unwrap().id, oid);
}

#[test]
fn edited_marker_lines_lose_only_their_own_revision_label() {
    let ctx = conflicted_file_txt();
    let path = ctx.repo_path().join("file.txt");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(path, text.replace("feature content", "locally typed")).unwrap();
    let sides = ctx.get_merge_sides("file.txt").unwrap();
    assert_eq!(sides.current_label.as_deref(), Some("main"));
    assert!(sides.incoming_label.is_none());
}

#[test]
fn incoming_merge_label_preserves_an_apostrophe_in_the_branch_name() {
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    let incoming = repo
        .find_reference("refs/heads/feature")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    repo.branch("dev's-feature", &incoming, false).unwrap();
    std::fs::write(
        repo.path().join("MERGE_MSG"),
        "Merge branch 'dev's-feature' into release'\n",
    )
    .unwrap();
    assert_eq!(
        ctx.get_merge_sides("file.txt")
            .unwrap()
            .incoming_label
            .as_deref(),
        Some("dev's-feature")
    );
}

#[test]
fn merge_side_labels_name_the_revisions_that_supply_the_file() {
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    std::fs::write(repo.path().join("MERGE_MSG"), "Merge branch 'feature'\n").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(sides.current_label.as_deref(), Some("main"));
    assert_eq!(sides.incoming_label.as_deref(), Some("feature"));
}

#[test]
fn merge_side_label_uses_the_merge_commit_when_a_named_ref_has_moved() {
    let ctx = conflicted_file_txt();
    let repo = ctx.repo();
    std::fs::write(repo.path().join("MERGE_MSG"), "Merge branch 'feature'\n").unwrap();
    let incoming = repo
        .find_reference("refs/heads/feature")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    let abbreviated = incoming.as_object().short_id().unwrap();
    repo.reference(
        "refs/heads/feature",
        repo.head().unwrap().target().unwrap(),
        true,
        "moved",
    )
    .unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.incoming_label.as_deref(),
        Some(abbreviated.as_str().unwrap())
    );
}

#[test]
fn a_rebase_names_the_detached_target_and_the_replayed_commit() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "base")
        .with_commit("Base")
        .with_branch("topic")
        .checkout("topic")
        .with_file("file.txt", "replayed")
        .with_commit("Topic")
        .checkout("main")
        .with_file("file.txt", "target")
        .with_commit("Target")
        .checkout("topic")
        .build();
    let repo = ctx.repo();
    let short = |name| {
        repo.revparse_single(name)
            .unwrap()
            .short_id()
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    };
    let current = short("refs/heads/main");
    let incoming = format!("Replaying {}", short("refs/heads/topic"));
    ctx.rebase_branch("main").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(sides.current_label, Some(current));
    assert_eq!(sides.incoming_label, Some(incoming));
}

#[test]
fn get_merge_sides_reads_the_conflict_git_wrote() {
    let ctx = conflicted_file_txt();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions,
        [MergeRegion::Conflict {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
        }]
    );
}

#[test]
fn get_merge_sides_reads_a_file_the_user_already_resolved_as_merged() {
    let ctx = conflicted_file_txt();
    std::fs::write(ctx.repo_path().join("file.txt"), "both\n").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions,
        [MergeRegion::Merged {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
            merged_lines: lines("both\n"),
        }]
    );
}

/// A file the user resolved to the current side has no markers and equals that side,
/// as a file git did not merge does, but git did merge it, so it reads as merged.
#[test]
fn get_merge_sides_reads_a_file_the_user_resolved_to_the_current_side_as_merged() {
    let ctx = conflicted_file_txt();
    std::fs::write(ctx.repo_path().join("file.txt"), "main content").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions,
        [MergeRegion::Merged {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
            merged_lines: lines("main content"),
        }]
    );
}

#[test]
fn get_merge_sides_reads_markers_of_the_size_the_attributes_set() {
    let ctx = TestContext::builder()
        .with_file(".gitattributes", "file.txt conflict-marker-size=9\n")
        .with_file("file.txt", "hello\n")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content\n")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content\n=======\n")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<<<< HEAD\nmain content\n=======\n=========\nfeature content\n>>>>>>>>> feature\n",
    )
    .unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions[0],
        MergeRegion::Conflict {
            ours_lines: lines("main content\n======="),
            theirs_lines: lines("feature content"),
        }
    );
}

#[test]
fn get_merge_sides_reads_a_conflict_where_both_sides_added_the_file() {
    let ctx = TestContext::builder()
        .with_file("placeholder.txt", "init")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("new_file.txt", "feature version")
        .with_commit("Add new_file on feature")
        .checkout("main")
        .with_file("new_file.txt", "main version")
        .with_commit("Add new_file on main")
        .with_conflict("feature")
        .build();

    let sides = ctx.get_merge_sides("new_file.txt").unwrap();
    assert!(sides.base_oid.is_none());

    assert_eq!(
        sides.regions[0],
        MergeRegion::Conflict {
            ours_lines: lines("main version"),
            theirs_lines: lines("feature version"),
        }
    );
}

/// Read as empty, a file missing from the working tree would show no conflicts, and
/// saving it would stage an empty file over both sides.
#[test]
fn get_merge_sides_refuses_a_file_missing_from_the_working_tree() {
    let ctx = conflicted_file_txt();
    std::fs::remove_file(ctx.repo_path().join("file.txt")).unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "missing_file");
}

/// Rewrites the conflict's two sides in the index as `mode`, standing in for a
/// merge of two branches that each hold a symbolic link or a submodule there.
fn record_both_sides_as(ctx: &TestContext, file_path: &str, mode: u32) {
    const STAGE_SHIFT: u16 = 12;
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    for stage in 1..=3_u16 {
        let entry = index
            .get_path(std::path::Path::new(file_path), i32::from(stage))
            .unwrap();
        let flags = (entry.flags & !(0b11 << STAGE_SHIFT)) | (stage << STAGE_SHIFT);
        index
            .add(&git2::IndexEntry {
                mode,
                flags,
                ..entry
            })
            .unwrap();
    }
    index.write().unwrap();
}

/// A link conflict leaves the link itself in the working tree, so reading the path
/// would show, and saving it would overwrite, whatever the link points at.
#[test]
fn get_merge_sides_refuses_a_conflict_between_two_links() {
    let ctx = conflicted_file_txt();
    record_both_sides_as(&ctx, "file.txt", 0o120_000);

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "link_conflict");
}

#[test]
fn save_merge_result_refuses_a_conflict_between_two_links() {
    let ctx = conflicted_file_txt();
    record_both_sides_as(&ctx, "file.txt", 0o120_000);
    let before = std::fs::read(ctx.repo_path().join("file.txt")).unwrap();

    let err = ctx.save_merge_result("file.txt", "resolved").unwrap_err();

    assert_eq!(err.code, "link_conflict");
    assert_eq!(
        std::fs::read(ctx.repo_path().join("file.txt")).unwrap(),
        before,
        "a refused save must not write the path"
    );
}

/// A link standing where the conflicted file should be would show a file from
/// outside the repository as the merge.
#[cfg(unix)]
#[test]
fn get_merge_sides_does_not_follow_a_link_in_the_working_tree() {
    let ctx = conflicted_file_txt();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(
        &secret,
        "<<<<<<< HEAD\nsecret\n=======\nx\n>>>>>>> feature\n",
    )
    .unwrap();
    let file = ctx.repo_path().join("file.txt");
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&secret, &file).unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "missing_file");
}

/// Read lossily, the replacement characters would be saved over the file.
#[test]
fn get_merge_sides_refuses_a_working_file_that_is_not_utf8() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        b"<<<<<<< HEAD\n\xff\xfe\n=======\nfeature content\n>>>>>>> feature\n",
    )
    .unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "binary_conflict");
}

/// Read as text, a conflict that never closes would be saved and staged with its
/// markers in it.
#[test]
fn get_merge_sides_refuses_a_conflict_whose_markers_do_not_close() {
    let ctx = conflicted_file_txt();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<< HEAD\nmain content\n=======\nfeature content\n",
    )
    .unwrap();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "unclosed_conflict");
}

/// Git writes markers of its default size when the attribute holds no usable size.
#[test]
fn get_merge_sides_reads_default_markers_when_the_attribute_sets_size_zero() {
    let ctx = TestContext::builder()
        .with_file(".gitattributes", "file.txt conflict-marker-size=0\n")
        .with_file("file.txt", "hello\n")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content\n")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content\n")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<< HEAD\nmain content\n=======\nfeature content\n>>>>>>> feature\n",
    )
    .unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions[0],
        MergeRegion::Conflict {
            ours_lines: lines("main content"),
            theirs_lines: lines("feature content"),
        }
    );
}

/// Git does not merge a file marked `-merge`: it leaves the current side in the
/// working tree with no markers. Read as a clean merge, taking the incoming side
/// would silently save the current one.
#[test]
fn get_merge_sides_reads_a_file_git_did_not_merge_as_one_conflict() {
    let ctx = TestContext::builder()
        .with_file(".gitattributes", "file.txt -merge\n")
        .with_file("file.txt", "a\nhello\nz\n")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "a\nfeature content\nz\n")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "a\nmain content\nz\n")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    std::fs::write(ctx.repo_path().join("file.txt"), "a\nmain content\nz\n").unwrap();

    let sides = ctx.get_merge_sides("file.txt").unwrap();

    assert_eq!(
        sides.regions,
        [
            MergeRegion::Merged {
                ours_lines: lines("a"),
                theirs_lines: lines("a"),
                merged_lines: lines("a"),
            },
            MergeRegion::Conflict {
                ours_lines: lines("main content"),
                theirs_lines: lines("feature content"),
            },
            MergeRegion::Merged {
                ours_lines: lines("z\n"),
                theirs_lines: lines("z\n"),
                merged_lines: lines("z\n"),
            },
        ]
    );
}

#[test]
fn save_merge_result_writes_and_stages() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let result = ctx.save_merge_result("file.txt", "resolved content");
    assert!(result.is_ok(), "expected Ok, got: {result:?}");

    // Assert the file on disk contains "resolved content"
    let content = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        content, "resolved content",
        "file on disk should contain resolved content"
    );

    // Assert the file is staged in the index (no longer in conflict entries)
    let repo = ctx.repo();
    let index = repo.index().unwrap();
    assert!(
        !index.has_conflicts(),
        "index should have no conflicts after staging"
    );
}

#[cfg(unix)]
#[test]
fn save_merge_result_preserves_a_link_that_replaced_the_working_copy() {
    let ctx = conflicted_file_txt();
    let revision = ctx.get_merge_sides("file.txt").unwrap().revision;
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "secret").unwrap();
    let file = ctx.repo_path().join("file.txt");
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&secret, &file).unwrap();

    let err = ctx
        .save_merge_draft("file.txt", "resolved content", &revision)
        .unwrap_err();
    assert_eq!(err.code, "conflict_changed");
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "secret");
    assert!(file.is_symlink());
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

#[cfg(unix)]
#[test]
fn save_merge_result_refuses_a_file_inside_a_linked_directory() {
    let ctx = TestContext::builder()
        .with_file("dir/file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("dir/file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("dir/file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();
    let revision = ctx.get_merge_sides("dir/file.txt").unwrap().revision;
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("file.txt"), "secret").unwrap();
    let dir = ctx.repo_path().join("dir");
    std::fs::remove_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(outside.path(), &dir).unwrap();

    let err = ctx
        .save_merge_draft("dir/file.txt", "resolved content", &revision)
        .unwrap_err();

    assert_eq!(err.code, "conflict_changed");
    assert_eq!(
        std::fs::read_to_string(outside.path().join("file.txt")).unwrap(),
        "secret"
    );
}

/// A PNG carries no text sides. Reading it through `String::from_utf8_lossy`
/// replaces every invalid byte with U+FFFD, and saving that back writes the
/// replacement characters over the file with both original sides already gone.
#[test]
fn get_merge_sides_refuses_a_binary_conflict() {
    let ours: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeOURS";
    let theirs: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeTHEM";
    let ctx = TestContext::builder()
        .with_binary_file("image.png", b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeBASE")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_binary_file("image.png", theirs)
        .with_commit("Feature commit")
        .checkout("main")
        .with_binary_file("image.png", ours)
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let err = ctx.get_merge_sides("image.png").unwrap_err();

    assert_eq!(err.code, "binary_conflict");
}

/// A side that deleted the file has no blob. Read as empty text, taking that side
/// saved an empty file and staged it, so the merge kept a file the side removed.
#[test]
fn get_merge_sides_refuses_a_conflict_where_one_side_deleted_the_file() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_removed_file("file.txt")
        .with_commit("Delete the file")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "delete_conflict");
}

#[test]
fn get_merge_sides_refuses_a_conflict_where_the_current_side_deleted_the_file() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_removed_file("file.txt")
        .with_commit("Delete the file")
        .with_conflict("feature")
        .build();

    let err = ctx.get_merge_sides("file.txt").unwrap_err();

    assert_eq!(err.code, "delete_conflict");
}

/// The save path is reachable without the read path, from an editor opened on
/// an earlier conflict of the same file. Saving text there would stage a file
/// the deleting side removed, and the conflict that recorded the choice is gone.
#[test]
fn save_merge_result_refuses_a_conflict_where_one_side_deleted_the_file() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_removed_file("file.txt")
        .with_commit("Delete the file")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let err = ctx.save_merge_result("file.txt", "").unwrap_err();

    assert_eq!(err.code, "delete_conflict");
    let kept = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        kept, "main content",
        "a refused save must not write the file"
    );
    assert_eq!(
        ctx.get_merge_sides("file.txt").unwrap_err().code,
        "delete_conflict",
        "a refused save must leave the conflict in the index"
    );
}

/// The editor stays on screen after the operation it belongs to ends, and its
/// Save button stays live. Writing then would put the merged text over the file
/// the abort just restored and stage it, destroying content that was never
/// committed and cannot be recovered from the repository.
#[test]
fn save_merge_result_refuses_once_the_conflict_is_gone() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    ctx.merge_abort().unwrap();

    let err = ctx
        .save_merge_result("file.txt", "resolved content")
        .unwrap_err();

    assert_eq!(err.code, "not_conflicted");
    let restored = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        restored, "main content",
        "the abort's restored content must survive a stale save"
    );
}

fn conflicted_file() -> TestContext {
    TestContext::builder()
        .with_file("file.txt", "hello")
        .with_file("other.txt", "untouched")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build()
}

#[test]
fn conflict_marker_files_lists_a_file_that_still_holds_the_merge_markers() {
    let ctx = conflicted_file();

    let found = ctx
        .conflict_marker_files(&["file.txt", "other.txt"])
        .unwrap();

    assert_eq!(found, vec!["file.txt".to_string()]);
}

#[test]
fn conflict_marker_files_omits_a_file_whose_markers_were_edited_out() {
    let ctx = conflicted_file();
    std::fs::write(ctx.repo_path().join("file.txt"), "main content\n").unwrap();

    let found = ctx.conflict_marker_files(&["file.txt"]).unwrap();

    assert_eq!(found, Vec::<String>::new());
}

#[test]
fn conflict_marker_files_omits_a_file_that_was_deleted() {
    let ctx = conflicted_file();
    std::fs::remove_file(ctx.repo_path().join("file.txt")).unwrap();

    let found = ctx.conflict_marker_files(&["file.txt"]).unwrap();

    assert_eq!(found, Vec::<String>::new());
}

#[test]
fn conflict_marker_files_lists_a_file_holding_markers_of_the_size_the_attributes_set() {
    let ctx = conflicted_file();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "file.txt conflict-marker-size=9\n",
    )
    .unwrap();
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "<<<<<<<<< HEAD\nmain content\n=========\nfeature content\n>>>>>>>>> feature\n",
    )
    .unwrap();

    let found = ctx.conflict_marker_files(&["file.txt"]).unwrap();

    assert_eq!(found, vec!["file.txt".to_string()]);
}

/// A Markdown heading underlined with `=======` is not a conflict, so only a
/// file holding the opening and closing markers too is listed.
#[test]
fn conflict_marker_files_omits_a_file_with_only_a_separator_line() {
    let ctx = conflicted_file();
    std::fs::write(ctx.repo_path().join("file.txt"), "Title\n=======\n").unwrap();

    let found = ctx.conflict_marker_files(&["file.txt"]).unwrap();

    assert_eq!(found, Vec::<String>::new());
}

#[test]
fn save_merge_result_keeps_the_resolution_while_another_writer_stages_meanwhile() {
    let mut ctx = conflicted_file();

    ctx.act_while_another_writer_stages("a.txt", |ctx| {
        ctx.save_merge_result("file.txt", "resolved content")
    })
    .expect("save_merge_result failed");

    let index = ctx.repo().index().unwrap();
    assert!(!index.has_conflicts(), "the conflict came back");
    assert!(
        index.get_path(std::path::Path::new("a.txt"), 0).is_some(),
        "the other writer's file was lost"
    );
}
