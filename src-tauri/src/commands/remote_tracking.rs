//! Which remote a remote-tracking ref belongs to, and which branch there it
//! stands for, read through the repository's fetch refspecs.

/// The repository's remotes, read once so that naming the remote of every
/// remote-tracking ref does not reread the config per ref, as
/// `Repository::branch_remote_name` does.
pub struct Remotes<'repo> {
    remotes: Vec<git2::Remote<'repo>>,
}

/// A branch on a remote, as `git push --delete <remote> <branch>` names it.
pub struct RemoteBranch {
    pub remote: String,
    pub branch: String,
}

impl<'repo> Remotes<'repo> {
    pub fn read(repo: &'repo git2::Repository) -> Self {
        let remotes = repo
            .remotes()
            .map(|names| {
                names
                    .iter()
                    .flatten()
                    .flatten()
                    .filter_map(|name| repo.find_remote(name).ok())
                    .collect()
            })
            .unwrap_or_default();
        Self { remotes }
    }

    /// The one remote whose fetch refspec writes `remote_ref`, or `None` when no
    /// remote does or more than one does, the cases `branch_remote_name` refuses.
    pub fn name_of(&self, remote_ref: &str) -> Option<String> {
        self.writer_of(remote_ref)
            .and_then(|writer| writer.name().ok().flatten().map(str::to_owned))
    }

    /// The branch that remote-tracking branch `name`, such as `origin/feature`,
    /// stands for, on the remote the sidebar files it under: the one remote whose
    /// fetch refspec writes it, read back through that refspec, and otherwise the
    /// configured remote named by the part of `name` before its first `/`.
    pub fn source_of(&self, name: &str) -> Option<RemoteBranch> {
        let remote_ref = format!("refs/remotes/{name}");

        if let Some(writer) = self.writer_of(&remote_ref) {
            let branch = writer.refspecs().find_map(|spec| {
                let spelled = spelled_by(&spec, &remote_ref)?;
                spec.rtransform(spelled)
                    .ok()?
                    .as_str()
                    .ok()
                    .map(str::to_owned)
            })?;
            let remote = writer.name().ok().flatten()?.to_owned();
            return Some(RemoteBranch { remote, branch });
        }

        let (remote, branch) = name.split_once('/')?;
        self.remotes
            .iter()
            .any(|configured| configured.name().ok().flatten() == Some(remote))
            .then(|| RemoteBranch {
                remote: remote.to_owned(),
                branch: branch.to_owned(),
            })
    }

    fn writer_of(&self, remote_ref: &str) -> Option<&git2::Remote<'repo>> {
        let mut writers = self.remotes.iter().filter(|remote| {
            remote
                .refspecs()
                .any(|spec| spelled_by(&spec, remote_ref).is_some())
        });
        let writer = writers.next()?;

        if writers.next().is_some() {
            return None;
        }

        Some(writer)
    }
}

/// Remote-tracking ref `remote_ref` as the destination of fetch refspec `spec`
/// spells it, when `spec` writes it. libgit2 reads a destination written as
/// `remotes/...` as `refs/remotes/...`, and matching `remote_ref` against the
/// destination as written would miss it.
pub fn spelled_by<'r>(spec: &git2::Refspec<'_>, remote_ref: &'r str) -> Option<&'r str> {
    if spec.direction() != git2::Direction::Fetch {
        return None;
    }

    let (_, dst) = spec.str().ok()?.split_once(':')?;
    let spelled = if dst.starts_with("remotes/") {
        remote_ref.strip_prefix("refs/")?
    } else {
        remote_ref
    };
    spec.dst_matches(spelled).then_some(spelled)
}
