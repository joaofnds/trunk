use crate::common::context::TestContext;
use trunk_lib::state::OpenRepos;

pub struct TestContextBuilder {
    steps: Vec<BuildStep>,
}

/// One index edit waiting for the next commit, kept in the order the caller
/// declared it.
enum PendingChange {
    Add(String),
    Remove(String),
}

enum BuildStep {
    WriteFile {
        path: String,
        content: Vec<u8>,
    },
    WriteBinaryFile {
        path: String,
        content: Vec<u8>,
    },
    RemoveFile {
        path: String,
    },
    Commit {
        message: String,
        secs: Option<i64>,
    },
    Branch {
        name: String,
    },
    Checkout {
        name: String,
    },
    Merge {
        branch: String,
    },
    Conflict {
        branch: String,
    },
    Tag {
        name: String,
    },
    Stash {
        message: Option<String>,
    },
    Remote {
        name: String,
    },
    Tracking {
        remote: String,
        branch: String,
    },
    Pushed {
        remote: String,
        branch: String,
    },
    RemoteCommit {
        remote: String,
        branch: String,
        path: String,
        content: String,
        message: String,
    },
}

/// 2026-01-01T00:00:00Z, the same base `scripts/qa-*-fixtures.sh` pin. Commits are spaced a
/// day apart because the graph sorts with `TOPOLOGICAL | TIME`: same-second commits sort
/// arbitrarily and can render a coincidentally-correct layout.
const FIXTURE_BASE_SECS: i64 = 1_767_225_600;
const FIXTURE_DAY_SECS: i64 = 86_400;

/// A signature pinned to `secs`, so a rebuild of one shape produces byte-identical history.
fn pinned_signature(secs: i64) -> git2::Signature<'static> {
    git2::Signature::new("Test User", "test@example.com", &git2::Time::new(secs, 0))
        .expect("build a pinned signature")
}

impl TestContextBuilder {
    pub const fn new() -> Self {
        Self { steps: Vec::new() }
    }

    pub fn with_file(&mut self, path: &str, content: &str) -> &mut Self {
        self.steps.push(BuildStep::WriteFile {
            path: path.to_string(),
            content: content.as_bytes().to_vec(),
        });
        self
    }

    pub fn with_binary_file(&mut self, path: &str, content: &[u8]) -> &mut Self {
        self.steps.push(BuildStep::WriteBinaryFile {
            path: path.to_string(),
            content: content.to_vec(),
        });
        self
    }

    /// Delete a tracked file from the workdir and the index, so the next commit
    /// records the removal. Paired with `with_file` under a new name, this is how
    /// a fixture states a rename that git must detect by content similarity.
    pub fn with_removed_file(&mut self, path: &str) -> &mut Self {
        self.steps.push(BuildStep::RemoveFile {
            path: path.to_string(),
        });
        self
    }

    pub fn with_commit(&mut self, message: &str) -> &mut Self {
        self.steps.push(BuildStep::Commit {
            message: message.to_string(),
            secs: None,
        });
        self
    }

    /// A commit at the timestamp the caller names, leaving the day-spacing clock
    /// `with_commit` reads exactly where it was.
    pub fn with_commit_at(&mut self, message: &str, secs: i64) -> &mut Self {
        self.steps.push(BuildStep::Commit {
            message: message.to_string(),
            secs: Some(secs),
        });
        self
    }

