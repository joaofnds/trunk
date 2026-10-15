//! Noninteractive native fetching and Git ref/metadata safety checks.
//! The caller runs this blocking transport in an isolated process with a deadline.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::TrunkError;
use git2::{
    AutotagOption, Config, Cred, CredentialType, Direction, FetchOptions, FetchPrune, ProxyOptions,
    RemoteCallbacks, RemoteUpdateFlags, Repository,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
pub struct FetchRequest {
    pub path: String,
    pub remote: String,
    pub append_fetch_head: bool,
}

/// Configured remotes included by an all-remotes fetch.
///
/// # Errors
/// Returns a repository or configuration read error.
pub fn applicable_remotes(repo: &Repository) -> Result<Vec<String>, TrunkError> {
    let config = repo.config()?;
    let mut names = Vec::new();
    for name in &repo.remotes()? {
        if let Some(name) = name?
            && !config
                .get_bool(&format!("remote.{name}.skipFetchAll"))
                .unwrap_or(false)
        {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

/// Repository state and configuration needed before reserving an automatic fetch.
pub struct FetchPreflight {
    pub common: String,
    pub fetch_head: PathBuf,
    pub remotes: Vec<(String, Vec<String>)>,
    pub clean: bool,
}

/// Read applicable remotes and their effective configuration fingerprints.
///
/// # Errors
/// Returns a repository, configuration or shared-directory read error.
pub fn preflight(path: &Path) -> Result<FetchPreflight, TrunkError> {
    let repo = git2::Repository::open(path)?;
    let common = repo
        .commondir()
        .canonicalize()
        .map_err(|_| TrunkError::new("git_error", "Shared Git directory is unavailable"))?
        .to_string_lossy()
        .into_owned();
    let config = repo.config()?.snapshot()?;
    let mut remotes = Vec::new();
    for name in applicable_remotes(&repo)? {
        let remote = repo.find_remote(&name)?;
        let mut fingerprint = vec![remote.url().unwrap_or_default().to_owned()];
        for spec in &remote.fetch_refspecs()? {
            if let Some(spec) = spec? {
                fingerprint.push(spec.to_owned());
            }
        }
        // Capability failures are reconsidered when any applicable transport setting changes.
        config.entries(None)?.for_each(|entry| {
            if let (Ok(name), Ok(value)) = (entry.name(), entry.value())
                && !name.starts_with("branch.")
            {
                fingerprint.push(format!("{name}={value}"));
            }
        })?;
        remotes.push((name, fingerprint));
    }
    Ok(FetchPreflight {
        common,
        fetch_head: repo.path().join("FETCH_HEAD"),
        remotes,
        clean: repo.state() == git2::RepositoryState::Clean,
    })
}

#[derive(Debug)]
pub struct FetchOutcome {
    pub result: Result<(), TrunkError>,
    /// This attempt wrote `FETCH_HEAD` metadata before restoring any batch prefix.
    /// This includes partial ref-update failure and excludes stale existing bytes.
    pub metadata_written: bool,
}

#[must_use]
pub fn execute_with_receipt(request: &FetchRequest) -> FetchOutcome {
    match Repository::open(&request.path)
        .map_err(fetch_error)
        .and_then(|repo| execute_repository(&repo, request, append_fetch_head))
    {
        Ok(outcome) => outcome,
        Err(error) => FetchOutcome {
            result: Err(error),
            metadata_written: false,
        },
    }
}

fn execute_repository(
    repo: &Repository,
    request: &FetchRequest,
    preserve_metadata: impl FnOnce(&Path, &[u8]) -> Result<(), TrunkError>,
) -> Result<FetchOutcome, TrunkError> {
    let config = validate_configuration(repo, &request.remote)?;
    let configured = repo.find_remote(&request.remote).map_err(fetch_error)?;
    let url = configured.url().map_err(fetch_error)?;
    validate_http_headers(&config, url)?;
    validate_http_proxy(&config, &request.remote, url)?;
    validate_url(repo, url)?;
    let ssh = SshAddress::parse(url)?
        .map(|address| resolve_ssh(&config, &address))
        .transpose()?;
    let transport_url = match &ssh {
        Some(ssh) => Some(ssh.url.clone()),
        None if !url.contains("://") && Path::new(url).is_relative() => {
            let path = repo.workdir().unwrap_or_else(|| repo.path()).join(url);
            Some(
                path.to_str()
                    .ok_or_else(|| unsupported("local remote path is not UTF-8"))?
                    .to_owned(),
            )
        }
        None => None,
    };
    let mut remote = match &transport_url {
        Some(url) => {
            let remote = repo.remote_anonymous(url).map_err(fetch_error)?;
            if remote.url().map_err(fetch_error)? != url {
                return Err(unsupported("a chained URL rewrite requires a manual fetch"));
            }
            remote
        }
        None => repo.find_remote(&request.remote).map_err(fetch_error)?,
    };
    reject_checked_out_destinations(repo, &configured)?;
    let refused_http_auth = Cell::new(false);
    let mut options = FetchOptions::new();
    options
        .download_tags(AutotagOption::All)
        .prune(FetchPrune::On)
        .remote_callbacks(credentials(ssh.as_ref(), &refused_http_auth));
    let mut proxy = ProxyOptions::new();
    proxy.auto();
    options.proxy_options(proxy);
    let download_error = |error| {
        if refused_http_auth.get() {
            unsupported("authenticated HTTP remotes require a manual fetch")
        } else {
            fetch_error(error)
        }
    };
    let (specs, adjusted) = effective_refspecs(&configured)?;
    if transport_url.is_some() || adjusted {
        remote
            .download(&specs, Some(&mut options))
            .map_err(download_error)?;
    } else {
        remote
            .download(&[] as &[&str], Some(&mut options))
            .map_err(download_error)?;
    }
    // Download only writes objects. A checkout or ref change while it was in
    // progress must be considered before update_tips or prune touches any ref.
    reject_checked_out_destinations(repo, &configured)?;
    let mut updates = ref_updates(repo, &remote, &configured, false)?;
    let mut filtered = if updates.refusal.is_some() {
        let url = remote.url().map_err(fetch_error)?;
        let mut selective = repo.remote_anonymous(url).map_err(fetch_error)?;
        if selective.url().map_err(fetch_error)? != url {
            return Err(unsupported("a chained URL rewrite requires a manual fetch"));
        }
        let mut proxy = ProxyOptions::new();
        if let Ok(url) = config.get_string(&format!("remote.{}.proxy", request.remote)) {
            if !url.is_empty() {
                proxy.url(&url);
            }
        } else {
            proxy.auto();
        }
        options.proxy_options(proxy);
        // The second advertisement may contain new refs or objects. Download
        // the entire original scope before recomputing safe destinations.
        selective
            .download(&specs, Some(&mut options))
            .map_err(download_error)?;
        reject_checked_out_destinations(repo, &configured)?;
        updates = ref_updates(repo, &selective, &configured, true)?;
        options.download_tags(AutotagOption::None);
        // This resets only the anonymous remote's active refspecs. Objects are
        // already local; pinned mark_local skips negotiation and pack download.
        selective
            .download(
                &updates.specs.iter().collect::<Vec<_>>(),
                Some(&mut options),
            )
            .map_err(download_error)?;
        reject_checked_out_destinations(repo, &configured)?;
        Some(selective)
    } else {
        None
    };
    let prefix = fetch_head_prefix(repo.path(), request.append_fetch_head)?;
    // update_tips normally truncates this file. Removing old bytes first makes
    // the metadata receipt unambiguous even if it fails before that truncation.
    match std::fs::remove_file(repo.path().join("FETCH_HEAD")) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(metadata_error()),
    }
    let tags = if filtered.is_some() {
        AutotagOption::None
    } else {
        AutotagOption::All
    };
    let tips = filtered.as_mut().unwrap_or(&mut remote);
    let mut result = tips
        .update_tips(None, RemoteUpdateFlags::UPDATE_FETCHHEAD, tags, None)
        .map_err(fetch_error);
    let metadata_written =
        std::fs::metadata(repo.path().join("FETCH_HEAD")).is_ok_and(|metadata| metadata.len() != 0);
    if filtered.is_some() && metadata_written {
        let normalized = normalize_fetch_head_merge(repo, &config, &configured, &request.remote);
        result = result.and(normalized);
    }
    let prune = if filtered.is_some()
        || configured.refspecs().any(|spec| {
            spec.direction() == Direction::Fetch
                && spec
                    .src()
                    .is_ok_and(|source| git2::Oid::from_str(source).is_ok())
        }) {
        prune_guarded(
            repo,
            filtered.as_ref().unwrap_or(&remote),
            &configured,
            &updates.protected,
        )
    } else {
        remote.prune(None).map_err(fetch_error)
    };
    let head = record_remote_head(
        repo,
        filtered.as_ref().unwrap_or(&remote),
        &configured,
        &request.remote,
    );
    result = result.and(prune).and(head);
    // Native update_tips truncates FETCH_HEAD even on the path where writing is
    // disabled. Keep ordinary writing and preserve earlier remotes on failure.
    let result = preserve_metadata(repo.path(), &prefix)
        .and_then(|()| result.and_then(|()| updates.refusal.map_or(Ok(()), Err)));
    Ok(FetchOutcome {
        result,
        metadata_written,
    })
}

fn effective_refspecs(configured: &git2::Remote<'_>) -> Result<(Vec<String>, bool), TrunkError> {
    let mut adjusted = false;
    let mut specs = Vec::new();
    for spec in &configured.fetch_refspecs().map_err(fetch_error)? {
        let spec = spec
            .map_err(fetch_error)?
            .ok_or_else(|| unsupported("fetch refspec is not UTF-8"))?;
        let outside_heads_and_tags = spec.split_once(':').is_some_and(|(_, destination)| {
            !destination.is_empty()
                && !destination.starts_with("refs/heads/")
                && !destination.starts_with("refs/tags/")
        });
        if !spec.starts_with('+') && outside_heads_and_tags {
            // Git allows non-fast-forward updates outside heads and tags.
            // libgit2 otherwise silently skips them; preserve Git's rule.
            adjusted = true;
            specs.push(format!("+{spec}"));
        } else {
            specs.push(spec.into());
        }
    }
    Ok((specs, adjusted))
}

fn validate_configuration(repo: &Repository, remote: &str) -> Result<Config, TrunkError> {
    if repo.state() != git2::RepositoryState::Clean {
        return Err(TrunkError::new(
            "fetch_mid_operation",
            "the repository has an unfinished Git operation",
        ));
    }
    let config = repo.config().map_err(fetch_error)?;
    let mut entries = config.entries(None).map_err(fetch_error)?;
    let fetch_key = format!("remote.{remote}.fetch");
    let mut has_submodules = repo
        .workdir()
        .is_some_and(|workdir| workdir.join(".gitmodules").exists());
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(fetch_error)?;
        let name = entry.name().map_err(fetch_error)?;
        let value = entry.value().map_err(fetch_error)?;
        has_submodules |= name.starts_with("submodule.");
        if name == fetch_key && value.starts_with('^') {
            return Err(unsupported(
                "negative fetch refspecs are not supported by the background transport",
            ));
        }
        if name == fetch_key {
            let value = value.strip_prefix('+').unwrap_or(value);
            let (source, destination) = value.split_once(':').unwrap_or((value, ""));
            if !destination.is_empty() && !destination.starts_with("refs/") {
                return Err(unsupported(
                    "fetch destinations outside refs/ require a manual fetch",
                ));
            }
            if !source.starts_with("refs/")
                && source != "HEAD"
                && git2::Oid::from_str(source).is_err()
            {
                return Err(unsupported(
                    "abbreviated fetch sources require a manual fetch",
                ));
            }
        }
        if name == "extensions.partialclone"
            || (name == format!("remote.{remote}.promisor") && value == "true")
        {
            return Err(unsupported(
                "partial-clone object filters require a manual fetch",
            ));
        }
        if name == format!("remote.{remote}.uploadpack") && value != "git-upload-pack" {
            return Err(unsupported(
                "a custom upload-pack command requires a manual fetch",
            ));
        }
    }
    drop(entries);
    let recursive = config
        .get_bool(&format!("remote.{remote}.fetchRecurseSubmodules"))
        .ok()
        .or_else(|| config.get_bool("fetch.recurseSubmodules").ok());
    // Enumerating libgit2 submodules opens the index and HEAD tree, even when
    // there are no submodules. Background checks need only know whether the
    // nonrecursive transport would omit configured submodule work.
    if has_submodules && recursive != Some(false) {
        return Err(unsupported(
            "recursive submodule fetching requires a manual fetch; set fetch.recurseSubmodules=false for background checks",
        ));
    }
    Ok(config)
}

fn validate_http_headers(config: &Config, url: &str) -> Result<(), TrunkError> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Ok(());
    }

    let mut has_global_header = false;
    let mut entries = config.entries(Some("http.*")).map_err(fetch_error)?;
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(fetch_error)?;
        let name = entry.name().map_err(fetch_error)?;
        let value = entry.value().map_err(fetch_error)?;
        if name == "http.extraheader" {
            has_global_header = !value.is_empty();
        } else if name.ends_with(".extraheader") {
            let scope = name
                .strip_prefix("http.")
                .and_then(|name| name.strip_suffix(".extraheader"))
                .unwrap_or_default();
            if http_scope_applies(scope, url) {
                return Err(unsupported(
                    "URL-scoped HTTP headers require a manual fetch",
                ));
            }
        }
        if matches!(
            name,
            "http.sslcainfo" | "http.sslcapath" | "http.sslcert" | "http.sslkey"
        ) || (name == "http.sslverify" && !matches!(value, "true" | "yes" | "on" | "1"))
        {
            return Err(unsupported(
                "custom HTTP TLS configuration requires a manual fetch",
            ));
        }
        for option in ["sslverify", "sslcainfo", "sslcapath", "sslcert", "sslkey"] {
            if let Some(scope) = name
                .strip_prefix("http.")
                .and_then(|name| name.strip_suffix(&format!(".{option}")))
                && http_scope_applies(scope, url)
            {
                return Err(unsupported(
                    "URL-scoped HTTP TLS configuration requires a manual fetch",
                ));
            }
        }
    }
    if has_global_header {
        return Err(unsupported(
            "global HTTP extra headers require a manual fetch",
        ));
    }
    Ok(())
}

