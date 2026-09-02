use std::path::Path;

use git2::{ObjectType, Oid, Repository, RepositoryInitOptions, Signature, Time};
use trunk_fixtures::fingerprint;

const FIRST_COMMIT_SECS: i64 = 1_767_225_600;

fn pinned() -> Signature<'static> {
    Signature::new(
        "Trunk Fixture",
        "fixture@trunk.test",
        &Time::new(FIRST_COMMIT_SECS, 0),
    )
    .unwrap()
}

fn init(dir: &Path) -> Repository {
    let mut opts = RepositoryInitOptions::new();
    opts.initial_head("main");
    Repository::init_opts(dir, &opts).unwrap()
}

fn commit_file(repo: &Repository, path: &str, content: &str, message: &str) -> Oid {
    std::fs::write(repo.workdir().unwrap().join(path), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let sig = pinned();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
}

/// One commit, a branch, a lightweight tag, a modified tracked file and an untracked file.
fn small_repository(dir: &Path) -> Oid {
    let repo = init(dir);
    let commit = commit_file(&repo, "README.md", "hello\n", "feat: first\n");
    let head = repo.find_commit(commit).unwrap();
    repo.branch("topic", &head, false).unwrap();
    repo.tag_lightweight("v1", head.as_object(), false).unwrap();
    std::fs::write(dir.join("README.md"), "hello world\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "todo\n").unwrap();

    commit
}

fn blob(content: &str) -> Oid {
    Oid::hash_object(ObjectType::Blob, content.as_bytes()).unwrap()
}

/// The block `small_repository` fingerprints to.
fn small_block(name: &str, commit: Oid) -> String {
    format!(
        "repo {name}\n\
         head branch refs/heads/main\n\
         ref refs/heads/main {commit}\n\
         ref refs/heads/topic {commit}\n\
         ref refs/tags/v1 {commit}\n\
         state clean\n\
         status .M README.md {} {}\n\
         status ?? notes.txt - {}\n",
        blob("hello\n"),
        blob("hello world\n"),
        blob("todo\n"),
    )
}

#[test]
fn fingerprints_refs_head_state_and_every_status_entry_in_order() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    let commit = small_repository(&root.path().join("r"));

    let text = fingerprint::fingerprint(root.path(), &["r"]).unwrap();

    assert_eq!(text, small_block("r", commit));
}

#[test]
fn status_lines_sort_by_path_whatever_their_flags() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("r");
    let repo = init(&dir);
    let commit = commit_file(&repo, "b.txt", "b\n", "feat: first\n");
    std::fs::write(dir.join("b.txt"), "b changed\n").unwrap();
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("a.txt")).unwrap();
    index.write().unwrap();

    let text = fingerprint::fingerprint(root.path(), &["r"]).unwrap();

    assert_eq!(
        text,
        format!(
            "repo r\n\
             head branch refs/heads/main\n\
             ref refs/heads/main {commit}\n\
             state clean\n\
             status A. a.txt {} {}\n\
             status .M b.txt {} {}\n",
            blob("a\n"),
            blob("a\n"),
            blob("b\n"),
            blob("b changed\n"),
        )
    );
}