    pub fn with_branch(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Branch {
            name: name.to_string(),
        });
        self
    }

    pub fn checkout(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Checkout {
            name: name.to_string(),
        });
        self
    }

    pub fn merge(&mut self, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Merge {
            branch: branch.to_string(),
        });
        self
    }

    pub fn with_conflict(&mut self, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Conflict {
            branch: branch.to_string(),
        });
        self
    }

    pub fn with_tag(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Tag {
            name: name.to_string(),
        });
        self
    }

    pub fn with_stash(&mut self, message: Option<&str>) -> &mut Self {
        self.steps.push(BuildStep::Stash {
            message: message.map(std::string::ToString::to_string),
        });
        self
    }

    pub fn with_remote(&mut self, name: &str) -> &mut Self {
        self.steps.push(BuildStep::Remote {
            name: name.to_string(),
        });
        self
    }

    /// Points `branch` at `remote`, which `with_remote` deliberately leaves
    /// unconfigured, so a bare `git pull`/`git push` has a target.
    pub fn with_tracking(&mut self, remote: &str, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Tracking {
            remote: remote.to_string(),
            branch: branch.to_string(),
        });
        self
    }

    /// Publishes `branch` to `remote` and points the tracking ref at it, standing
    /// in for the clone the repository would have come from.
    pub fn with_pushed(&mut self, remote: &str, branch: &str) -> &mut Self {
        self.steps.push(BuildStep::Pushed {
            remote: remote.to_string(),
            branch: branch.to_string(),
        });
        self
    }

    /// Commits straight into the bare remote, standing in for another clone
    /// pushing to it. `branch` must already exist there: push it first.
    pub fn with_remote_commit(
        &mut self,
        remote: &str,
        branch: &str,
        path: &str,
        content: &str,
        message: &str,
    ) -> &mut Self {
        self.steps.push(BuildStep::RemoteCommit {
            remote: remote.to_string(),
            branch: branch.to_string(),
            path: path.to_string(),
            content: content.to_string(),
            message: message.to_string(),
        });
        self
    }

    pub fn build(&self) -> TestContext {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let mut repo = git2::Repository::init(dir.path()).expect("failed to init repo");
        // Every commit-producing step takes the next day off this clock. `repo.signature()`
        // reads the wall clock, which made two builds of one shape produce different OIDs and
        // left the graph's TOPOLOGICAL | TIME sort resolving by tie-break at machine speed.
        let mut clock = FIXTURE_BASE_SECS;

        let mut cfg = repo.config().expect("failed to get config");
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);

        repo.set_head("refs/heads/main").unwrap();

        // Index edits waiting for the next Commit, in declaration order: a step
        // rewriting a path the same commit removed must land as the caller wrote
        // it, not be cancelled by a removal replayed afterwards.
        let mut pending: Vec<PendingChange> = Vec::new();
        let mut stash_counter: usize = 0;

        for step in &self.steps {
            match step {
                BuildStep::WriteFile { path, content }
                | BuildStep::WriteBinaryFile { path, content } => {
                    write_file(dir.path(), path, content, &mut pending);
                }
                BuildStep::RemoveFile { path } => {
                    remove_file(dir.path(), path, &mut pending);
                }
                BuildStep::Commit { message, secs } => {
                    commit(&repo, message, *secs, &mut clock, &mut pending);
                }
                BuildStep::Branch { name } => branch(&repo, name),
                BuildStep::Checkout { name } => checkout(&repo, name),
                BuildStep::Merge { branch } => merge(&repo, branch, &mut clock),
                BuildStep::Conflict { branch } => conflict(&repo, branch),
                BuildStep::Tag { name } => tag(&repo, name),
                BuildStep::Stash { message } => stash(
                    &mut repo,
                    dir.path(),
                    message.as_deref(),
                    &mut clock,
                    &mut stash_counter,
                ),
                BuildStep::Remote { name } => remote(&repo, dir.path(), name),
                BuildStep::Tracking { remote, branch } => tracking(&repo, remote, branch),
                BuildStep::Pushed { remote, branch } => pushed(&repo, remote, branch),
                step @ BuildStep::RemoteCommit { .. } => {
                    remote_commit(dir.path(), step, &mut clock);
                }
            }
        }

        drop(repo);

        let path = dir.path().display().to_string();
        let state_map = OpenRepos::from_iter([(path.clone(), dir.path().to_path_buf())]);

        TestContext::from_parts(dir, path, state_map)
    }
}

