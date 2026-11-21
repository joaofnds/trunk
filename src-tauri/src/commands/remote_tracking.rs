//! Which remote a remote-tracking ref belongs to, and which branch there it
//! stands for, read through the repository's fetch refspecs.

/// The repository's remotes, read once so that naming the remote of every
/// remote-tracking ref does not reread the config per ref, as
/// `Repository::branch_remote_name` does.
#[derive(Default)]
pub struct Remotes<'repo> {
    configured_names: Option<git2::string_array::StringArray>,
    remotes: Vec<git2::Remote<'repo>>,
}

/// A branch on a remote, as `git push --delete <remote> <branch>` names it.
pub struct RemoteBranch {
    pub remote: String,
    pub branch: String,
}

/// A symbolic default-branch alias points into its remote's own namespace.
pub fn is_remote_head_alias<'loaded, 'repo: 'loaded>(
    reference: &git2::Reference<'_>,
    remotes: impl FnOnce() -> &'loaded Remotes<'repo>,
) -> bool {
    let Ok(Some(destination)) = reference.symbolic_target() else {
        return false;
    };
    let Ok(name) = reference.name() else {
        return false;
    };
    let Some(namespace) = name.strip_suffix("/HEAD") else {
        return false;
    };
    let Some(remote) = namespace.strip_prefix("refs/remotes/") else {
        return false;
    };

    destination
        .strip_prefix(namespace)
        .is_some_and(|suffix| suffix.starts_with('/'))
        && remotes().owns_default_slot(remote, name, destination)
}

impl<'repo> Remotes<'repo> {
    pub fn read(repo: &'repo git2::Repository) -> Self {
        Self::try_read(repo).unwrap_or_default()
    }

    pub fn try_read(repo: &'repo git2::Repository) -> Result<Self, git2::Error> {
        let names = repo.remotes()?;
        let remotes = names
            .iter()
            .flatten()
            .flatten()
            .filter_map(|name| repo.find_remote(name).ok())
            .collect();

        Ok(Self {
            configured_names: Some(names),
            remotes,
        })
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

    fn owns_default_slot(&self, owner: &str, alias: &str, destination: &str) -> bool {
        // A conventional alias can survive without its remote's config. A
        // slashful prefix needs a declared remote, even if its refspec is bad.
        let Some(names) = &self.configured_names else {
            return false;
        };
        if owner.contains('/') && !names.iter().flatten().flatten().any(|name| name == owner) {
            return false;
        }

        !self.remotes.iter().any(|remote| {
            remote
                .name()
                .ok()
                .flatten()
                .is_some_and(|name| name != owner)
                && remote.refspecs().any(|spec| {
                    spelled_by(&spec, alias).is_some() || spelled_by(&spec, destination).is_some()
                })
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
