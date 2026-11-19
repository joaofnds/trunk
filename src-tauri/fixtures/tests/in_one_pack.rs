//! `Repo::in_one_pack`: what a build commits reaches the disk as one pack, and a build
//! that leaves a name on an object no commit reaches fails rather than losing it.

use std::path::Path;

use git2::Repository;
use trunk_fixtures::repo::{Identity, Repo};

mod common;

use common::loose_objects;

const QA: Identity = Identity {
    name: "Trunk QA",
    email: "qa@example.invalid",
};

fn two_commits(repo: &mut Repo) {
    repo.write("notes.txt", "v1\n");
    repo.add(&["notes.txt"]);
    repo.commit(QA.at(1_750_000_000), "Add notes");
    repo.write("notes.txt", "v2\n");
    repo.add(&["notes.txt"]);
    repo.commit(QA.at(1_750_003_600), "Revise notes");
}

#[test]
fn a_build_reaches_the_disk_as_one_pack() {
    trunk_fixtures::isolate();
    let dir = tempfile::tempdir().unwrap();
    let mut repo = Repo::init(dir.path(), "main", QA);

    repo.in_one_pack(two_commits);

    let reopened = Repository::open(dir.path()).unwrap();
    let head = reopened.head().unwrap().peel_to_commit().unwrap();
    let first = head.parent(0).unwrap();
    let first_notes = first
        .tree()
        .unwrap()
        .get_path(Path::new("notes.txt"))
        .unwrap();
    assert_eq!(
        reopened.find_blob(first_notes.id()).unwrap().content(),
        b"v1\n"
    );
    assert_eq!(loose_objects(dir.path()), 0);
}

#[test]
#[should_panic(expected = "no commit reaches")]
fn a_build_that_stages_without_committing_is_refused() {
    trunk_fixtures::isolate();
    let dir = tempfile::tempdir().unwrap();
    let mut repo = Repo::init(dir.path(), "main", QA);

    repo.in_one_pack(|repo| {
        two_commits(repo);
        repo.write("draft.txt", "unsaved\n");
        repo.add(&["draft.txt"]);
    });
}
