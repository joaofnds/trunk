//! A textual fingerprint of everything Trunk can observe in a repository: references, the
//! stash reflog, HEAD, the repository state, a stopped merge's files, unmerged index stages,
//! worktree status with index and worktree blob ids, ignored paths and branch upstreams.
//! Two builds of one fixture are compared by their fingerprints.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

use git2::{ErrorCode, ObjectType, Oid, Repository, RepositoryState, Status, StatusOptions};

/// libgit2's `GIT_INDEX_ENTRY_STAGEMASK` and `GIT_INDEX_ENTRY_STAGESHIFT`; git2 0.21 exposes
/// no stage accessor on an index entry.
const STAGE_MASK: u16 = 0x3000;
const STAGE_SHIFT: u16 = 12;

/// The fingerprint of every repository at `repos` (relative to `root`), one block each,
/// in the order given, separated by a blank line.
pub fn fingerprint(root: &Path, repos: &[&str]) -> Result<String, git2::Error> {
    let blocks = repos
        .iter()
        .map(|rel| repository(root, rel))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(blocks.join("\n"))
}

/// One repository's block. The path is opened as given, never discovered upward, so a
/// wrong path fails instead of fingerprinting an enclosing checkout.
fn repository(root: &Path, rel: &str) -> Result<String, git2::Error> {
    let repo = Repository::open(root.join(rel))?;
    let mut out = String::new();
    let _ = writeln!(out, "repo {rel}");
    out.push_str(&head(&repo)?);
    out.push_str(&references(&repo)?);
    if repo.is_bare() {
        return Ok(out);
    }

    out.push_str(&stashes(&repo)?);
    let _ = writeln!(out, "state {}", state(repo.state()));
    out.push_str(&merge_files(&repo));
    out.push_str(&unmerged(&repo)?);
    out.push_str(&statuses(&repo)?);
    out.push_str(&upstreams(&repo)?);

    Ok(out)
}

fn head(repo: &Repository) -> Result<String, git2::Error> {
    match repo.head() {
        Ok(head) if repo.head_detached()? => Ok(format!(
            "head detached {}\n",
            head.target().expect("a detached HEAD is direct")
        )),
        Ok(head) => Ok(format!(
            "head branch {}\n",
            head.name().expect("a branch name is utf-8")
        )),
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let symbolic = repo.find_reference("HEAD")?;
            Ok(format!(
                "head unborn {}\n",
                symbolic
                    .symbolic_target()?
                    .expect("an unborn HEAD is symbolic")
            ))
        }
        Err(e) => Err(e),
    }
}

fn references(repo: &Repository) -> Result<String, git2::Error> {
    let mut lines = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        let name = reference.name().expect("a reference name is utf-8");
        let line = match reference.target() {
            Some(oid) => format!("ref {name} {oid}\n"),
            None => format!(
                "symref {name} {}\n",
                reference
                    .symbolic_target()?
                    .expect("a symbolic reference has a target")
            ),
        };
        lines.push((name.to_owned(), line));
    }
    lines.sort();

    Ok(lines.into_iter().map(|(_, line)| line).collect())
}

fn stashes(repo: &Repository) -> Result<String, git2::Error> {
    if repo.find_reference("refs/stash").is_err() {
        return Ok(String::new());
    }

    let log = repo.reflog("refs/stash")?;
    let mut out = String::new();
    for (n, entry) in log.iter().enumerate() {
        let _ = writeln!(
            out,
            "stash {n} {} {}",
            entry.id_new(),
            entry.message()?.unwrap_or_default()
        );
    }

    Ok(out)
}

fn state(state: RepositoryState) -> &'static str {
    match state {
        RepositoryState::Clean => "clean",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert => "revert",
        RepositoryState::RevertSequence => "revert-sequence",
        RepositoryState::CherryPick => "cherry-pick",
        RepositoryState::CherryPickSequence => "cherry-pick-sequence",
        RepositoryState::Bisect => "bisect",
        RepositoryState::Rebase => "rebase",
        RepositoryState::RebaseInteractive => "rebase-interactive",
        RepositoryState::RebaseMerge => "rebase-merge",
        RepositoryState::ApplyMailbox => "apply-mailbox",
        RepositoryState::ApplyMailboxOrRebase => "apply-mailbox-or-rebase",
    }
}

fn merge_files(repo: &Repository) -> String {
    let mut out = String::new();
    if let Ok(heads) = std::fs::read_to_string(repo.path().join("MERGE_HEAD")) {
        for head in heads.lines().filter(|line| !line.is_empty()) {
            let _ = writeln!(out, "merge-head {head}");
        }
    }
    if let Ok(message) = std::fs::read(repo.path().join("MERGE_MSG")) {
        let escaped = String::from_utf8_lossy(&message)
            .replace('\\', "\\\\")
            .replace('\n', "\\n")
            .replace('\t', "\\t");
        let _ = writeln!(out, "merge-msg {escaped}");
    }

    out
}

