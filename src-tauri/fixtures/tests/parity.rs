//! One scenario built twice, once through `Repo` and once through the `git` binary the
//! shell corpus used, and compared by fingerprint. The OIDs are the acceptance: a verb that
//! writes different bytes from git moves every fixture built with it.

use std::path::{Path, PathBuf};
use std::process::Command;

use trunk_fixtures::fingerprint;
use trunk_fixtures::repo::{Identity, Repo, Signature};

const FIXTURE: Identity = Identity {
    name: "Trunk Fixture",
    email: "fixture@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY: i64 = 86_400;

fn day(n: i64) -> Signature {
    FIXTURE.at(BASE_SECS + n * DAY)
}

/// The verbs a scenario is written in, so it can drive either side.
trait Build {
    fn write(&mut self, rel: &str, content: &str);
    fn add_all(&mut self);
    fn add(&mut self, rels: &[&str]);
    fn commit(&mut self, sig: Signature, msg: &str);
    fn commit_split(&mut self, author: Signature, committer: Signature, msg: &str);
    fn branch(&mut self, name: &str);
    fn branch_at(&mut self, name: &str, revspec: &str);
    fn checkout(&mut self, branch: &str);
    fn merge(&mut self, sig: Signature, msg: &str, heads: &[&str]);
    fn tag(&mut self, name: &str, revspec: &str);
    fn tag_annotated(&mut self, name: &str, sig: Signature, msg: &str);
    fn stash(&mut self, sig: Signature, msg: &str, include_untracked: bool);
    fn checkout_detached(&mut self, revspec: &str);
    fn gitlink(&mut self, rel: &str, oid: &str);
    fn checkout_orphan(&mut self, name: &str);
    fn rename_branch(&mut self, old: &str, new: &str);
    fn delete_branch(&mut self, name: &str);
    fn rm(&mut self, rel: &str);
    fn mv(&mut self, from: &str, to: &str);
    fn merge_ff(&mut self, branch: &str);
    fn reset_hard(&mut self, revspec: &str);
    /// A bare repository at `<dir>.remotes/<name>.git`, added as the remote `name`.
    fn remote(&mut self, name: &str);
    fn push(&mut self, remote: &str, branch: &str, set_upstream: bool);
    fn fetch(&mut self, remote: &str);
    /// A bare clone of this repository at `<dir>.remotes/<name>.git`.
    fn clone_bare(&mut self, name: &str);
    /// The bare repository `name` already beside the driver, added as a remote.
    fn remote_existing(&mut self, name: &str);
}

fn remote_path(dir: &Path, name: &str) -> PathBuf {
    let side = dir.file_name().unwrap().to_str().unwrap();
    dir.parent()
        .unwrap()
        .join(format!("{side}.remotes"))
        .join(format!("{name}.git"))
}

impl Build for Repo {
    fn write(&mut self, rel: &str, content: &str) {
        Repo::write(self, rel, content);
    }
    fn add_all(&mut self) {
        Repo::add_all(self);
    }
    fn add(&mut self, rels: &[&str]) {
        Repo::add(self, rels);
    }
    fn commit(&mut self, sig: Signature, msg: &str) {
        Repo::commit(self, sig, msg);
    }
    fn commit_split(&mut self, author: Signature, committer: Signature, msg: &str) {
        Repo::commit_split(self, author, committer, msg);
    }
    fn branch(&mut self, name: &str) {
        Repo::branch(self, name);
    }
    fn branch_at(&mut self, name: &str, revspec: &str) {
        Repo::branch_at(self, name, revspec);
    }
    fn checkout(&mut self, branch: &str) {
        Repo::checkout(self, branch);
    }
    fn merge(&mut self, sig: Signature, msg: &str, heads: &[&str]) {
        Repo::merge(self, sig, msg, heads);
    }
    fn tag(&mut self, name: &str, revspec: &str) {
        Repo::tag(self, name, revspec);
    }
    fn tag_annotated(&mut self, name: &str, sig: Signature, msg: &str) {
        Repo::tag_annotated(self, name, sig, msg);
    }
    fn stash(&mut self, sig: Signature, msg: &str, include_untracked: bool) {
        Repo::stash(self, sig, msg, include_untracked);
    }
    fn checkout_detached(&mut self, revspec: &str) {
        Repo::checkout_detached(self, revspec);
    }
    fn gitlink(&mut self, rel: &str, oid: &str) {
        Repo::gitlink(self, rel, oid);
    }
    fn checkout_orphan(&mut self, name: &str) {
        Repo::checkout_orphan(self, name);
    }
    fn rename_branch(&mut self, old: &str, new: &str) {
        Repo::rename_branch(self, old, new);
    }
    fn delete_branch(&mut self, name: &str) {
        Repo::delete_branch(self, name);
    }
    fn rm(&mut self, rel: &str) {
        Repo::rm(self, rel);
    }
    fn mv(&mut self, from: &str, to: &str) {
        Repo::mv(self, from, to);
    }
    fn merge_ff(&mut self, branch: &str) {
        Repo::merge_ff(self, branch);
    }
    fn reset_hard(&mut self, revspec: &str) {
        Repo::reset_hard(self, revspec);
    }
    fn remote(&mut self, name: &str) {
        let bare = remote_path(self.path(), name);
        trunk_fixtures::repo::init_bare(&bare, None);
        Repo::remote_add(self, name, &bare);
    }
    fn push(&mut self, remote: &str, branch: &str, set_upstream: bool) {
        Repo::push(self, remote, branch, set_upstream);
    }
    fn fetch(&mut self, remote: &str) {
        Repo::fetch(self, remote);
    }
    fn clone_bare(&mut self, name: &str) {
        let bare = remote_path(self.path(), name);
        trunk_fixtures::repo::clone_bare(self.path(), &bare);
    }
    fn remote_existing(&mut self, name: &str) {
        let bare = remote_path(self.path(), name);
        Repo::remote_add(self, name, &bare);
    }
}

/// The git binary, driven the way lib/fixture.sh drove it: isolated config, identity and
/// pinned dates through the environment.
struct GitCli {
    dir: PathBuf,
}

impl GitCli {
    fn init(dir: &Path, initial_branch: &str, identity: Identity) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let cli = GitCli {
            dir: dir.to_path_buf(),
        };
        cli.git(&["init", "-q", "-b", initial_branch], None);
        cli.git(&["config", "user.name", identity.name], None);
        cli.git(&["config", "user.email", identity.email], None);
        cli.git(&["config", "commit.gpgsign", "false"], None);

        cli
    }

    /// The operator's shell may carry GIT_DIR, GIT_WORK_TREE or injected config; any of
    /// them would point these commands at a foreign repository or change their bytes.
    fn git(&self, args: &[&str], dates: Option<(Signature, Signature)>) {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(&self.dir)
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .env_remove("GIT_CONFIG_COUNT")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null");
        if let Some((author, committer)) = dates {
            command
                .env("GIT_AUTHOR_NAME", author.identity().name)
                .env("GIT_AUTHOR_EMAIL", author.identity().email)
                .env("GIT_AUTHOR_DATE", format!("@{} +0000", author.secs()))
                .env("GIT_COMMITTER_NAME", committer.identity().name)
                .env("GIT_COMMITTER_EMAIL", committer.identity().email)
                .env("GIT_COMMITTER_DATE", format!("@{} +0000", committer.secs()));
        }
        let output = command.output().expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

impl Build for GitCli {
    fn write(&mut self, rel: &str, content: &str) {
        let path = self.dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    fn add_all(&mut self) {
        self.git(&["add", "-A"], None);
    }
    fn add(&mut self, rels: &[&str]) {
        let mut args = vec!["add", "--"];
        args.extend(rels);
        self.git(&args, None);
    }
    fn commit(&mut self, sig: Signature, msg: &str) {
        self.git(&["commit", "-q", "-m", msg], Some((sig, sig)));
    }
    fn commit_split(&mut self, author: Signature, committer: Signature, msg: &str) {
        self.git(&["commit", "-q", "-m", msg], Some((author, committer)));
    }
    fn branch(&mut self, name: &str) {
        self.git(&["branch", name], None);
    }
    fn branch_at(&mut self, name: &str, revspec: &str) {
        self.git(&["branch", name, revspec], None);
    }
    fn checkout(&mut self, branch: &str) {
        self.git(&["checkout", "-q", branch], None);
    }
    fn merge(&mut self, sig: Signature, msg: &str, heads: &[&str]) {
        let mut args = vec!["merge", "-q", "--no-ff", "-m", msg];
        args.extend(heads);
        self.git(&args, Some((sig, sig)));
    }
    fn tag(&mut self, name: &str, revspec: &str) {
        self.git(&["tag", name, revspec], None);
    }
    fn tag_annotated(&mut self, name: &str, sig: Signature, msg: &str) {
        self.git(&["tag", "-a", name, "-m", msg], Some((sig, sig)));
    }
    fn stash(&mut self, sig: Signature, msg: &str, include_untracked: bool) {
        let mut args = vec!["stash", "push", "-q"];
        if include_untracked {
            args.push("-u");
        }
        args.extend(["-m", msg]);
        self.git(&args, Some((sig, sig)));
    }
    fn checkout_detached(&mut self, revspec: &str) {
        self.git(&["checkout", "-q", "--detach", revspec], None);
    }
    fn gitlink(&mut self, rel: &str, oid: &str) {
        let entry = format!("160000,{oid},{rel}");
        self.git(&["update-index", "--add", "--cacheinfo", &entry], None);
    }
    fn checkout_orphan(&mut self, name: &str) {
        self.git(&["checkout", "-q", "--orphan", name], None);
        self.git(&["rm", "-rqf", "."], None);
    }
    fn rename_branch(&mut self, old: &str, new: &str) {
        self.git(&["branch", "-M", old, new], None);
    }
    fn delete_branch(&mut self, name: &str) {
        self.git(&["branch", "-q", "-D", name], None);
    }
    fn rm(&mut self, rel: &str) {
        self.git(&["rm", "-q", "--", rel], None);
    }
    fn mv(&mut self, from: &str, to: &str) {
        self.git(&["mv", "--", from, to], None);
    }
    fn merge_ff(&mut self, branch: &str) {
        self.git(&["merge", "-q", branch], None);
    }
    fn reset_hard(&mut self, revspec: &str) {
        self.git(&["reset", "-q", "--hard", revspec], None);
    }
    fn remote(&mut self, name: &str) {
        let bare = remote_path(&self.dir, name);
        std::fs::create_dir_all(&bare).unwrap();
        let bare = bare.to_str().unwrap().to_owned();
        self.git(&["init", "-q", "--bare", &bare], None);
        self.git(&["remote", "add", name, &bare], None);
    }
    fn push(&mut self, remote: &str, branch: &str, set_upstream: bool) {
        let mut args = vec!["push", "-q"];
        if set_upstream {
            args.push("-u");
        }
        args.extend([remote, branch]);
        self.git(&args, None);
    }
    fn fetch(&mut self, remote: &str) {
        self.git(&["fetch", "-q", remote], None);
    }
    fn clone_bare(&mut self, name: &str) {
        let bare = remote_path(&self.dir, name);
        let bare = bare.to_str().unwrap().to_owned();
        let source = self.dir.to_str().unwrap().to_owned();
        self.git(&["clone", "-q", "--bare", &source, &bare], None);
    }
    fn remote_existing(&mut self, name: &str) {
        let bare = remote_path(&self.dir, name);
        let bare = bare.to_str().unwrap().to_owned();
        self.git(&["remote", "add", name, &bare], None);
    }
}

/// Every verb the corpus uses, in the shapes it uses them: doc-45 §3's commits on two
/// branches, --no-ff merge, tags and split-date commit; case 05-01's three-topic octopus;
/// a stash of each flavour, with a commit after them that would capture anything a stash
/// left on disk; a stash taken with HEAD detached; then a gitlink, an orphan branch, a
/// branch renamed and deleted, rm and mv, a fast-forward merge, a hard reset and a final
/// detach.
fn scenario(b: &mut impl Build) {
    b.write("README.md", "# Parity\n");
    b.add_all();
    b.commit(day(0), "feat: initial commit");
    b.write("src/lib.rs", "pub fn one() {}\n");
    b.add(&["src/lib.rs"]);
    b.commit(day(1), "feat: add a library");

    b.branch("feature");
    b.checkout("feature");
    b.write("src/feature.rs", "pub fn feature() {}\n");
    b.add_all();
    b.commit(day(2), "feat: feature work\n\nWith a body that says why.");
    b.checkout("main");
    b.write("docs/notes.md", "notes\n");
    b.add_all();
    b.commit_split(
        day(30),
        day(3),
        "docs: notes written earlier, committed later",
    );
    b.merge(day(4), "Merge branch 'feature'", &["feature"]);

    b.branch("topic-a");
    b.checkout("topic-a");
    b.write("a.txt", "a\n");
    b.add_all();
    b.commit(day(5), "feat: topic a");
    b.checkout("main");
    b.branch_at("topic-b", "main~1");
    b.checkout("topic-b");
    b.write("b.txt", "b\n");
    b.add_all();
    b.commit(day(6), "feat: topic b");
    b.checkout("main");
    b.merge(day(7), "Merge topics a and b", &["topic-a", "topic-b"]);

    b.tag("v0.1.0", "main~2");
    b.tag_annotated("v1.0.0", day(8), "Release 1.0.0\n\nThe first release.");

    for (n, topic) in ["topic-c", "topic-d", "topic-e"].iter().enumerate() {
        b.branch(topic);
        b.checkout(topic);
        b.write(&format!("{topic}.txt"), &format!("{topic}\n"));
        b.add_all();
        b.commit(day(9 + n as i64), &format!("feat: {topic}"));
        b.checkout("main");
    }
    b.write("main-two.txt", "main two\n");
    b.add_all();
    b.commit(day(12), "feat: main two");
    b.merge(
        day(13),
        "octopus three topics",
        &["topic-c", "topic-d", "topic-e"],
    );

    b.write("README.md", "# Parity, half-finished\n");
    b.stash(day(20), "half-finished notes", false);
    b.write("src/wip.rs", "pub fn wip() {}\n");
    b.add(&["src/wip.rs"]);
    b.stash(day(21), "WIP: a file staged as new", false);
    b.write("src/untracked.rs", "pub fn untracked() {}\n");
    b.write("a.txt", "a, edited\n");
    b.stash(day(22), "WIP: mixed tracked and untracked", true);
    b.write("after-the-stashes.txt", "clean\n");
    b.add_all();
    b.commit(day(23), "feat: after the stashes");
    b.checkout_detached("main~1");
    b.write("b.txt", "b, edited while detached\n");
    b.stash(day(24), "detached work", false);

    b.checkout("main");
    b.gitlink("vendor/dep", "1111111111111111111111111111111111111111");
    b.commit(
        day(25),
        "sub: add a submodule pointer\n\nSetup only: a gitlink entry.",
    );
    b.gitlink("vendor/dep", "2222222222222222222222222222222222222222");
    b.commit(day(26), "sub: bump the submodule pointer");
    b.checkout_orphan("gh-pages");
    b.write("index.html", "<html><body>Hello</body></html>\n");
    b.add_all();
    b.commit(day(27), "Initial GitHub Pages commit");
    b.write("style.css", "body { margin: 0 }\n");
    b.add_all();
    b.commit(day(28), "Add styles");
    b.checkout("main");
    b.rename_branch("main", "old");
    b.branch("new");
    b.checkout("new");
    b.write("new-one.txt", "new one\n");
    b.add_all();
    b.commit(day(29), "new one");
    b.checkout("old");
    b.rename_branch("old", "main");
    b.branch("scratch");
    b.checkout("scratch");
    b.write("released.txt", "released\n");
    b.add_all();
    b.commit(day(30), "released one");
    b.tag("v2.0.0", "HEAD");
    b.checkout("main");
    b.delete_branch("scratch");
    b.rm("docs/notes.md");
    b.commit(day(31), "docs: drop the notes");
    b.mv("src/lib.rs", "src/library.rs");
    b.commit(day(32), "refactor: rename the library file");
    b.branch("quick-fix");
    b.checkout("quick-fix");
    b.write("src/fix.rs", "// quick fix\n");
    b.add_all();
    b.commit(day(33), "fix: quick patch");
    b.checkout("main");
    b.merge_ff("quick-fix");
    b.write("after-the-fast-forward.txt", "the worktree followed\n");
    b.add_all();
    b.commit(day(34), "feat: after the fast-forward");
    b.write("dropped.txt", "dropped\n");
    b.add_all();
    b.commit(day(35), "feat: to be reset away");
    b.reset_hard("HEAD~1");
    b.write("after-the-reset.txt", "the index and worktree were reset\n");
    b.add_all();
    b.commit(day(36), "feat: after the reset");
    b.checkout_detached("main~2");

    b.checkout("main");
    b.remote("origin");
    b.write("base-one.txt", "base one\n");
    b.add_all();
    b.commit(day(40), "base one");
    b.write("base-two.txt", "base two\n");
    b.add_all();
    b.commit(day(41), "base two");
    b.push("origin", "main", true);
    b.write("upstream-three.txt", "upstream three\n");
    b.add_all();
    b.commit(day(42), "upstream three");
    b.write("upstream-four.txt", "upstream four\n");
    b.add_all();
    b.commit(day(43), "upstream four");
    b.write("upstream-five.txt", "upstream five\n");
    b.add_all();
    b.commit(day(44), "upstream five");
    b.push("origin", "main", false);
    b.reset_hard("HEAD~3");
    b.fetch("origin");

    b.merge_ff("origin/main");
    b.remote("upstream");
    b.push("upstream", "main", false);
    b.write("shared-three.txt", "shared three\n");
    b.add_all();
    b.commit(day(45), "shared three");
    b.push("origin", "main", false);

    b.clone_bare("mirror");
    b.remote_existing("mirror");
    b.fetch("mirror");
}

/// The working repository and every bare repository beside it, as the fingerprint lists
/// them.
fn side(root: &Path, name: &str) -> Vec<String> {
    let mut bare: Vec<String> = std::fs::read_dir(root.join(format!("{name}.remotes")))
        .unwrap()
        .map(|entry| {
            let file = entry.unwrap().file_name();
            format!("{name}.remotes/{}", file.to_str().unwrap())
        })
        .collect();
    bare.sort();
    let mut paths = vec![name.to_owned()];
    paths.extend(bare);

    paths
}

fn as_strs(paths: &[String]) -> Vec<&str> {
    paths.iter().map(String::as_str).collect()
}

fn assert_same_fingerprint(root: &Path, git_side: &str, repo_side: &str) {
    let git_paths = side(root, git_side);
    let repo_paths = side(root, repo_side);
    let expected = fingerprint::fingerprint(root, &as_strs(&git_paths)).unwrap();
    let actual = fingerprint::fingerprint(root, &as_strs(&repo_paths)).unwrap();
    let strip = |text: &str| {
        text.lines()
            .filter(|line| !line.starts_with("repo "))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let (expected, actual) = (strip(&expected), strip(&actual));
    if expected != actual {
        let mut report = String::from("git and Repo disagree:\n");
        for (want, got) in expected.iter().zip(&actual) {
            if want != got {
                report.push_str(&format!("  git:  {want}\n  repo: {got}\n"));
            }
        }
        if expected.len() != actual.len() {
            report.push_str(&format!(
                "  git printed {} lines, repo {}\n",
                expected.len(),
                actual.len()
            ));
        }
        panic!("{report}");
    }
}

/// The scenario built on both sides, under `root/git` and `root/repo`.
fn build_both(root: &Path) {
    let mut git = GitCli::init(&root.join("git"), "main", FIXTURE);
    let mut repo = Repo::init(&root.join("repo"), "main", FIXTURE);
    repo.config("commit.gpgsign", "false");

    scenario(&mut git);
    scenario(&mut repo);
}

#[test]
fn the_repo_verbs_write_the_bytes_git_writes() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();

    build_both(root.path());

    assert_same_fingerprint(root.path(), "git", "repo");
}

#[test]
fn the_stash_reflog_is_byte_identical_to_gits() {
    trunk_fixtures::isolate();
    let root = tempfile::tempdir().unwrap();

    build_both(root.path());

    let log = |side: &str| {
        std::fs::read_to_string(root.path().join(side).join(".git/logs/refs/stash")).unwrap()
    };
    assert_eq!(log("repo"), log("git"));
}