fn http_scope_applies(scope: &str, url: &str) -> bool {
    let authority = |url: &str| {
        let (scheme, rest) = url.split_once("://")?;
        let host = rest.split('/').next()?.rsplit('@').next()?;
        let host = match scheme {
            "https" => host.strip_suffix(":443").unwrap_or(host),
            "http" => host.strip_suffix(":80").unwrap_or(host),
            _ => host,
        };
        Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
    };
    // Conservatively include other paths on the same authority. Git's matching
    // also permits omitted usernames and default ports; a prefix check misses
    // those policies and would silently send a fetch without its required header.
    scope.contains('*') || authority(scope).is_some_and(|scope| Some(scope) == authority(url))
}

fn validate_http_proxy(config: &Config, remote: &str, url: &str) -> Result<(), TrunkError> {
    if !url.starts_with("http://") {
        return Ok(());
    }
    let configured = if let Ok(proxy) = config.get_string(&format!("remote.{remote}.proxy")) {
        !proxy.is_empty()
    } else {
        let mut found = false;
        let mut entries = config.entries(Some("http.*")).map_err(fetch_error)?;
        while let Some(entry) = entries.next() {
            let entry = entry.map_err(fetch_error)?;
            let name = entry.name().map_err(fetch_error)?;
            let value = entry.value().map_err(fetch_error)?;
            found |= !value.is_empty()
                && (name == "http.proxy"
                    || name
                        .strip_prefix("http.")
                        .and_then(|name| name.strip_suffix(".proxy"))
                        .is_some_and(|scope| http_scope_applies(scope, url)));
        }
        found || environment_http_proxy_applies(url)
    };
    if configured {
        return Err(unsupported(
            "the native transport cannot preserve a proxy for a plain HTTP remote; use HTTPS or fetch manually",
        ));
    }
    Ok(())
}

fn environment_http_proxy_applies(url: &str) -> bool {
    let proxy = std::env::var_os("http_proxy").or_else(|| std::env::var_os("HTTP_PROXY"));
    if proxy.is_none_or(|proxy| proxy.is_empty()) {
        return false;
    }
    let bypass = std::env::var("no_proxy")
        .or_else(|_| std::env::var("NO_PROXY"))
        .unwrap_or_default();
    let authority = url
        .strip_prefix("http://")
        .unwrap_or_default()
        .split('/')
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    let (host, port) = authority.rsplit_once(':').unwrap_or((authority, "80"));
    !bypass.split(',').any(|pattern| {
        if pattern == "*" {
            return true;
        }
        let (domain, pattern_port) = pattern
            .split_once(':')
            .map_or((pattern, None), |(domain, port)| (domain, Some(port)));
        if pattern_port.is_some_and(|pattern_port| pattern_port != port) {
            return false;
        }
        domain
            .strip_prefix("*.")
            .or_else(|| domain.strip_prefix('.'))
            .map_or_else(
                || !domain.is_empty() && host == domain,
                |domain| {
                    host == domain
                        || host
                            .strip_suffix(domain)
                            .is_some_and(|prefix| prefix.ends_with('.'))
                },
            )
    })
}

fn credentials<'a>(
    ssh: Option<&'a SshSettings>,
    refused_http_auth: &'a Cell<bool>,
) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    let mut agent_attempted = false;
    let mut identity_index = 0;
    callbacks.credentials(move |url, username, allowed| {
        if url.starts_with("http://") || url.starts_with("https://") {
            refused_http_auth.set(true);
            return Err(credential_input_error());
        }
        validate_credential_input(url, username)?;
        let username = ssh.map_or_else(|| username.unwrap_or("git"), |ssh| ssh.username.as_str());
        if allowed.contains(CredentialType::USERNAME) {
            return Cred::username(username);
        }
        if allowed.contains(CredentialType::SSH_KEY) {
            if !agent_attempted && ssh.is_none_or(|ssh| ssh.use_agent) {
                agent_attempted = true;
                if let Ok(credential) = Cred::ssh_key_from_agent(username) {
                    return Ok(credential);
                }
            }
            if let Some(ssh) = ssh {
                while let Some(identity) = ssh.identities.get(identity_index) {
                    identity_index += 1;
                    if !identity.is_file() {
                        continue;
                    }
                    let mut public = identity.as_os_str().to_os_string();
                    public.push(".pub");
                    let public = PathBuf::from(public);
                    if let Ok(credential) = Cred::ssh_key(
                        username,
                        public.is_file().then_some(public.as_path()),
                        identity,
                        None,
                    ) {
                        return Ok(credential);
                    }
                }
            }
        }
        if allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::new(
            git2::ErrorCode::Auth,
            git2::ErrorClass::Ssh,
            "no noninteractive credentials available",
        ))
    });
    callbacks
}

fn credential_input_error() -> git2::Error {
    git2::Error::new(
        git2::ErrorCode::Auth,
        git2::ErrorClass::Http,
        "noninteractive credential data was unavailable or unsafe",
    )
}

fn validate_credential_input(url: &str, username: Option<&str>) -> Result<(), git2::Error> {
    let control = |byte: u8| matches!(byte, 0 | b'\r' | b'\n');
    // The native URL parser decodes user and host fields before invoking us.
    if url.bytes().any(control)
        || username.is_some_and(|username| username.bytes().any(control))
        || url.as_bytes().windows(3).any(|bytes| {
            bytes[0] == b'%'
                && bytes[1] == b'0'
                && matches!(bytes[2], b'0' | b'a' | b'A' | b'd' | b'D')
        })
    {
        return Err(credential_input_error());
    }
    Ok(())
}