fn unmerged(repo: &Repository) -> Result<String, git2::Error> {
    let index = repo.index()?;
    let mut lines = Vec::new();
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        for entry in [conflict.ancestor, conflict.our, conflict.their]
            .into_iter()
            .flatten()
        {
            let path = String::from_utf8_lossy(&entry.path).into_owned();
            let stage = (entry.flags & STAGE_MASK) >> STAGE_SHIFT;
            let line = format!("unmerged {stage} {:o} {} {path}\n", entry.mode, entry.id);
            lines.push((path, stage, line));
        }
    }
    lines.sort();

    Ok(lines.into_iter().map(|(_, _, line)| line).collect())
}

fn statuses(repo: &Repository) -> Result<String, git2::Error> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(true)
        .recurse_ignored_dirs(true);
    let index = repo.index()?;
    let workdir = repo.workdir().expect("a non-bare repository has a workdir");

    let mut status_lines = Vec::new();
    let mut ignored_lines = Vec::new();
    for entry in repo.statuses(Some(&mut options))?.iter() {
        let path = entry.path().expect("a status path is utf-8").to_owned();
        let status = entry.status();
        if status.contains(Status::IGNORED) {
            ignored_lines.push(format!("ignored {path}\n"));
            continue;
        }

        let index_oid = index
            .get_path(Path::new(&path), 0)
            .map_or_else(|| "-".to_owned(), |entry| entry.id.to_string());
        let worktree_oid = worktree_blob(&workdir.join(&path))?;
        let line = format!(
            "status {} {path} {index_oid} {worktree_oid}\n",
            porcelain(status)
        );
        status_lines.push((path, line));
    }
    status_lines.sort();
    ignored_lines.sort();

    Ok(status_lines
        .into_iter()
        .map(|(_, line)| line)
        .chain(ignored_lines)
        .collect())
}

/// The two porcelain columns, with `.` where porcelain prints a space so every line
/// still splits on whitespace. libgit2 reports a conflict as one bit, so every conflicted
/// path reads `UU`.
fn porcelain(status: Status) -> String {
    if status.contains(Status::CONFLICTED) {
        return "UU".to_owned();
    }
    let index = [
        (Status::INDEX_NEW, 'A'),
        (Status::INDEX_MODIFIED, 'M'),
        (Status::INDEX_DELETED, 'D'),
        (Status::INDEX_RENAMED, 'R'),
        (Status::INDEX_TYPECHANGE, 'T'),
    ];
    let worktree = [
        (Status::WT_MODIFIED, 'M'),
        (Status::WT_DELETED, 'D'),
        (Status::WT_RENAMED, 'R'),
        (Status::WT_TYPECHANGE, 'T'),
    ];
    let x = column(status, &index);
    if x == '.' && status.contains(Status::WT_NEW) {
        return "??".to_owned();
    }

    format!("{x}{}", column(status, &worktree))
}

fn column(status: Status, letters: &[(Status, char)]) -> char {
    letters
        .iter()
        .find(|(bit, _)| status.contains(*bit))
        .map_or('.', |(_, letter)| *letter)
}

/// The blob id of what is on disk at `path`, hashed without writing to the object store;
/// `-` when no file or symlink is there: deleted, or a gitlink, with or without a directory.
fn worktree_blob(path: &Path) -> Result<String, git2::Error> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok("-".to_owned());
    };
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(path).expect("a symlink has a target");
        let bytes = target.as_os_str().as_encoded_bytes();
        return Ok(Oid::hash_object(ObjectType::Blob, bytes)?.to_string());
    }
    if !metadata.is_file() {
        return Ok("-".to_owned());
    }

    Ok(Oid::hash_file(ObjectType::Blob, path)?.to_string())
}

fn upstreams(repo: &Repository) -> Result<String, git2::Error> {
    let config = repo.config()?.snapshot()?;
    let mut remotes = BTreeMap::new();
    let mut merges = BTreeMap::new();
    let mut entries = config.entries(Some("^branch\\..*\\.(remote|merge)$"))?;
    while let Some(entry) = entries.next() {
        let entry = entry?;
        let name = entry.name().expect("a config key is utf-8");
        let value = entry.value().unwrap_or_default().to_owned();
        let branch = &name["branch.".len()..];
        if let Some(branch) = branch.strip_suffix(".remote") {
            remotes.insert(branch.to_owned(), value);
        } else if let Some(branch) = branch.strip_suffix(".merge") {
            merges.insert(branch.to_owned(), value);
        }
    }

    let mut out = String::new();
    for (branch, remote) in &remotes {
        if let Some(merge) = merges.get(branch) {
            let _ = writeln!(out, "upstream {branch} {remote} {merge}");
        }
    }

    Ok(out)
}