/// Write a file into the working tree and queue it for the next commit.
fn write_file(
    root: &std::path::Path,
    path: &str,
    content: &[u8],
    pending: &mut Vec<PendingChange>,
) {
    let full_path = root.join(path);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&full_path, content).unwrap();
    pending.push(PendingChange::Add(path.to_string()));
}

/// Delete a file from the working tree and queue its removal.
fn remove_file(root: &std::path::Path, path: &str, pending: &mut Vec<PendingChange>) {
    std::fs::remove_file(root.join(path)).unwrap();
    pending.push(PendingChange::Remove(path.to_string()));
}

/// Commit every queued change, taking the next day off the clock unless pinned.
fn commit(
    repo: &git2::Repository,
    message: &str,
    secs: Option<i64>,
    clock: &mut i64,
    pending: &mut Vec<PendingChange>,
) {
    let sig = secs.map_or_else(
        || {
            let sig = pinned_signature(*clock);
            *clock += FIXTURE_DAY_SECS;
            sig
        },
        pinned_signature,
    );
    let mut index = repo.index().unwrap();

    for change in pending.iter() {
        match change {
            PendingChange::Add(file) => {
                index.add_path(std::path::Path::new(file.as_str())).unwrap();
            }
            PendingChange::Remove(file) => {
                index
                    .remove_path(std::path::Path::new(file.as_str()))
                    .unwrap();
            }
        }
    }
    index.write().unwrap();
    pending.clear();

    commit_index_onto_head(repo, &mut index, &sig, message);
}

/// Commit the index's tree onto HEAD, parenting on it when it already exists.
///
/// The first commit in a repository has no parent, which is the only reason
/// this takes the parent list from `repo.head()` rather than being told one.
fn commit_index_onto_head(
    repo: &git2::Repository,
    index: &mut git2::Index,
    sig: &git2::Signature<'_>,
    message: &str,
) {
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.as_ref().map(|p| vec![p]).unwrap_or_default();

    repo.commit(Some("HEAD"), sig, sig, message, &tree, &parents)
        .unwrap();
}

/// Branch at the current HEAD.
fn branch(repo: &git2::Repository, name: &str) {
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch(name, &head, false).unwrap();
}

/// Point HEAD at a branch and force the working tree to match.
fn checkout(repo: &git2::Repository, name: &str) {
    repo.set_head(&format!("refs/heads/{name}")).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
        .unwrap();
}

/// Merge a branch into HEAD, committing the result.
fn merge(repo: &git2::Repository, branch: &str, clock: &mut i64) {
    let sig = pinned_signature(*clock);
    *clock += FIXTURE_DAY_SECS;

    // Find the branch tip
    let branch_ref = repo.find_branch(branch, git2::BranchType::Local).unwrap();
    let their_commit = branch_ref.get().peel_to_commit().unwrap();

    // Get current HEAD
    let our_commit = repo.head().unwrap().peel_to_commit().unwrap();

    // Merge the two trees
    let ancestor = repo
        .find_commit(repo.merge_base(our_commit.id(), their_commit.id()).unwrap())
        .unwrap();
    let ancestor_tree = ancestor.tree().unwrap();
    let our_tree = our_commit.tree().unwrap();
    let their_tree = their_commit.tree().unwrap();

    let mut merge_index = repo
        .merge_trees(&ancestor_tree, &our_tree, &their_tree, None)
        .unwrap();

    let tree_oid = merge_index.write_tree_to(repo).unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();

    let msg = format!("Merge branch '{branch}'");
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &msg,
        &tree,
        &[&our_commit, &their_commit],
    )
    .unwrap();
}

/// Start a merge and leave the repository in its conflicted state.
fn conflict(repo: &git2::Repository, branch: &str) {
    let branch_ref = repo.find_branch(branch, git2::BranchType::Local).unwrap();
    let their_commit = branch_ref.get().peel_to_commit().unwrap();
    let annotated = repo.find_annotated_commit(their_commit.id()).unwrap();

    repo.merge(&[&annotated], None, None).unwrap();
    // Leave the repo in merge/conflict state -- do NOT commit
}