#[test]
fn a_stopped_merge_prints_its_state_heads_message_and_unmerged_stages() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("r");
    let repo = init(&dir);
    let base = commit_file(&repo, "f.txt", "base\n", "feat: base\n");
    repo.branch("topic", &repo.find_commit(base).unwrap(), false)
        .unwrap();
    let ours = commit_file(&repo, "f.txt", "ours\n", "feat: ours\n");
    repo.set_head("refs/heads/topic").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    let theirs = commit_file(&repo, "f.txt", "theirs\n", "feat: theirs\n");
    repo.set_head("refs/heads/main").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    let annotated = repo.find_annotated_commit(theirs).unwrap();
    repo.merge(&[&annotated], None, None).unwrap();
    std::fs::write(
        repo.path().join("MERGE_MSG"),
        "Merge topic\n\n# Conflicts:\n#\tf.txt\n\\ kept\n",
    )
    .unwrap();
    let marked = std::fs::read_to_string(dir.join("f.txt")).unwrap();

    let text = fingerprint::fingerprint(root.path(), &["r"]).unwrap();

    assert_eq!(
        text,
        format!(
            "repo r\n\
             head branch refs/heads/main\n\
             ref refs/heads/main {ours}\n\
             ref refs/heads/topic {theirs}\n\
             state merge\n\
             merge-head {theirs}\n\
             merge-msg Merge topic\\n\\n# Conflicts:\\n#\\tf.txt\\n\\\\ kept\\n\n\
             unmerged 1 100644 {} f.txt\n\
             unmerged 2 100644 {} f.txt\n\
             unmerged 3 100644 {} f.txt\n\
             status UU f.txt - {}\n",
            blob("base\n"),
            blob("ours\n"),
            blob("theirs\n"),
            blob(&marked),
        )
    );
}

#[test]
fn a_tracking_branch_prints_its_upstream_pair() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("r");
    let commit = small_repository(&dir);
    let mut config = Repository::open(&dir).unwrap().config().unwrap();
    config.set_str("branch.main.remote", "origin").unwrap();
    config
        .set_str("branch.main.merge", "refs/heads/main")
        .unwrap();

    let text = fingerprint::fingerprint(root.path(), &["r"]).unwrap();

    assert_eq!(
        text,
        small_block("r", commit) + "upstream main origin refs/heads/main\n"
    );
}

#[test]
fn an_ignored_file_prints_after_the_status_lines() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("r");
    let commit = small_repository(&dir);
    std::fs::write(dir.join(".gitignore"), "build/\n").unwrap();
    std::fs::create_dir(dir.join("build")).unwrap();
    std::fs::write(dir.join("build/out.o"), "obj\n").unwrap();

    let text = fingerprint::fingerprint(root.path(), &["r"]).unwrap();

    assert_eq!(
        text,
        format!(
            "repo r\n\
             head branch refs/heads/main\n\
             ref refs/heads/main {commit}\n\
             ref refs/heads/topic {commit}\n\
             ref refs/tags/v1 {commit}\n\
             state clean\n\
             status ?? .gitignore - {}\n\
             status .M README.md {} {}\n\
             status ?? notes.txt - {}\n\
             ignored build/out.o\n",
            blob("build/\n"),
            blob("hello\n"),
            blob("hello world\n"),
            blob("todo\n"),
        )
    );
}

#[test]
fn two_fingerprints_of_one_repository_agree() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    small_repository(&root.path().join("r"));

    let first = fingerprint::fingerprint(root.path(), &["r"]).unwrap();
    let second = fingerprint::fingerprint(root.path(), &["r"]).unwrap();

    assert_eq!(first, second);
}

#[test]
fn a_bare_repository_prints_repo_head_and_ref_lines_only() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let commit = small_repository(&source);
    let bare = root.path().join("remote.git");
    Repository::init_bare(&bare).unwrap();
    let source_repo = Repository::open(&source).unwrap();
    source_repo
        .remote("origin", bare.to_str().unwrap())
        .unwrap()
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();

    let text = fingerprint::fingerprint(root.path(), &["remote.git"]).unwrap();

    assert_eq!(
        text,
        format!("repo remote.git\nhead unborn refs/heads/master\nref refs/heads/main {commit}\n")
    );
}

#[test]
fn the_binary_prints_the_fingerprint_of_each_path_under_root() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();
    small_repository(&root.path().join("a"));
    small_repository(&root.path().join("b"));

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_fixtures"))
        .args(["fingerprint", "--root"])
        .arg(root.path())
        .args(["a", "b"])
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        fingerprint::fingerprint(root.path(), &["a", "b"]).unwrap()
    );
}