fn validate_url(repo: &Repository, url: &str) -> Result<(), TrunkError> {
    if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "http" | "https" | "ssh" | "git" | "file") {
            return Err(unsupported(
                "this remote URL requires a transport helper that background fetch does not support",
            ));
        }
        if matches!(scheme, "http" | "https")
            && rest
                .split(['/', '?', '#'])
                .next()
                .is_some_and(|authority| authority.contains('@'))
        {
            return Err(unsupported(
                "HTTP remote URLs with embedded credentials require a manual fetch",
            ));
        }
    } else if url.split_once(':').is_some_and(|(prefix, suffix)| {
        suffix.starts_with(':') && !prefix.contains('@') && !prefix.contains('[')
    }) {
        return Err(unsupported(
            "remote transport helpers require a manual fetch",
        ));
    }
    if repo.is_shallow() {
        return Err(unsupported(
            "automatic fetching of shallow repositories is unavailable; fetch manually",
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct SshAddress {
    username: Option<String>,
    hostname: String,
    port: Option<String>,
    path: String,
    scp: bool,
}

impl SshAddress {
    fn parse(url: &str) -> Result<Option<Self>, TrunkError> {
        let (authority, path, scp) = if let Some(address) = url.strip_prefix("ssh://") {
            let (authority, path) = address
                .split_once('/')
                .ok_or_else(|| unsupported("SSH URL has no repository path"))?;
            (authority, format!("/{path}"), false)
        } else if url.contains("://")
            || url.starts_with('/')
            || url.starts_with("./")
            || url.starts_with("../")
        {
            return Ok(None);
        } else {
            let mut brackets = 0;
            let separator = url.char_indices().find_map(|(index, character)| {
                match character {
                    '[' => brackets += 1,
                    ']' => brackets -= 1,
                    ':' if brackets == 0 => return Some(index),
                    '/' if brackets == 0 => return Some(usize::MAX),
                    _ => {}
                }
                None
            });
            let Some(separator) = separator.filter(|index| *index != usize::MAX) else {
                return Ok(None);
            };
            if cfg!(windows) && separator == 1 {
                return Ok(None);
            }
            (&url[..separator], url[separator + 1..].into(), true)
        };
        let (username, host) = match authority.rsplit_once('@') {
            Some((username, host)) => (Some(username.to_owned()), host),
            None => (None, authority),
        };
        if username
            .as_ref()
            .is_some_and(|username| username.contains(':') || username.contains('%'))
        {
            return Err(unsupported(
                "SSH URLs with embedded passwords or escaped usernames require a manual fetch",
            ));
        }
        let (hostname, port) = if let Some(host) = host.strip_prefix('[') {
            let (hostname, suffix) = host
                .split_once(']')
                .ok_or_else(|| unsupported("invalid SSH host syntax"))?;
            (
                hostname.to_owned(),
                suffix.strip_prefix(':').map(str::to_owned),
            )
        } else if let Some((hostname, port)) = host.rsplit_once(':') {
            (hostname.to_owned(), Some(port.to_owned()))
        } else {
            (host.to_owned(), None)
        };
        if hostname.is_empty()
            || hostname.starts_with('-')
            || hostname.chars().any(char::is_whitespace)
        {
            return Err(unsupported("invalid SSH hostname"));
        }
        Ok(Some(Self {
            username,
            hostname,
            port,
            path,
            scp,
        }))
    }
}

#[derive(Debug)]
struct SshSettings {
    url: String,
    username: String,
    identities: Vec<PathBuf>,
    use_agent: bool,
}

fn resolve_ssh(config: &Config, address: &SshAddress) -> Result<SshSettings, TrunkError> {
    if config.get_string("core.sshCommand").is_ok()
        || config.get_string("ssh.variant").is_ok()
        || ["GIT_SSH", "GIT_SSH_COMMAND"]
            .iter()
            .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
    {
        return Err(unsupported("custom SSH commands require a manual fetch"));
    }
    let effective = ssh_configuration(address, false)?;
    let defaults = ssh_configuration(address, true)?;
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    ssh_settings(address, &effective, &defaults, home.as_deref())
}

fn ssh_settings(
    address: &SshAddress,
    effective: &BTreeMap<String, Vec<String>>,
    defaults: &BTreeMap<String, Vec<String>>,
    home: Option<&Path>,
) -> Result<SshSettings, TrunkError> {
    let get = |key: &str| {
        effective
            .get(key)
            .and_then(|values| values.first())
            .map(String::as_str)
    };
    if [
        "proxycommand",
        "proxyjump",
        "hostkeyalias",
        "revokedhostkeys",
    ]
    .iter()
    .any(|key| get(key).is_some_and(|value| value != "none"))
    {
        return Err(unsupported(
            "SSH ProxyJump, ProxyCommand, host-key aliases, or revocation files require a manual fetch",
        ));
    }
    for key in [
        "ciphers",
        "macs",
        "kexalgorithms",
        "hostkeyalgorithms",
        "pubkeyacceptedalgorithms",
        "casignaturealgorithms",
        "userknownhostsfile",
        "globalknownhostsfile",
        "verifyhostkeydns",
        "requiredrsasize",
        "canonicalizehostname",
    ] {
        let compatible = if matches!(
            key,
            "ciphers"
                | "macs"
                | "kexalgorithms"
                | "hostkeyalgorithms"
                | "pubkeyacceptedalgorithms"
                | "casignaturealgorithms"
        ) {
            // System OpenSSH configuration can reorder the default preferences
            // without changing which algorithms it permits. Native libgit2
            // chooses its own supported preference order within that policy.
            effective.get(key).map(|values| algorithm_set(values))
                == defaults.get(key).map(|values| algorithm_set(values))
        } else {
            effective.get(key) == defaults.get(key)
        };
        if !compatible {
            return Err(unsupported(
                "custom SSH trust, algorithm, or hostname-canonicalization policy requires a manual fetch",
            ));
        }
    }
    for key in ["globalknownhostsfile", "userknownhostsfile"] {
        if let Some(files) = get(key) {
            for file in files.split_whitespace() {
                let path = expand_home(file, home)?;
                let primary = home.map(|home| home.join(".ssh/known_hosts"));
                if Some(&path) != primary.as_ref() && path.is_file() {
                    return Err(unsupported(
                        "additional SSH known-host files require a manual fetch",
                    ));
                }
            }
        }
    }
    let identities = effective
        .get("identityfile")
        .into_iter()
        .flatten()
        .filter(|path| path.as_str() != "none")
        .map(|path| expand_home(path, home))
        .collect::<Result<Vec<_>, _>>()?;
    let identity_agent = get("identityagent");
    if identity_agent
        .is_some_and(|agent| !matches!(agent, "none" | "SSH_AUTH_SOCK" | "$SSH_AUTH_SOCK"))
    {
        return Err(unsupported(
            "a custom SSH IdentityAgent requires a manual fetch",
        ));
    }
    let username = get("user")
        .ok_or_else(|| unsupported("SSH configuration did not provide a username"))?
        .to_owned();
    let hostname = get("hostname")
        .ok_or_else(|| unsupported("SSH configuration did not provide a hostname"))?;
    let port = get("port").unwrap_or("22");
    if port.parse::<u16>().ok().is_none_or(|port| port == 0)
        || hostname.starts_with('-')
        || hostname.chars().any(char::is_whitespace)
    {
        return Err(unsupported("invalid effective SSH address"));
    }
    let host = if hostname.contains(':') {
        format!("[{hostname}]")
    } else {
        hostname.into()
    };
    let url = if address.scp {
        // libgit2 supports [host:port]:path, retaining scp's relative-path
        // semantics instead of turning it into an absolute ssh:// path.
        format!("[{username}@{host}:{port}]:{}", address.path)
    } else {
        format!("ssh://{username}@{host}:{port}{}", address.path)
    };
    Ok(SshSettings {
        url,
        username,
        identities,
        use_agent: get("identitiesonly") != Some("yes") && identity_agent != Some("none"),
    })
}

fn algorithm_set(values: &[String]) -> BTreeSet<&str> {
    values.iter().flat_map(|value| value.split(',')).collect()
}

fn ssh_configuration(
    address: &SshAddress,
    defaults: bool,
) -> Result<BTreeMap<String, Vec<String>>, TrunkError> {
    let mut command = Command::new("ssh");
    command
        .args(["-G", "-oBatchMode=yes"])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    if defaults {
        command.args(["-F", "none"]);
    }
    if let Some(username) = &address.username {
        command.arg("-l").arg(username);
    }
    if let Some(port) = &address.port {
        command.arg("-p").arg(port);
    }
    command.arg("--").arg(&address.hostname);
    let output = command.output().map_err(|_| {
        unsupported("OpenSSH is required to resolve this remote's SSH configuration")
    })?;
    if !output.status.success() {
        return Err(unsupported(
            "OpenSSH could not resolve this remote's SSH configuration",
        ));
    }
    let output = String::from_utf8(output.stdout)
        .map_err(|_| unsupported("SSH configuration is not UTF-8"))?;
    let mut entries = BTreeMap::<String, Vec<String>>::new();
    for line in output.lines() {
        if let Some((name, value)) = line.split_once(' ') {
            entries
                .entry(name.to_ascii_lowercase())
                .or_default()
                .push(value.to_owned());
        }
    }
    Ok(entries)
}

fn expand_home(path: &str, home: Option<&Path>) -> Result<PathBuf, TrunkError> {
    if let Some(path) = path.strip_prefix("~/") {
        return home
            .map(|home| home.join(path))
            .ok_or_else(|| unsupported("home directory is unavailable for SSH configuration"));
    }
    if path.contains('%') || path.starts_with('~') || path.starts_with('$') {
        return Err(unsupported(
            "unresolved SSH IdentityFile expansion requires a manual fetch",
        ));
    }
    Ok(path.into())
}

fn fetch_head_prefix(gitdir: &Path, append: bool) -> Result<Vec<u8>, TrunkError> {
    if !append {
        return Ok(Vec::new());
    }
    match std::fs::read(gitdir.join("FETCH_HEAD")) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(metadata_error()),
    }
}

fn append_fetch_head(gitdir: &Path, prefix: &[u8]) -> Result<(), TrunkError> {
    if prefix.is_empty() {
        return Ok(());
    }
    let fetched = fetch_head_prefix(gitdir, true)?;
    write_fetch_head(gitdir, &[prefix, &fetched].concat())
}

fn write_fetch_head(gitdir: &Path, contents: &[u8]) -> Result<(), TrunkError> {
    let head = gitdir.join("FETCH_HEAD");
    let lock = gitdir.join("FETCH_HEAD.lock");
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|_| metadata_error())?;
    let mut file = tempfile::NamedTempFile::from_parts(
        file,
        tempfile::TempPath::try_from_path(lock).map_err(|_| metadata_error())?,
    );
    file.write_all(contents).map_err(|_| metadata_error())?;
    file.persist(head).map_err(|_| metadata_error())?;
    Ok(())
}

fn metadata_error() -> TrunkError {
    TrunkError::new("fetch_metadata", "could not preserve fetch metadata")
}

struct RefUpdates {
    protected: BTreeSet<String>,
    specs: BTreeSet<String>,
    refusal: Option<TrunkError>,
}

impl RefUpdates {
    fn add(
        &mut self,
        repo: &Repository,
        source: &str,
        destination: &str,
        oid: git2::Oid,
        forced: bool,
        collect_specs: bool,
    ) {
        let spec = match check_ref_update(repo, destination, oid, forced) {
            Ok(()) => {
                if !collect_specs {
                    return;
                }
                let force = forced
                    || (!destination.starts_with("refs/heads/")
                        && !destination.starts_with("refs/tags/"));
                format!("{}{source}:{destination}", if force { "+" } else { "" })
            }
            Err(error) => {
                self.protected.insert(destination.into());
                self.refusal.get_or_insert(error);
                if !collect_specs {
                    return;
                }
                // Source-only specs retain native FETCH_HEAD metadata while
                // giving the anonymous remote no forbidden ref to update.
                source.to_owned()
            }
        };
        self.specs.insert(spec);
    }
}

fn refspec_has_destination(spec: &git2::Refspec<'_>) -> bool {
    // git2 0.21 unwraps a null native destination in dst()/dst_bytes() for
    // source-only specs. The original string distinguishes them safely.
    spec.bytes()
        .splitn(2, |byte| *byte == b':')
        .nth(1)
        .is_some_and(|destination| !destination.is_empty())
}

fn ref_updates(
    repo: &Repository,
    remote: &git2::Remote<'_>,
    configured: &git2::Remote<'_>,
    collect_specs: bool,
) -> Result<RefUpdates, TrunkError> {
    let mut updates = RefUpdates {
        protected: BTreeSet::new(),
        specs: BTreeSet::new(),
        refusal: None,
    };
    for spec in configured
        .refspecs()
        .filter(|spec| spec.direction() == Direction::Fetch)
    {
        let source = spec.src().map_err(fetch_error)?;
        if let Ok(oid) = git2::Oid::from_str(source) {
            if refspec_has_destination(&spec) {
                updates.add(
                    repo,
                    source,
                    spec.dst().map_err(fetch_error)?,
                    oid,
                    spec.is_force(),
                    collect_specs,
                );
            } else if collect_specs {
                updates.specs.insert(source.into());
            }
        }
    }
    for head in remote.list().map_err(fetch_error)? {
        let name = head.name();
        if name.ends_with("^{}") || !git2::Reference::is_valid_name(name) {
            continue;
        }
        if name.starts_with("refs/tags/") {
            let forced = configured.refspecs().any(|spec| {
                spec.direction() == Direction::Fetch
                    && spec.is_force()
                    && spec.src_matches(name)
                    && spec.transform(name).is_ok_and(|destination| {
                        destination
                            .as_str()
                            .is_ok_and(|destination| destination == name)
                    })
            });
            updates.add(repo, name, name, head.oid(), forced, collect_specs);
        }
        for spec in configured
            .refspecs()
            .filter(|spec| spec.direction() == Direction::Fetch && spec.src_matches(name))
        {
            if refspec_has_destination(&spec) {
                let destination = spec.transform(name).map_err(fetch_error)?;
                updates.add(
                    repo,
                    name,
                    destination.as_str().map_err(fetch_error)?,
                    head.oid(),
                    spec.is_force(),
                    collect_specs,
                );
            } else if collect_specs {
                updates.specs.insert(name.into());
            }
        }
    }
    Ok(updates)
}

fn prune_guarded(
    repo: &Repository,
    remote: &git2::Remote<'_>,
    configured: &git2::Remote<'_>,
    protected: &BTreeSet<String>,
) -> Result<(), TrunkError> {
    // Native prune matches each destination to a named advertisement. Raw OID
    // sources therefore look absent even after download. Match the same
    // configured scopes, retaining raw-OID and explicitly refused destinations.
    let advertised = remote
        .list()
        .map_err(fetch_error)?
        .iter()
        .map(git2::RemoteHead::name)
        .collect::<BTreeSet<_>>();
    for reference in repo.references().map_err(fetch_error)? {
        let mut reference = reference.map_err(fetch_error)?;
        if reference.symbolic_target().map_err(fetch_error)?.is_some() {
            continue;
        }
        let name = reference.name().map_err(fetch_error)?;
        if protected.contains(name) {
            continue;
        }
        let mut candidate = false;
        let mut retained = false;
        for spec in configured.refspecs().filter(|spec| {
            spec.direction() == Direction::Fetch
                && refspec_has_destination(spec)
                && spec.dst_matches(name)
        }) {
            candidate = true;
            let source = spec.rtransform(name).map_err(fetch_error)?;
            let source = source.as_str().map_err(fetch_error)?;
            if git2::Oid::from_str(source).is_ok() || advertised.contains(source) {
                retained = true;
                break;
            }
        }
        if candidate && !retained {
            reference.delete().map_err(fetch_error)?;
        }
    }
    Ok(())
}

fn normalize_fetch_head_merge(
    repo: &Repository,
    config: &Config,
    configured: &git2::Remote<'_>,
    remote: &str,
) -> Result<(), TrunkError> {
    // Literal specs used to exclude refused destinations are all marked as
    // merge candidates by libgit2. Preserve its writer and descriptions, and
    // restore only that column to the original configured fetch scope.
    let upstream = repo.find_reference("HEAD").ok().and_then(|head| {
        let name = head.symbolic_target().ok()??.strip_prefix("refs/heads/")?;
        (config
            .get_string(&format!("branch.{name}.remote"))
            .ok()?
            .as_str()
            == remote)
            .then(|| config.get_string(&format!("branch.{name}.merge")).ok())
            .flatten()
    });
    let original =
        std::fs::read_to_string(repo.path().join("FETCH_HEAD")).map_err(|_| metadata_error())?;
    let mut adjusted = Vec::new();
    for line in original.lines() {
        let mut fields = line.splitn(3, '\t');
        let oid = fields.next().ok_or_else(metadata_error)?;
        fields.next().ok_or_else(metadata_error)?;
        let description = fields.next().ok_or_else(metadata_error)?;
        let name = if let Some(description) = description.strip_prefix("branch '") {
            format!(
                "refs/heads/{}",
                description
                    .split_once("' of ")
                    .ok_or_else(metadata_error)?
                    .0
            )
        } else if let Some(description) = description.strip_prefix("tag '") {
            format!(
                "refs/tags/{}",
                description
                    .split_once("' of ")
                    .ok_or_else(metadata_error)?
                    .0
            )
        } else if let Some(description) = description.strip_prefix('\'') {
            description
                .split_once("' of ")
                .ok_or_else(metadata_error)?
                .0
                .to_owned()
        } else {
            "HEAD".into()
        };
        let merge = configured.refspecs().any(|spec| {
            spec.direction() == Direction::Fetch
                && spec.src_matches(&name)
                && (!spec.src_bytes().contains(&b'*') || upstream.as_deref() == Some(name.as_str()))
        });
        writeln!(
            adjusted,
            "{oid}\t{}\t{description}",
            if merge { "" } else { "not-for-merge" }
        )
        .map_err(|_| metadata_error())?;
    }
    write_fetch_head(repo.path(), &adjusted)
}

fn check_ref_update(
    repo: &Repository,
    destination: &str,
    next: git2::Oid,
    forced: bool,
) -> Result<(), TrunkError> {
    if destination.starts_with("refs/heads/") && repo.find_commit(next).is_err() {
        return Err(TrunkError::new(
            "fetch_invalid_destination",
            "a local branch fetch destination must point to a commit",
        ));
    }
    let current = match repo.refname_to_id(destination) {
        Ok(current) => current,
        Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(()),
        Err(error) => return Err(fetch_error(error)),
    };
    if current == next || forced {
        return Ok(());
    }
    if destination.starts_with("refs/tags/") {
        return Err(TrunkError::new(
            "fetch_tag_conflict",
            "a remote tag changed; its configured refspec does not allow replacing the local tag",
        ));
    }
    if destination.starts_with("refs/heads/")
        && !repo
            .graph_descendant_of(next, current)
            .map_err(fetch_error)?
    {
        return Err(TrunkError::new(
            "git_not_fast_forward",
            "the configured refspec does not allow rewinding its local branch destination",
        ));
    }
    Ok(())
}

fn reject_checked_out_destinations(
    repo: &Repository,
    remote: &git2::Remote<'_>,
) -> Result<(), TrunkError> {
    if repo.state() != git2::RepositoryState::Clean {
        return Err(TrunkError::new(
            "fetch_mid_operation",
            "the repository has an unfinished Git operation",
        ));
    }
    let mut branches = BTreeSet::new();
    collect_checked_out_branch(repo, &mut branches)?;
    let common = Repository::open(repo.commondir()).map_err(fetch_error)?;
    collect_checked_out_branch(&common, &mut branches)?;
    for name in &repo.worktrees().map_err(fetch_error)? {
        let name = name
            .map_err(fetch_error)?
            .ok_or_else(|| unsupported("worktree name is not UTF-8"))?;
        let worktree = repo.find_worktree(name).map_err(fetch_error)?;
        let worktree_repo = Repository::open_from_worktree(&worktree).map_err(fetch_error)?;
        collect_checked_out_branch(&worktree_repo, &mut branches)?;
    }
    if remote
        .refspecs()
        .filter(|spec| spec.direction() == Direction::Fetch)
        .any(|spec| branches.iter().any(|branch| spec.dst_matches(branch)))
    {
        return Err(TrunkError::new(
            "fetch_destination_checked_out",
            "a fetch destination is checked out in this repository or a linked worktree",
        ));
    }
    Ok(())
}

fn collect_checked_out_branch(
    repo: &Repository,
    branches: &mut BTreeSet<String>,
) -> Result<(), TrunkError> {
    if repo.is_bare() {
        return Ok(());
    }
    let head = repo.find_reference("HEAD").map_err(fetch_error)?;
    if let Some(target) = head.symbolic_target().map_err(fetch_error)? {
        branches.insert(target.into());
    }
    Ok(())
}

fn record_remote_head(
    repo: &Repository,
    remote: &git2::Remote<'_>,
    configured: &git2::Remote<'_>,
    name: &str,
) -> Result<(), TrunkError> {
    let head_name = format!("refs/remotes/{name}/HEAD");
    match repo.find_reference(&head_name) {
        Ok(_) => return Ok(()),
        Err(error) if error.code() == git2::ErrorCode::NotFound => {}
        Err(error) => return Err(fetch_error(error)),
    }
    let Ok(default_branch) = remote.default_branch() else {
        return Ok(());
    };
    let Ok(default_branch) = default_branch.as_str() else {
        return Err(unsupported("remote HEAD is not UTF-8"));
    };
    for spec in configured
        .refspecs()
        .filter(|spec| spec.direction() == Direction::Fetch)
    {
        if !spec.src_matches(default_branch) {
            continue;
        }
        let destination = spec.transform(default_branch).map_err(fetch_error)?;
        let Ok(destination) = destination.as_str() else {
            return Err(unsupported("fetch destination is not UTF-8"));
        };
        if destination.starts_with(&format!("refs/remotes/{name}/"))
            && repo.find_reference(destination).is_ok()
        {
            repo.reference_symbolic(&head_name, destination, false, "fetch: remote HEAD")
                .map_err(fetch_error)?;
            break;
        }
    }
    Ok(())
}

fn unsupported(message: &str) -> TrunkError {
    TrunkError::new("unsupported_transport", message)
}

// libgit2 and helper failures can contain credential-bearing URLs. The wire
// contract keeps the stable classification and a safe explanation instead.
fn fetch_error(error: git2::Error) -> TrunkError {
    let mut error = TrunkError::from(error);
    error.message = match error.code.as_str() {
        "git_auth" => "the remote did not accept the available noninteractive credentials",
        "git_certificate" => "the remote certificate or SSH host key is not trusted",
        "git_timeout" => "the remote connection timed out",
        "git_not_found" => "the remote or requested reference could not be found",
        "git_locked" => "another process has locked repository data",
        _ => "the remote fetch could not be completed",
    }
    .into();
    error
}

#[cfg(test)]
mod tests {
    use git2::{Oid, Repository, Signature, WorktreeAddOptions};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::thread::JoinHandle;
    use tempfile::TempDir;

    use super::FetchRequest;

    fn isolate_repository(repo: &Repository) {
        // Repository-owned config avoids global/system Git policy without
        // changing the process environment shared with other test threads.
        repo.set_config(&git2::Config::open(&repo.commondir().join("config")).unwrap())
            .unwrap();
    }

    fn execute_with_receipt(request: &FetchRequest) -> super::FetchOutcome {
        let repo = Repository::open(&request.path).unwrap();
        isolate_repository(&repo);
        match super::execute_repository(&repo, request, super::append_fetch_head) {
            Ok(outcome) => outcome,
            Err(error) => super::FetchOutcome {
                result: Err(error),
                metadata_written: false,
            },
        }
    }

    fn execute(request: &FetchRequest) -> Result<(), crate::error::TrunkError> {
        execute_with_receipt(request).result
    }

    struct RequestAuthorization {
        host: String,
        value: Option<String>,
    }

    struct HttpRemote {
        address: SocketAddr,
        stopping: Arc<AtomicBool>,
        require_auth: Arc<AtomicBool>,
        authenticated_redirect: Arc<Mutex<Option<String>>>,
        authorized: Arc<Mutex<Vec<String>>>,
        observed_auth: Arc<Mutex<Vec<RequestAuthorization>>>,
        requests: Arc<Mutex<Vec<String>>>,
        server: Option<JoinHandle<()>>,
    }

    impl HttpRemote {
        fn new(repo: &Repository, commit: Oid) -> Self {
            Self::with_redirect(repo, commit, None)
        }

        fn public(repo: &Repository, commit: Oid) -> Self {
            let remote = Self::new(repo, commit);
            remote.require_auth.store(false, Ordering::Release);
            remote
        }

        fn with_redirect(repo: &Repository, commit: Oid, redirect_username: Option<&str>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let redirect = redirect_username.map(|username| format!("Location: http://{username}@{address}/remote.git/info/refs?service=git-upload-pack\r\n"));
            let stopping = Arc::new(AtomicBool::new(false));
            let server_stopping = Arc::clone(&stopping);
            let require_auth = Arc::new(AtomicBool::new(true));
            let server_require_auth = Arc::clone(&require_auth);
            let authenticated_redirect = Arc::new(Mutex::new(None::<String>));
            let server_authenticated_redirect = Arc::clone(&authenticated_redirect);
            let authorized = Arc::new(Mutex::new(Vec::new()));
            let server_authorized = Arc::clone(&authorized);
            let observed_auth = Arc::new(Mutex::new(Vec::new()));
            let server_observed_auth = Arc::clone(&observed_auth);
            let requests = Arc::new(Mutex::new(Vec::new()));
            let server_requests = Arc::clone(&requests);
            let advertisement = [
                packet(b"# service=git-upload-pack\n"),
                b"0000".to_vec(),
                packet(
                    format!("{commit} HEAD\0multi_ack ofs-delta symref=HEAD:refs/heads/main\n")
                        .as_bytes(),
                ),
                packet(format!("{commit} refs/heads/main\n").as_bytes()),
                packet(format!("{commit} refs/tags/v1\n").as_bytes()),
                b"0000".to_vec(),
            ]
            .concat();
            let mut pack = repo.packbuilder().unwrap();
            pack.insert_commit(commit).unwrap();
            let mut contents = git2::Buf::new();
            pack.write_buf(&mut contents).unwrap();
            let pack = [packet(b"NAK\n"), contents.to_vec()].concat();
            let server = std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else {
                        break;
                    };
                    if server_stopping.load(Ordering::Acquire) {
                        break;
                    }
                    let Some((method, headers)) = read_http_request(&mut stream) else {
                        continue;
                    };
                    server_requests.lock().unwrap().push(method.clone());
                    server_observed_auth
                        .lock()
                        .unwrap()
                        .push(RequestAuthorization {
                            host: headers.get("host").cloned().unwrap_or_default(),
                            value: headers.get("authorization").cloned(),
                        });
                    if let Some(redirect) = &redirect
                        && server_requests.lock().unwrap().len() == 1
                    {
                        write_http(&mut stream, "302 Found", redirect, &[]);
                        continue;
                    }
                    if method == "CONNECT" {
                        write_http(&mut stream, "502 Bad Gateway", "", &[]);
                        continue;
                    }
                    if server_require_auth.load(Ordering::Acquire)
                        && headers.get("authorization").map(String::as_str)
                            != Some("Basic ZmV0Y2hlcjpzZWNyZXQ=")
                    {
                        write_http(
                            &mut stream,
                            "401 Unauthorized",
                            "WWW-Authenticate: Basic realm=\"fetch-fixture\"\r\n",
                            &[],
                        );
                        continue;
                    }
                    server_authorized.lock().unwrap().push(method.clone());
                    if method == "GET"
                        && let Some(location) =
                            server_authenticated_redirect.lock().unwrap().as_ref()
                    {
                        write_http(
                            &mut stream,
                            "302 Found",
                            &format!(
                                "Location: {location}\r\nWWW-Authenticate: Basic realm=\"fetch-fixture\"\r\n"
                            ),
                            &[],
                        );
                        continue;
                    }
                    let (content_type, body) = if method == "GET" {
                        (
                            "application/x-git-upload-pack-advertisement",
                            advertisement.as_slice(),
                        )
                    } else {
                        ("application/x-git-upload-pack-result", pack.as_slice())
                    };
                    write_http(
                        &mut stream,
                        "200 OK",
                        &format!("Content-Type: {content_type}\r\n"),
                        body,
                    );
                }
            });
            Self {
                address,
                stopping,
                require_auth,
                authenticated_redirect,
                authorized,
                observed_auth,
                requests,
                server: Some(server),
            }
        }

        fn url(&self) -> String {
            format!("http://{}/remote.git", self.address)
        }

        fn redirect_after_auth(&self, location: String) {
            *self.authenticated_redirect.lock().unwrap() = Some(location);
        }
    }

    impl Drop for HttpRemote {
        fn drop(&mut self) {
            self.stopping.store(true, Ordering::Release);
            let _ = TcpStream::connect(self.address);
            if let Some(server) = self.server.take() {
                server.join().unwrap();
            }
        }
    }

    fn packet(contents: &[u8]) -> Vec<u8> {
        [
            format!("{:04x}", contents.len() + 4).into_bytes(),
            contents.to_vec(),
        ]
        .concat()
    }

    fn read_http_request(
        stream: &mut TcpStream,
    ) -> Option<(String, std::collections::BTreeMap<String, String>)> {
        let mut reader = BufReader::new(stream);
        let mut first = String::new();
        reader.read_line(&mut first).ok()?;
        let method = first.split_whitespace().next()?.to_owned();
        let mut headers = std::collections::BTreeMap::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).ok()? == 0 {
                return None;
            }
            if line == "\r\n" {
                break;
            }
            let (name, value) = line.split_once(':')?;
            headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        }
        if headers
            .get("expect")
            .is_some_and(|value| value == "100-continue")
        {
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .ok()?;
        }
        if let Some(length) = headers.get("content-length") {
            let mut body = vec![0; length.parse().ok()?];
            reader.read_exact(&mut body).ok()?;
        } else if headers
            .get("transfer-encoding")
            .is_some_and(|value| value == "chunked")
        {
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).ok()?;
                let length = usize::from_str_radix(line.trim(), 16).ok()?;
                let mut body = vec![0; length + 2];
                reader.read_exact(&mut body).ok()?;
                if length == 0 {
                    break;
                }
            }
        }
        Some((method, headers))
    }

    fn write_http(stream: &mut TcpStream, status: &str, headers: &str, body: &[u8]) {
        let response = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\n{headers}Content-Length: {}\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.write_all(body);
    }

    struct FetchFixture {
        directory: TempDir,
        remote: Repository,
        local: Repository,
        first: Oid,
    }

    impl FetchFixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let remote = Repository::init_bare(directory.path().join("remote.git")).unwrap();
            isolate_repository(&remote);
            let signature = Signature::now("Fetcher", "fetcher@example.com").unwrap();
            let tree = remote.treebuilder(None).unwrap().write().unwrap();
            let tree = remote.find_tree(tree).unwrap();
            let first = remote
                .commit(
                    Some("refs/heads/main"),
                    &signature,
                    &signature,
                    "first",
                    &tree,
                    &[],
                )
                .unwrap();
            drop(tree);
            remote.set_head("refs/heads/main").unwrap();
            remote
                .reference("refs/tags/v1", first, false, "tag")
                .unwrap();
            let local = Repository::init(directory.path().join("local")).unwrap();
            isolate_repository(&local);
            local
                .config()
                .unwrap()
                .set_str("remote.origin.proxy", "")
                .unwrap();
            local
                .remote("origin", remote.path().to_str().unwrap())
                .unwrap();
            Self {
                directory,
                remote,
                local,
                first,
            }
        }

        fn request(&self) -> FetchRequest {
            FetchRequest {
                path: self.local.workdir().unwrap().to_string_lossy().into_owned(),
                remote: "origin".into(),
                append_fetch_head: false,
            }
        }

        fn advance(&self) -> Oid {
            let parent = self.remote.find_commit(self.first).unwrap();
            let signature = Signature::now("Fetcher", "fetcher@example.com").unwrap();
            self.remote
                .commit(
                    Some("refs/heads/main"),
                    &signature,
                    &signature,
                    "second",
                    &parent.tree().unwrap(),
                    &[&parent],
                )
                .unwrap()
        }

        fn linked(&self, branch: &str) -> Repository {
            let reference = self
                .local
                .reference(
                    &format!("refs/heads/{branch}"),
                    self.first,
                    false,
                    "linked branch",
                )
                .unwrap();
            let mut options = WorktreeAddOptions::new();
            options.reference(Some(&reference));
            let worktree = self
                .local
                .worktree(branch, &self.directory.path().join(branch), Some(&options))
                .unwrap();
            Repository::open_from_worktree(&worktree).unwrap()
        }
    }

    #[test]
    fn fetches_branches_tags_and_the_remote_head() {
        let fixture = FetchFixture::new();

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            fixture.first
        );
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/v1").unwrap(),
            fixture.first
        );
        assert_eq!(
            fixture
                .local
                .find_reference("refs/remotes/origin/HEAD")
                .unwrap()
                .symbolic_target()
                .unwrap(),
            Some("refs/remotes/origin/main")
        );
    }

    #[test]
    fn all_remotes_excludes_the_explicitly_skipped_remote() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .remote("skipped", fixture.remote.path().to_str().unwrap())
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_bool("remote.skipped.skipFetchAll", true)
            .unwrap();

        let remotes = super::applicable_remotes(&fixture.local).unwrap();

        assert_eq!(remotes, vec!["origin"]);
    }

    #[test]
    fn refuses_a_forced_destination_that_is_checked_out_before_any_ref_changes() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        fixture
            .local
            .reference("refs/heads/main", fixture.first, false, "local")
            .unwrap();
        fixture.local.set_head("refs/heads/main").unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.fetch", "+refs/heads/main:refs/heads/main")
            .unwrap();
        fixture.advance();
        let fetch_head = std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "fetch_destination_checked_out");
        assert_eq!(
            fixture.local.refname_to_id("refs/heads/main").unwrap(),
            fixture.first
        );
        assert_eq!(
            std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap(),
            fetch_head
        );
    }

    #[test]
    fn refuses_a_tag_rewrite_without_a_forced_tag_refspec() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let second = fixture.advance();
        fixture
            .remote
            .reference("refs/tags/v1", second, true, "retag")
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "fetch_tag_conflict");
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/v1").unwrap(),
            fixture.first
        );
    }

    #[test]
    fn accumulates_fetch_head_metadata_across_remotes() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        fixture
            .local
            .remote("backup", fixture.remote.path().to_str().unwrap())
            .unwrap();
        let original = std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap();
        let mut request = fixture.request();
        request.remote = "backup".into();
        request.append_fetch_head = true;

        execute(&request).unwrap();

        let accumulated = std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap();
        assert!(accumulated.starts_with(&original));
        assert!(accumulated.len() > original.len());
    }

    #[test]
    fn reports_a_negative_refspec_as_an_unsupported_capability() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .config()
            .unwrap()
            .set_multivar("remote.origin.fetch", "^missing$", "^refs/heads/private")
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    #[test]
    fn prunes_a_deleted_branch_through_a_custom_destination() {
        let fixture = FetchFixture::new();
        fixture
            .remote
            .reference("refs/heads/obsolete", fixture.first, false, "branch")
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.fetch", "+refs/heads/*:refs/custom/*")
            .unwrap();
        execute(&fixture.request()).unwrap();
        fixture
            .remote
            .find_reference("refs/heads/obsolete")
            .unwrap()
            .delete()
            .unwrap();

        execute(&fixture.request()).unwrap();

        assert!(
            fixture
                .local
                .find_reference("refs/custom/obsolete")
                .is_err()
        );
        assert_eq!(
            fixture.local.refname_to_id("refs/custom/main").unwrap(),
            fixture.first
        );
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/v1").unwrap(),
            fixture.first
        );
    }

    #[test]
    fn preserves_a_locally_existing_tag_when_the_remote_tag_disappears() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        fixture
            .remote
            .find_reference("refs/tags/v1")
            .unwrap()
            .delete()
            .unwrap();

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture.local.refname_to_id("refs/tags/v1").unwrap(),
            fixture.first
        );
    }

    #[test]
    fn applies_a_tag_rewrite_when_its_configured_refspec_is_forced() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_multivar(
                "remote.origin.fetch",
                "^missing$",
                "+refs/tags/*:refs/tags/*",
            )
            .unwrap();
        let second = fixture.advance();
        fixture
            .remote
            .reference("refs/tags/v1", second, true, "retag")
            .unwrap();

        execute(&fixture.request()).unwrap();

        assert_eq!(fixture.local.refname_to_id("refs/tags/v1").unwrap(), second);
    }

    #[test]
    fn refuses_a_destination_checked_out_in_another_linked_worktree() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let linked = fixture.linked("checked");
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.fetch", "+refs/heads/main:refs/heads/checked")
            .unwrap();
        fixture.advance();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "fetch_destination_checked_out");
        assert_eq!(linked.head().unwrap().target(), Some(fixture.first));
    }

    #[test]
    fn updates_private_destinations_and_fetch_metadata_in_each_worktree() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let linked = fixture.linked("linked");
        fixture
            .local
            .config()
            .unwrap()
            .set_str(
                "remote.origin.fetch",
                "+refs/heads/main:refs/worktree/from-origin",
            )
            .unwrap();
        execute(&fixture.request()).unwrap();
        let primary_metadata = std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap();
        let second = fixture.advance();
        let mut request = fixture.request();
        request.path = linked.workdir().unwrap().to_string_lossy().into_owned();

        execute(&request).unwrap();

        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/worktree/from-origin")
                .unwrap(),
            fixture.first
        );
        assert_eq!(
            linked.refname_to_id("refs/worktree/from-origin").unwrap(),
            second
        );
        assert_eq!(
            std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap(),
            primary_metadata
        );
        assert!(
            std::fs::read_to_string(linked.path().join("FETCH_HEAD"))
                .unwrap()
                .contains(&second.to_string())
        );
    }

    #[test]
    fn reports_written_metadata_when_preserving_the_batch_prefix_fails() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let prefix = std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap();
        let advanced = fixture.advance();
        let mut request = fixture.request();
        request.append_fetch_head = true;

        let outcome = super::execute_repository(&fixture.local, &request, |gitdir, earlier| {
            assert_eq!(earlier, prefix);
            let written = std::fs::read_to_string(gitdir.join("FETCH_HEAD")).unwrap();
            assert!(written.contains(&advanced.to_string()));
            Err(super::metadata_error())
        })
        .unwrap();

        assert_eq!(outcome.result.unwrap_err().code, "fetch_metadata");
        assert!(outcome.metadata_written);
        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            advanced
        );
    }

    #[test]
    fn restores_earlier_fetch_metadata_when_a_ref_update_fails() {
        let fixture = FetchFixture::new();
        let seed = Repository::init_bare(fixture.directory.path().join("earlier.git")).unwrap();
        isolate_repository(&seed);
        let signature = Signature::now("Seed", "seed@example.com").unwrap();
        let tree = seed.treebuilder(None).unwrap().write().unwrap();
        let seed_oid = seed
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "earlier remote",
                &seed.find_tree(tree).unwrap(),
                &[],
            )
            .unwrap();
        seed.set_head("refs/heads/main").unwrap();
        fixture
            .local
            .remote("earlier", seed.path().to_str().unwrap())
            .unwrap();
        let mut earlier = fixture.request();
        earlier.remote = "earlier".into();
        execute(&earlier).unwrap();
        let original = std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap();
        assert!(String::from_utf8_lossy(&original).contains("earlier.git"));
        assert!(String::from_utf8_lossy(&original).contains(&seed_oid.to_string()));
        fixture
            .remote
            .reference("refs/tags/v2", fixture.first, false, "new tag")
            .unwrap();
        std::fs::write(fixture.local.path().join("refs/tags/v2.lock"), b"occupied").unwrap();
        let mut request = fixture.request();
        request.append_fetch_head = true;

        let error = execute(&request).unwrap_err();

        assert_eq!(error.code, "git_error");
        assert!(
            std::fs::read(fixture.local.path().join("FETCH_HEAD"))
                .unwrap()
                .starts_with(&original)
        );
    }

    #[test]
    fn honors_url_rewriting_before_choosing_the_transport() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .remote_set_url("origin", "fixture:remote")
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str(
                &format!("url.{}.insteadOf", fixture.remote.path().to_str().unwrap()),
                "fixture:remote",
            )
            .unwrap();

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            fixture.first
        );
    }

    #[test]
    fn refuses_a_tag_destination_rewrite_from_a_nonforced_branch_refspec() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        fixture
            .local
            .reference("refs/tags/mirror", fixture.first, false, "tag")
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.fetch", "refs/heads/main:refs/tags/mirror")
            .unwrap();
        fixture.advance();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "fetch_tag_conflict");
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/mirror").unwrap(),
            fixture.first
        );
    }

    #[test]
    fn reports_a_non_fast_forward_local_branch_destination() {
        let fixture = FetchFixture::new();
        let second = fixture.advance();
        execute(&fixture.request()).unwrap();
        fixture
            .local
            .reference("refs/heads/tracking", second, false, "local")
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.fetch", "refs/heads/main:refs/heads/tracking")
            .unwrap();
        fixture
            .remote
            .reference("refs/heads/main", fixture.first, true, "rewind")
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "git_not_fast_forward");
        assert_eq!(
            fixture.local.refname_to_id("refs/heads/tracking").unwrap(),
            second
        );
    }

    #[test]
    fn authenticated_http_challenge_refuses_without_calling_a_helper() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::new(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        let captured = capture_helper(&fixture);

        let outcome = execute_with_receipt(&fixture.request());

        assert_eq!(outcome.result.unwrap_err().code, "unsupported_transport");
        assert!(!outcome.metadata_written);
        assert!(!captured.exists());
        assert!(!http.requests.lock().unwrap().is_empty());
        assert!(
            http.observed_auth
                .lock()
                .unwrap()
                .iter()
                .all(|auth| auth.value.is_none())
        );
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
        assert!(!fixture.local.path().join("FETCH_HEAD").exists());
    }

    #[test]
    fn an_http_url_with_embedded_credentials_is_refused_before_network_access() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::public(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!(
                    "http://fetcher:dummy-secret@localhost:{}/remote.git",
                    http.address.port()
                ),
            )
            .unwrap();
        let captured = capture_helper(&fixture);

        let outcome = execute_with_receipt(&fixture.request());

        assert_eq!(outcome.result.unwrap_err().code, "unsupported_transport");
        assert!(!outcome.metadata_written);
        assert!(!captured.exists());
        assert!(http.requests.lock().unwrap().is_empty());
        assert!(!fixture.local.path().join("FETCH_HEAD").exists());
    }

    #[test]
    fn a_scoped_empty_helper_reset_never_runs_a_global_helper() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::new(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        let captured = capture_helper(&fixture);
        fixture
            .local
            .config()
            .unwrap()
            .set_str("credential.http://localhost.helper", "")
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(!captured.exists());
        assert!(!http.requests.lock().unwrap().is_empty());
        assert!(
            http.observed_auth
                .lock()
                .unwrap()
                .iter()
                .all(|auth| auth.value.is_none())
        );
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    #[test]
    fn a_public_domain_remote_ignores_configured_helpers() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::public(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        let captured = capture_helper(&fixture);
        fixture
            .local
            .config()
            .unwrap()
            .set_str("credential.http://unrelated.example.helper", "")
            .unwrap();

        execute(&fixture.request()).unwrap();

        assert!(!captured.exists());
        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            fixture.first
        );
    }

    fn assert_http_auth_refusal_prevents_redirected_credential(destination_host: &str) {
        let fixture = FetchFixture::new();
        let origin = HttpRemote::new(&fixture.remote, fixture.first);
        let destination = HttpRemote::public(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", origin.address.port()),
            )
            .unwrap();
        origin.redirect_after_auth(format!(
            "http://{destination_host}:{}/remote.git/info/refs?service=git-upload-pack",
            destination.address.port()
        ));
        let captured = capture_helper(&fixture);

        let outcome = execute_with_receipt(&fixture.request());

        assert_eq!(outcome.result.unwrap_err().code, "unsupported_transport");
        assert!(!outcome.metadata_written);
        assert!(!captured.exists());
        assert!(!origin.requests.lock().unwrap().is_empty());
        assert!(origin.authorized.lock().unwrap().is_empty());
        assert!(
            origin
                .observed_auth
                .lock()
                .unwrap()
                .iter()
                .all(|auth| auth.value.is_none())
        );
        assert!(destination.requests.lock().unwrap().is_empty());
        assert!(
            destination
                .observed_auth
                .lock()
                .unwrap()
                .iter()
                .all(|auth| auth.value.as_deref() != Some("Basic ZmV0Y2hlcjpzZWNyZXQ="))
        );
    }

    #[test]
    fn http_auth_refusal_prevents_a_different_host_redirect() {
        assert_http_auth_refusal_prevents_redirected_credential("127.0.0.1");
    }

    #[test]
    fn http_auth_refusal_prevents_a_different_port_redirect() {
        assert_http_auth_refusal_prevents_redirected_credential("localhost");
    }

    #[test]
    fn a_public_ip_remote_ignores_configured_helpers() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::public(&fixture.remote, fixture.first);
        fixture.local.remote_set_url("origin", &http.url()).unwrap();
        let captured = capture_helper(&fixture);

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            fixture.first
        );
        assert!(!captured.exists());
        assert!(!http.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn an_ip_challenge_never_reads_or_sends_helper_credentials() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::new(&fixture.remote, fixture.first);
        fixture.local.remote_set_url("origin", &http.url()).unwrap();
        let captured = capture_helper(&fixture);

        let error = execute(&fixture.request()).unwrap_err();

        assert!(
            http.observed_auth
                .lock()
                .unwrap()
                .iter()
                .all(|auth| auth.value.is_none())
        );
        assert!(!captured.exists());
        assert_eq!(error.code, "unsupported_transport");
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
        assert!(!fixture.local.path().join("FETCH_HEAD").exists());
    }

    #[test]
    fn a_redirect_to_an_ip_challenge_never_reads_or_sends_helper_credentials() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::with_redirect(&fixture.remote, fixture.first, Some("fetcher"));
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        let captured = capture_helper(&fixture);

        let error = execute(&fixture.request()).unwrap_err();

        assert!(
            http.observed_auth
                .lock()
                .unwrap()
                .iter()
                // libgit2 may first try the username from the redirect URL
                // with an empty password, before asking our callback.
                .all(|auth| auth
                    .value
                    .as_deref()
                    .is_none_or(|value| value == "Basic ZmV0Y2hlcjo="))
        );
        assert!(!captured.exists());
        assert_eq!(error.code, "unsupported_transport");
        assert!(http.requests.lock().unwrap().len() >= 2);
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    #[test]
    fn a_global_authorization_header_never_reaches_a_redirected_host() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::with_redirect(&fixture.remote, fixture.first, Some("fetcher"));
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("http.extraheader", "Authorization: Bearer dummy-header")
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert!(http.observed_auth.lock().unwrap().iter().all(|auth| {
            !auth.host.starts_with("127.0.0.1:")
                || auth.value.as_deref() != Some("Bearer dummy-header")
        }));
        assert_eq!(error.code, "unsupported_transport");
        assert!(http.requests.lock().unwrap().is_empty());
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    #[test]
    fn an_empty_global_header_reset_keeps_the_direct_http_fetch_available() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::public(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        let mut config = fixture.local.config().unwrap();
        config
            .set_str("http.extraheader", "Authorization: Bearer stale")
            .unwrap();
        config.set_multivar("http.extraheader", "^$", "").unwrap();
        drop(config);
        let captured = capture_helper(&fixture);

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            fixture.first
        );
        assert!(
            http.observed_auth
                .lock()
                .unwrap()
                .iter()
                .all(|auth| { auth.value.as_deref() != Some("Bearer stale") })
        );
        assert!(!captured.exists());
    }

    #[test]
    fn applies_a_nonforced_ref_rewind_outside_local_branches_and_tags() {
        let fixture = FetchFixture::new();
        fixture.advance();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.fetch", "refs/heads/main:refs/custom/main")
            .unwrap();
        execute(&fixture.request()).unwrap();
        fixture
            .remote
            .reference("refs/heads/main", fixture.first, true, "rewind")
            .unwrap();

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture.local.refname_to_id("refs/custom/main").unwrap(),
            fixture.first
        );
    }

    #[test]
    fn resolves_a_local_remote_url_relative_to_the_open_worktree() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .remote_set_url("origin", "../remote.git")
            .unwrap();

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            fixture.first
        );
    }

    #[test]
    fn disabled_submodule_recursion_does_not_parse_worktree_submodule_metadata() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .config()
            .unwrap()
            .set_bool("fetch.recurseSubmodules", false)
            .unwrap();
        std::fs::write(
            fixture.local.workdir().unwrap().join(".gitmodules"),
            b"not a config\n",
        )
        .unwrap();

        execute(&fixture.request()).unwrap();

        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            fixture.first
        );
    }

    #[test]
    fn initialized_submodules_require_an_explicit_nonrecursive_policy() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("submodule.nested.url", "../nested.git")
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    #[test]
    fn refuses_a_nonforced_tag_rewrite_from_an_object_id_source() {
        let fixture = FetchFixture::new();
        let second = fixture.advance();
        execute(&fixture.request()).unwrap();
        fixture
            .local
            .reference("refs/tags/private", second, true, "existing tag")
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str(
                "remote.origin.fetch",
                &format!("{}:refs/tags/private", fixture.first),
            )
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "fetch_tag_conflict");
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/private").unwrap(),
            second
        );
    }

    #[test]
    fn reports_scoped_http_tls_policy_as_an_unsupported_capability() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .config()
            .unwrap()
            .set_bool("http.https://127.0.0.1:1/.sslVerify", false)
            .unwrap();

        let error = super::validate_http_headers(
            &fixture.local.config().unwrap(),
            "https://127.0.0.1:1/repo.git",
        )
        .unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
    }

    #[test]
    fn reports_scoped_http_headers_when_the_remote_has_a_username() {
        let fixture = FetchFixture::new();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("http.https://127.0.0.1:1/.extraHeader", "X-Fixture: true")
            .unwrap();

        let error = super::validate_http_headers(
            &fixture.local.config().unwrap(),
            "https://fetcher@127.0.0.1:1/repo.git",
        )
        .unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
    }

    #[test]
    fn reports_the_native_plain_http_proxy_limitation_before_connecting() {
        let fixture = FetchFixture::new();
        let proxy = HttpRemote::new(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url("origin", "http://upstream.invalid/remote.git")
            .unwrap();
        let mut config = fixture.local.config().unwrap();
        config
            .set_str("remote.origin.proxy", &format!("http://{}", proxy.address))
            .unwrap();
        config
            .set_str(
                "credential.helper",
                "!printf 'username=fetcher\\npassword=secret\\n'",
            )
            .unwrap();
        drop(config);

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(proxy.requests.lock().unwrap().is_empty());
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    #[test]
    fn routes_an_https_fetch_attempt_to_the_configured_connect_proxy() {
        let fixture = FetchFixture::new();
        let proxy = HttpRemote::new(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url("origin", "https://upstream.invalid/remote.git")
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.proxy", &format!("http://{}", proxy.address))
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_ne!(error.code, "unsupported_transport");
        assert_eq!(*proxy.requests.lock().unwrap(), vec!["CONNECT"]);
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    #[test]
    fn local_shallow_fetch_reports_its_capability_without_mutating_refs() {
        let fixture = FetchFixture::new();
        std::fs::write(
            fixture.local.path().join("shallow"),
            format!("{}\n", fixture.first),
        )
        .unwrap();
        assert!(fixture.local.is_shallow());

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
        assert!(fixture.local.find_reference("refs/tags/v1").is_err());
    }

    #[test]
    fn shallow_network_fetch_reports_its_capability_before_connecting() {
        let fixture = FetchFixture::new();
        let remote = HttpRemote::new(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url("origin", &format!("http://{}/repo.git", remote.address))
            .unwrap();
        std::fs::write(
            fixture.local.path().join("shallow"),
            format!("{}\n", fixture.first),
        )
        .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(remote.requests.lock().unwrap().is_empty());
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/main")
                .is_err()
        );
    }

    fn capture_helper(fixture: &FetchFixture) -> PathBuf {
        let captured = fixture.directory.path().join("helper-input");
        let path = captured.to_str().unwrap().replace('\'', "'\\''");
        fixture
            .local
            .config()
            .unwrap()
            .set_str(
                "credential.helper",
                &format!("!cat > '{path}'; printf 'username=fetcher\\npassword=secret\\n'"),
            )
            .unwrap();
        captured
    }

    #[test]
    fn refuses_an_encoded_http_url_username_before_connecting() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::new(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!(
                    "http://fetcher%0Ahost=victim.example@{}/remote.git",
                    http.address
                ),
            )
            .unwrap();
        let captured = capture_helper(&fixture);

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(
            !captured.exists(),
            "malicious fields reached the credential helper"
        );
        assert!(http.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn refuses_redirected_http_auth_without_calling_a_helper() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::with_redirect(
            &fixture.remote,
            fixture.first,
            Some("fetcher%0Ahost=victim.example"),
        );
        fixture.local.remote_set_url("origin", &http.url()).unwrap();
        let captured = capture_helper(&fixture);

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "unsupported_transport");
        assert!(
            !captured.exists(),
            "redirected malicious fields reached the credential helper"
        );
        assert!(http.requests.lock().unwrap().len() >= 2);
    }

    #[test]
    fn advances_other_refs_when_a_remote_tag_is_refused() {
        let fixture = FetchFixture::new();
        fixture
            .remote
            .reference("refs/heads/gone", fixture.first, false, "prune candidate")
            .unwrap();
        execute(&fixture.request()).unwrap();
        fixture
            .remote
            .find_reference("refs/heads/gone")
            .unwrap()
            .delete()
            .unwrap();
        let second = fixture.advance();
        fixture
            .remote
            .reference("refs/tags/v1", second, true, "retag")
            .unwrap();
        fixture
            .remote
            .reference("refs/tags/v2", second, false, "healthy tag")
            .unwrap();

        let outcome = execute_with_receipt(&fixture.request());
        assert!(outcome.metadata_written);
        let error = outcome.result.unwrap_err();

        assert_eq!(error.code, "fetch_tag_conflict");
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/v1").unwrap(),
            fixture.first
        );
        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            second
        );
        assert_eq!(fixture.local.refname_to_id("refs/tags/v2").unwrap(), second);
        assert!(
            fixture
                .local
                .find_reference("refs/remotes/origin/gone")
                .is_err()
        );
        let metadata = std::fs::read_to_string(fixture.local.path().join("FETCH_HEAD")).unwrap();
        for line in metadata.lines() {
            assert_eq!(line.split('\t').nth(1), Some("not-for-merge"));
        }
        assert!(metadata.contains(&format!("{second}\tnot-for-merge\ttag 'v1'")));
    }

    #[test]
    fn advances_other_refs_when_a_local_branch_rewind_is_refused() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let second = fixture.advance();
        execute(&fixture.request()).unwrap();
        fixture
            .local
            .reference(
                "refs/heads/tracking",
                second,
                true,
                "ahead local destination",
            )
            .unwrap();
        fixture
            .remote
            .reference("refs/heads/stale", fixture.first, false, "stale branch")
            .unwrap();
        fixture
            .local
            .remote_add_fetch("origin", "refs/heads/stale:refs/heads/tracking")
            .unwrap();
        let parent = fixture.remote.find_commit(second).unwrap();
        let signature = Signature::now("Fetcher", "fetcher@example.com").unwrap();
        let third = fixture
            .remote
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "third",
                &parent.tree().unwrap(),
                &[&parent],
            )
            .unwrap();
        fixture
            .remote
            .reference("refs/tags/v2", third, false, "healthy tag")
            .unwrap();

        let error = execute(&fixture.request()).unwrap_err();

        assert_eq!(error.code, "git_not_fast_forward");
        assert_eq!(
            fixture.local.refname_to_id("refs/heads/tracking").unwrap(),
            second
        );
        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            third
        );
        assert_eq!(fixture.local.refname_to_id("refs/tags/v2").unwrap(), third);
    }
    #[test]
    fn configured_http_username_never_reaches_a_helper_or_remote() {
        let fixture = FetchFixture::new();
        let http = HttpRemote::new(&fixture.remote, fixture.first);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        let captured = capture_helper(&fixture);
        fixture
            .local
            .config()
            .unwrap()
            .set_str("credential.username", "fetcher\nhost=victim.example")
            .unwrap();
        assert_eq!(
            execute(&fixture.request()).unwrap_err().code,
            "unsupported_transport"
        );
        assert!(!captured.exists());
        assert!(
            http.observed_auth
                .lock()
                .unwrap()
                .iter()
                .all(|auth| auth.value.is_none())
        );
    }

    #[test]
    fn rejects_control_characters_in_each_credential_input() {
        for control in ["%00", "%0a", "%0A", "%0d", "%0D", "\0", "\r", "\n"] {
            for url in [
                format!("https://{control}user@example.test/path"),
                format!("https://example.test/{control}path"),
            ] {
                assert!(super::validate_credential_input(&url, None).is_err());
            }
        }
        for username in ["user\0suffix", "user\rsuffix", "user\nsuffix"] {
            assert!(
                super::validate_credential_input("https://example.test/path", Some(username))
                    .is_err()
            );
        }
    }

    #[test]
    fn reports_no_new_metadata_when_preflight_refuses_a_remote() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let original = std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap();
        fixture
            .local
            .remote_add_fetch("origin", "^refs/heads/private")
            .unwrap();
        let outcome = execute_with_receipt(&fixture.request());
        assert_eq!(outcome.result.unwrap_err().code, "unsupported_transport");
        assert!(!outcome.metadata_written);
        assert_eq!(
            std::fs::read(fixture.local.path().join("FETCH_HEAD")).unwrap(),
            original
        );
    }

    #[test]
    fn reports_metadata_from_a_successful_remote() {
        let fixture = FetchFixture::new();
        let outcome = execute_with_receipt(&fixture.request());
        outcome.result.unwrap();
        assert!(outcome.metadata_written);
    }
    #[test]
    fn partial_public_http_updates_preserve_ref_and_metadata_behavior() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let second = fixture.advance();
        let http = HttpRemote::public(&fixture.remote, second);
        fixture
            .local
            .remote_set_url(
                "origin",
                &format!("http://localhost:{}/remote.git", http.address.port()),
            )
            .unwrap();
        let outcome = execute_with_receipt(&fixture.request());
        assert_eq!(outcome.result.unwrap_err().code, "fetch_tag_conflict");
        assert!(outcome.metadata_written);
        assert_eq!(
            fixture
                .local
                .refname_to_id("refs/remotes/origin/main")
                .unwrap(),
            second
        );
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/v1").unwrap(),
            fixture.first
        );
        assert!(http.authorized.lock().unwrap().len() >= 3);
    }

    #[test]
    fn resolved_ssh_settings_preserve_relative_paths_and_configured_identities() {
        let directory = tempfile::tempdir().unwrap();
        let config = std::collections::BTreeMap::from([
            ("user".into(), vec!["fetcher".into()]),
            ("hostname".into(), vec!["127.0.0.1".into()]),
            ("port".into(), vec!["2222".into()]),
            (
                "identityfile".into(),
                vec!["~/.ssh/first".into(), "~/.ssh/second".into()],
            ),
            ("identitiesonly".into(), vec!["yes".into()]),
        ]);
        let address = super::SshAddress::parse("git@fixture:relative/repo.git")
            .unwrap()
            .unwrap();
        let settings = super::ssh_settings(
            &address,
            &config,
            &std::collections::BTreeMap::new(),
            Some(directory.path()),
        )
        .unwrap();
        assert_eq!(settings.url, "[fetcher@127.0.0.1:2222]:relative/repo.git");
        assert_eq!(settings.username, "fetcher");
        assert_eq!(
            settings.identities,
            vec![
                directory.path().join(".ssh/first"),
                directory.path().join(".ssh/second")
            ]
        );
        assert!(!settings.use_agent);
    }

    #[test]
    fn resolved_ssh_policy_accepts_algorithm_reordering_and_refuses_proxyjump() {
        let directory = tempfile::tempdir().unwrap();
        let mut effective = std::collections::BTreeMap::from([
            ("user".into(), vec!["git".into()]),
            ("hostname".into(), vec!["127.0.0.1".into()]),
            ("ciphers".into(), vec!["second,first".into()]),
        ]);
        let defaults =
            std::collections::BTreeMap::from([("ciphers".into(), vec!["first,second".into()])]);
        let address = super::SshAddress::parse("ssh://git@fixture/absolute/repo.git")
            .unwrap()
            .unwrap();
        let settings =
            super::ssh_settings(&address, &effective, &defaults, Some(directory.path())).unwrap();
        assert_eq!(settings.url, "ssh://git@127.0.0.1:22/absolute/repo.git");
        assert!(settings.use_agent);
        effective.insert("proxyjump".into(), vec!["jump.example".into()]);
        assert_eq!(
            super::ssh_settings(&address, &effective, &defaults, Some(directory.path()))
                .unwrap_err()
                .code,
            "unsupported_transport"
        );
    }
    #[test]
    fn partial_updates_preserve_source_only_head_fetch_metadata() {
        let fixture = FetchFixture::new();
        execute(&fixture.request()).unwrap();
        let second = fixture.advance();
        fixture
            .remote
            .reference("refs/tags/v1", second, true, "retag")
            .unwrap();
        fixture
            .local
            .config()
            .unwrap()
            .set_str("remote.origin.fetch", "HEAD")
            .unwrap();

        let outcome = execute_with_receipt(&fixture.request());

        assert_eq!(outcome.result.unwrap_err().code, "fetch_tag_conflict");
        assert!(outcome.metadata_written);
        let metadata = std::fs::read_to_string(fixture.local.path().join("FETCH_HEAD")).unwrap();
        assert!(
            metadata
                .lines()
                .any(|line| line.starts_with(&format!("{second}\t\t")))
        );
        assert!(metadata.contains(&format!("{second}\tnot-for-merge\ttag 'v1'")));
        assert_eq!(
            fixture.local.refname_to_id("refs/tags/v1").unwrap(),
            fixture.first
        );
    }
}
