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

    /// `git update-index --add --cacheinfo 160000,<oid>,<rel>`: a submodule pointer in the
    /// index. The object need not exist anywhere.
    pub fn gitlink(&mut self, rel: &str, oid: &str) {
        let mut index = self.index();
        let id = Oid::from_str(oid).expect("a gitlink target is a hex OID");
        index
            .add(&index_entry(0o160000, id, 0, rel))
            .expect("stage the gitlink");
        index.write().expect("write the index");
    }

    /// `git checkout --orphan <name>` followed by the removal of every tracked file, as
    /// cases 05 and 09 do it: an unborn branch, an empty index and a worktree holding only
    /// `.git`, so the next commit has no parent. Untracked files go too, which the
    /// corpus never has at that point.
    pub fn checkout_orphan(&mut self, name: &str) {
        self.repo
            .set_head(&format!("refs/heads/{name}"))
            .expect("point HEAD at the unborn branch");
        let mut index = self.index();
        index.clear().expect("empty the index");
        index.write().expect("write the index");
        for entry in std::fs::read_dir(&self.workdir).expect("list the worktree") {
            let path = entry.expect("read a worktree entry").path();
            if path.file_name().is_some_and(|name| name == ".git") {
                continue;
            }
            if path.is_dir() {
                std::fs::remove_dir_all(&path).expect("empty the worktree");
            } else {
                std::fs::remove_file(&path).expect("empty the worktree");
            }
        }
    }

    /// `git branch -M <old> <new>`; HEAD follows when it pointed at the old name.
    pub fn rename_branch(&mut self, old: &str, new: &str) {
        self.repo
            .find_branch(old, git2::BranchType::Local)
            .expect("find the branch to rename")
            .rename(new, true)
            .expect("rename the branch");
    }

    /// `git branch -D <name>`.
    pub fn delete_branch(&mut self, name: &str) {
        self.repo
            .find_branch(name, git2::BranchType::Local)
            .expect("find the branch to delete")
            .delete()
            .expect("delete the branch");
    }

    /// `git rm -q -- <rel>`: git refuses a path it does not track, and so does this.
    pub fn rm(&mut self, rel: &str) {
        let mut index = self.index();
        assert!(
            index.get_path(Path::new(rel), 0).is_some(),
            "rm {rel}: not a tracked path"
        );
        let path = self.workdir.join(rel);
        std::fs::remove_file(&path).expect("remove the file");
        self.remove_emptied_directories(&path);
        index
            .remove_path(Path::new(rel))
            .expect("unstage the removed file");
        index.write().expect("write the index");
    }

    /// `git mv <from> <to>`: git refuses a source it does not track, and so does this.
    pub fn mv(&mut self, from: &str, to: &str) {
        let mut index = self.index();
        assert!(
            index.get_path(Path::new(from), 0).is_some(),
            "mv {from}: not a tracked path"
        );
        let source = self.workdir.join(from);
        let target = self.workdir.join(to);
        std::fs::create_dir_all(target.parent().expect("a file path has a parent"))
            .expect("create the target's parent directories");
        std::fs::rename(&source, target).expect("move the file");
        self.remove_emptied_directories(&source);
        index
            .remove_path(Path::new(from))
            .expect("unstage the old path");
        index.add_path(Path::new(to)).expect("stage the new path");
        index.write().expect("write the index");
    }

    /// `git merge <branch>` where the branch descends from HEAD: the current branch's ref
    /// moves to the tip and the worktree follows; no commit is made.
    pub fn merge_ff(&mut self, branch: &str) {
        let head = self.repo.head().expect("a fast-forward needs a HEAD");
        let current = head.name().expect("a reference name is utf-8").to_owned();
        let ours = head.target().expect("HEAD points at a commit");
        let target = self.resolve(branch).id();
        assert!(
            self.repo
                .graph_descendant_of(target, ours)
                .expect("compare the two tips"),
            "{branch} does not descend from HEAD; the fixture asked for a fast-forward"
        );
        self.repo
            .reference(
                &current,
                target,
                true,
                &format!("merge {branch}: Fast-forward"),
            )
            .expect("move the branch to the tip");
        self.checkout_head();
    }

    /// `git reset --hard <revspec>`.
    pub fn reset_hard(&mut self, revspec: &str) {
        let commit = self.resolve(revspec);
        self.repo
            .reset(commit.as_object(), git2::ResetType::Hard, None)
            .expect("reset to the commit");
    }

    /// `git checkout --detach <revspec>`.
    pub fn checkout_detached(&mut self, revspec: &str) {
        let commit = self.resolve(revspec);
        self.repo
            .set_head_detached(commit.id())
            .expect("detach HEAD at the commit");
        self.checkout_head();
    }

    /// `git stash push -q [-u] -m <msg>` at a pinned date, byte for byte (doc-45 §3.2).
    /// Not `stash_save`: it ends the WIP commit's message with a newline git does not
    /// write, which moves every stash OID. The index helper commit and the untracked
    /// helper commit do end with one. The reflog entry is rewritten under the pinned
    /// signature, because the ref update logs under the config identity and the wall
    /// clock. Panics when there is nothing to stash, where git would make no stash.
    pub fn stash(&mut self, sig: Signature, msg: &str, include_untracked: bool) -> Oid {
        let head = self.repo.head().expect("a stash needs a HEAD");
        let head_commit = head.peel_to_commit().expect("HEAD points at a commit");
        let branch = if head.is_branch() {
            head.shorthand().expect("a branch name is utf-8")
        } else {
            "(no branch)"
        };
        let abbrev = &head_commit.id().to_string()[..7];
        let subject = head_commit
            .summary()
            .expect("a fixture commit message is utf-8")
            .unwrap_or_default();
        let base = format!("{branch}: {abbrev} {subject}");
        let signature = sig.to_git2();

        let mut index = self.index();
        let index_tree = self
            .repo
            .find_tree(index.write_tree().expect("write the index tree"))
            .expect("find the index tree");
        let index_commit = self
            .repo
            .commit(
                None,
                &signature,
                &signature,
                &format!("index on {base}\n"),
                &index_tree,
                &[&head_commit],
            )
            .expect("write the index helper commit");
        let mut parents = vec![
            head_commit.clone(),
            self.repo
                .find_commit(index_commit)
                .expect("find the index helper commit"),
        ];

        let mut untracked = Vec::new();
        if include_untracked {
            let (commit, paths) = self.untracked_commit(&signature, &base);
            if let Some(commit) = commit {
                parents.push(
                    self.repo
                        .find_commit(commit)
                        .expect("find the untracked helper commit"),
                );
            }
            untracked = paths;
        }

        index
            .update_all(["*"], None)
            .expect("stage the tracked edits for the stash");
        let wip_tree = self
            .repo
            .find_tree(
                index
                    .write_tree_to(&self.repo)
                    .expect("write the worktree tree"),
            )
            .expect("find the worktree tree");
        let head_tree = head_commit.tree().expect("read the HEAD tree").id();
        assert!(
            index_tree.id() != head_tree || wip_tree.id() != head_tree || !untracked.is_empty(),
            "nothing to stash on {branch}: git makes no stash here, so the fixture is wrong"
        );
        let parent_refs: Vec<&Commit> = parents.iter().collect();
        let message = format!("On {base_branch}: {msg}", base_branch = branch);
        let wip = self
            .repo
            .commit(
                None,
                &signature,
                &signature,
                &message,
                &wip_tree,
                &parent_refs,
            )
            .expect("write the stash commit");

        self.repo
            .reference_ensure_log("refs/stash")
            .expect("ensure the stash reflog exists");
        self.repo
            .reference("refs/stash", wip, true, &message)
            .expect("point refs/stash at the stash commit");
        let mut log = self
            .repo
            .reflog("refs/stash")
            .expect("read the stash reflog");
        log.remove(0, false)
            .expect("drop the entry the ref update logged");
        log.append(wip, &signature, Some(&message))
            .expect("log the stash under the pinned signature");
        log.write().expect("write the stash reflog");

        self.repo
            .reset(head_commit.as_object(), git2::ResetType::Hard, None)
            .expect("reset the worktree to HEAD");
        for path in untracked {
            std::fs::remove_file(&path).expect("remove the stashed untracked file");
            self.remove_emptied_directories(&path);
        }

        wip
    }

    /// The `untracked files on …` helper commit: a tree of every untracked file, which
    /// `git stash -u` then deletes from the worktree. `None` when nothing is untracked,
    /// where git writes no helper commit.
    fn untracked_commit(
        &self,
        signature: &git2::Signature<'_>,
        base: &str,
    ) -> (Option<Oid>, Vec<PathBuf>) {
        let mut tree_index = git2::Index::new().expect("create an in-memory index");
        let mut options = git2::StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        let mut paths = Vec::new();
        for entry in self
            .repo
            .statuses(Some(&mut options))
            .expect("read the worktree status")
            .iter()
        {
            if !entry.status().contains(git2::Status::WT_NEW) {
                continue;
            }
            let rel = entry.path().expect("a status path is utf-8").to_owned();
            let path = self.workdir.join(&rel);
            let (mode, bytes) = untracked_blob(&path);
            let blob = self.repo.blob(&bytes).expect("write the untracked blob");
            tree_index
                .add(&index_entry(mode, blob, bytes.len() as u32, &rel))
                .expect("add the untracked file to the helper tree");
            paths.push(path);
        }
        if paths.is_empty() {
            return (None, paths);
        }
        let tree = self
            .repo
            .find_tree(
                tree_index
                    .write_tree_to(&self.repo)
                    .expect("write the untracked tree"),
            )
            .expect("find the untracked tree");
        let commit = self
            .repo
            .commit(
                None,
                signature,
                signature,
                &format!("untracked files on {base}\n"),
                &tree,
                &[],
            )
            .expect("write the untracked helper commit");

        (Some(commit), paths)
    }

    /// `git clean -d`'s share of `git stash -u`: a directory left empty by a stashed file
    /// goes too, up to the worktree root.
    fn remove_emptied_directories(&self, path: &Path) {
        let mut dir = path.parent();
        while let Some(current) = dir {
            if current == self.workdir || std::fs::remove_dir(current).is_err() {
                break;
            }
            dir = current.parent();
        }
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

/// The index mode and blob bytes git stores for an untracked path: a symlink as its
/// target text, an executable as 100755, anything else as 100644.
fn untracked_blob(path: &Path) -> (u32, Vec<u8>) {
    use std::os::unix::fs::PermissionsExt as _;

    let metadata = std::fs::symlink_metadata(path).expect("stat the untracked path");
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(path).expect("read the symlink target");
        return (0o120000, target.as_os_str().as_encoded_bytes().to_vec());
    }
    let bytes = std::fs::read(path).expect("read the untracked file");
    let mode = if metadata.permissions().mode() & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    };

    (mode, bytes)
}

/// An index entry with no stat data, as `git update-index --cacheinfo` writes one.
fn index_entry(mode: u32, id: Oid, file_size: u32, path: &str) -> git2::IndexEntry {
    git2::IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size,
        id,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}
