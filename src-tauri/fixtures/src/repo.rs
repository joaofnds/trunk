//! The verbs the case modules are written in: one repository, driven imperatively, writing
//! the same bytes the git binary wrote for the shell corpus (doc-45 §3 and §4). A verb
//! panics on a git error: a fixture that cannot be built is a broken fixture, not a
//! condition to handle.

use std::path::{Path, PathBuf};

use git2::build::CheckoutBuilder;
use git2::{Commit, Oid, Repository, RepositoryInitOptions, Time};

/// Who authors and commits: fixed per case so the author column is the same on every
/// machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub name: &'static str,
    pub email: &'static str,
}

impl Identity {
    /// This identity at a pinned instant, UTC.
    pub const fn at(self, secs: i64) -> Signature {
        Signature {
            identity: self,
            secs,
        }
    }
}

/// An identity at a pinned instant, offset zero: what the shell passed as
/// `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Signature {
    identity: Identity,
    secs: i64,
}

impl Signature {
    pub fn identity(self) -> Identity {
        self.identity
    }

    pub fn secs(self) -> i64 {
        self.secs
    }

    fn to_git2(self) -> git2::Signature<'static> {
        git2::Signature::new(
            self.identity.name,
            self.identity.email,
            &Time::new(self.secs, 0),
        )
        .expect("a fixture identity is a valid signature")
    }
}

pub struct Repo {
    repo: Repository,
    workdir: PathBuf,
}

impl Repo {
    /// `git init -q -b <initial_branch>` plus the identity in the repository config.
    pub fn init(path: &Path, initial_branch: &str, identity: Identity) -> Repo {
        let mut options = RepositoryInitOptions::new();
        options.initial_head(initial_branch);
        let repo = Repository::init_opts(path, &options).expect("init the repository");
        let workdir = repo
            .workdir()
            .expect("an initialised repository has a workdir")
            .to_path_buf();
        let mut this = Repo { repo, workdir };
        this.config("user.name", identity.name);
        this.config("user.email", identity.email);

        this
    }

    /// `git config <key> <value>` in the repository's own config.
    pub fn config(&mut self, key: &str, value: &str) {
        self.repo
            .config()
            .expect("open the repository config")
            .set_str(key, value)
            .expect("write the repository config");
    }

    /// Write exactly `content` at `rel`, creating parent directories. The shell's
    /// `fixture_write` and `echo` appended one newline; `printf '%s'` did not. The case
    /// module carries whichever newline the script produced.
    pub fn write(&mut self, rel: &str, content: &str) {
        self.write_bytes(rel, content.as_bytes());
    }

    pub fn write_bytes(&mut self, rel: &str, content: &[u8]) {
        let path = self.workdir.join(rel);
        std::fs::create_dir_all(path.parent().expect("a file path has a parent"))
            .expect("create the parent directories");
        std::fs::write(path, content).expect("write the file");
    }

    /// `git add -A`: honours `.gitignore`, stages deletions.
    pub fn add_all(&mut self) {
        let mut index = self.index();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .expect("stage every change");
        index.write().expect("write the index");
    }

    /// `git add -- <rels>`.
    pub fn add(&mut self, rels: &[&str]) {
        let mut index = self.index();
        for rel in rels {
            index.add_path(Path::new(rel)).expect("stage the path");
        }
        index.write().expect("write the index");
    }

    /// `git commit -qm <msg>` at a pinned date. The message gets the trailing newline git
    /// stores; the caller never adds one.
    pub fn commit(&mut self, sig: Signature, msg: &str) -> Oid {
        self.commit_split(sig, sig, msg)
    }

    /// A commit whose author and committer dates differ.
    pub fn commit_split(&mut self, author: Signature, committer: Signature, msg: &str) -> Oid {
        let tree_oid = self.index().write_tree().expect("write the index tree");
        let tree = self
            .repo
            .find_tree(tree_oid)
            .expect("find the written tree");
        let parent = self.head_commit();
        let parents: Vec<&Commit> = parent.iter().collect();

        self.repo
            .commit(
                Some("HEAD"),
                &author.to_git2(),
                &committer.to_git2(),
                &format!("{msg}\n"),
                &tree,
                &parents,
            )
            .expect("write the commit")
    }