/// Tag the current HEAD.
fn tag(repo: &git2::Repository, name: &str) {
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let obj = head.as_object();
    repo.tag_lightweight(name, obj, false).unwrap();
}

/// Stash a modification, committing a marker file the first time so there is
/// something tracked to stash.
fn stash(
    repo: &mut git2::Repository,
    root: &std::path::Path,
    message: Option<&str>,
    clock: &mut i64,
    stash_counter: &mut usize,
) {
    let sig = pinned_signature(*clock);
    *clock += FIXTURE_DAY_SECS;

    // Need a tracked file that is modified to create a stash
    let stash_marker = root.join(".stash_marker");
    if !stash_marker.exists() {
        // Create and commit the marker file first
        std::fs::write(&stash_marker, "initial").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new(".stash_marker"))
            .unwrap();
        index.write().unwrap();

        commit_index_onto_head(repo, &mut index, &sig, "Add stash marker");
    }

    // Modify the tracked file to create something to stash
    std::fs::write(&stash_marker, format!("modified-{}", *stash_counter)).unwrap();
    *stash_counter += 1;

    repo.stash_save(&sig, message.unwrap_or("stash"), None)
        .unwrap();
}

/// Add a bare repository alongside the working one and register it as a remote.
fn remote(repo: &git2::Repository, root: &std::path::Path, name: &str) {
    // Create a bare repo as the remote
    let bare_path = root.join(format!("{name}.git"));
    git2::Repository::init_bare(&bare_path).unwrap();

    let bare_url = bare_path.display().to_string();
    repo.remote(name, &bare_url).unwrap();
}

/// Configure a branch's upstream.
fn tracking(repo: &git2::Repository, remote: &str, branch: &str) {
    let mut cfg = repo.config().unwrap();
    cfg.set_str(&format!("branch.{branch}.remote"), remote)
        .unwrap();
    cfg.set_str(
        &format!("branch.{branch}.merge"),
        &format!("refs/heads/{branch}"),
    )
    .unwrap();
}

/// Push a branch to its remote and seed the tracking ref.
fn pushed(repo: &git2::Repository, remote: &str, branch: &str) {
    let mut handle = repo.find_remote(remote).unwrap();
    handle
        .push(&[format!("refs/heads/{branch}:refs/heads/{branch}")], None)
        .unwrap();

    let tip = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .unwrap()
        .peel_to_commit()
        .unwrap();

    // Written here rather than left to the push: over the local transport
    // libgit2 need not update the tip, and without it the branch has no
    // upstream to be ahead of.
    repo.reference(
        &format!("refs/remotes/{remote}/{branch}"),
        tip.id(),
        true,
        "seed the tracking ref",
    )
    .unwrap();
}

/// Commit directly into the bare remote, so the local branch falls behind.
fn remote_commit(root: &std::path::Path, step: &BuildStep, clock: &mut i64) {
    let BuildStep::RemoteCommit {
        remote,
        branch,
        path,
        content,
        message,
    } = step
    else {
        unreachable!("remote_commit is only reached for a RemoteCommit step")
    };

    let sig = pinned_signature(*clock);
    *clock += FIXTURE_DAY_SECS;

    let bare_path = root.join(format!("{remote}.git"));
    let bare = git2::Repository::open(&bare_path).unwrap();
    let tip = bare
        .find_reference(&format!("refs/heads/{branch}"))
        .unwrap()
        .peel_to_commit()
        .unwrap();

    let blob = bare.blob(content.as_bytes()).unwrap();
    let mut tree = bare.treebuilder(Some(&tip.tree().unwrap())).unwrap();
    tree.insert(path, blob, git2::FileMode::Blob.into())
        .unwrap();
    let tree = bare.find_tree(tree.write().unwrap()).unwrap();

    bare.commit(
        Some(&format!("refs/heads/{branch}")),
        &sig,
        &sig,
        message,
        &tree,
        &[&tip],
    )
    .unwrap();
}