    /// `git branch <name>` at HEAD.
    pub fn branch(&mut self, name: &str) {
        let head = self
            .head_commit()
            .expect("a branch needs a commit to point at");
        self.repo
            .branch(name, &head, false)
            .expect("create the branch");
    }

    /// `git branch <name> <revspec>`.
    pub fn branch_at(&mut self, name: &str, revspec: &str) {
        let commit = self.resolve(revspec);
        self.repo
            .branch(name, &commit, false)
            .expect("create the branch");
    }

    /// `git checkout <branch>`: HEAD moves to the branch and the worktree follows.
    pub fn checkout(&mut self, branch: &str) {
        self.repo
            .set_head(&format!("refs/heads/{branch}"))
            .expect("point HEAD at the branch");
        self.checkout_head();
    }

    /// `git merge --no-ff -m <msg> <heads...>`: one commit on HEAD with the current commit
    /// and every head as parents, each head's tree merged in order onto the running
    /// result (doc-45 §3.3). Panics if any head conflicts.
    pub fn merge(&mut self, sig: Signature, msg: &str, heads: &[&str]) -> Oid {
        let ours = self.head_commit().expect("a merge needs a HEAD commit");
        let theirs: Vec<Commit> = heads.iter().map(|head| self.resolve(head)).collect();
        let mut tree = ours.tree().expect("read the HEAD tree");
        for their in &theirs {
            let base_oid = self
                .repo
                .merge_base(ours.id(), their.id())
                .expect("find the merge base");
            let base_tree = self
                .repo
                .find_commit(base_oid)
                .and_then(|base| base.tree())
                .expect("read the base tree");
            let their_tree = their.tree().expect("read the merged head's tree");
            let mut merged = self
                .repo
                .merge_trees(&base_tree, &tree, &their_tree, None)
                .expect("merge the trees");
            assert!(
                !merged.has_conflicts(),
                "merging {} into HEAD conflicts; the fixture asked for a clean --no-ff merge",
                their.id()
            );
            let merged_oid = merged
                .write_tree_to(&self.repo)
                .expect("write the merged tree");
            tree = self
                .repo
                .find_tree(merged_oid)
                .expect("find the merged tree");
        }
        let mut parents = vec![&ours];
        parents.extend(theirs.iter());
        let signature = sig.to_git2();
        let merge = self
            .repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                &format!("{msg}\n"),
                &tree,
                &parents,
            )
            .expect("write the merge commit");
        self.checkout_head();

        merge
    }

    /// `git tag <name> <revspec>`.
    pub fn tag(&mut self, name: &str, revspec: &str) {
        let target = self
            .repo
            .revparse_single(revspec)
            .expect("resolve the tag target");
        self.repo
            .tag_lightweight(name, &target, false)
            .expect("create the tag");
    }

    /// `git tag -a <name> -m <msg>` on HEAD, at a pinned date.
    pub fn tag_annotated(&mut self, name: &str, sig: Signature, msg: &str) {
        let head = self
            .head_commit()
            .expect("an annotated tag needs a commit to point at");
        self.repo
            .tag(
                name,
                head.as_object(),
                &sig.to_git2(),
                &format!("{msg}\n"),
                false,
            )
            .expect("create the annotated tag");
    }

    fn index(&self) -> git2::Index {
        self.repo.index().expect("open the index")
    }

    fn head_commit(&self) -> Option<Commit<'_>> {
        self.repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok())
    }

    fn resolve(&self, revspec: &str) -> Commit<'_> {
        self.repo
            .revparse_single(revspec)
            .and_then(|object| object.peel_to_commit())
            .unwrap_or_else(|e| panic!("resolve {revspec} to a commit: {e}"))
    }

    fn checkout_head(&self) {
        self.repo
            .checkout_head(Some(CheckoutBuilder::new().force()))
            .expect("make the worktree match HEAD");
    }
}
