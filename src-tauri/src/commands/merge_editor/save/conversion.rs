use super::{bounded_output, path_git, stage_error};
use std::collections::{BTreeMap, HashMap, HashSet, hash_map::Entry};
use std::io::{Seek, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use trunk_git::error::TrunkError;

const ATTRIBUTES: [&str; 6] = [
    "text",
    "crlf",
    "eol",
    "ident",
    "working-tree-encoding",
    "filter",
];
const CORE: [&str; 4] = [
    "core.autocrlf",
    "core.eol",
    "core.safecrlf",
    "core.checkroundtripencoding",
];
const DRIVER: [&str; 3] = ["clean", "process", "required"];

/// Capture the conversion inputs for hash-object. Both reads are batched
/// across all the paths in a Mark.
#[derive(Default)]
pub(in crate::commands::merge_editor) struct CleanConversions {
    core: Vec<Vec<u8>>,
    paths: HashMap<Vec<u8>, Vec<Vec<u8>>>,
}

impl CleanConversions {
    pub(in crate::commands::merge_editor) fn read<'a>(
        repo: &git2::Repository,
        index: &Path,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Result<Self, TrunkError> {
        // A fresh handle avoids reusing attribute entries cached by the initial
        // read (e.g. an equal-length rewrite in the same timestamp tick).
        let current = git2::Repository::open(repo.path())?;
        let config = current.config()?.snapshot()?;
        let paths: Vec<_> = paths.into_iter().collect();
        if requires_user_git(&config)? {
            return Self::read_git(repo, index, &paths);
        }
        let mut snapshot = Self::default();
        for key in CORE {
            append_config(&config, key, &mut snapshot.core)?;
        }
        for &path in &paths {
            let mut rules = Vec::new();
            for name in ATTRIBUTES {
                let raw = current.get_attr_bytes(
                    Path::new(path),
                    name,
                    git2::AttrCheckFlags::FILE_THEN_INDEX,
                )?;
                let attr = git2::AttrValue::always_bytes(raw);
                match attr {
                    git2::AttrValue::True => rules.push(vec![1]),
                    git2::AttrValue::False => rules.push(vec![0]),
                    git2::AttrValue::Unspecified => rules.push(Vec::new()),
                    git2::AttrValue::Bytes(b) => {
                        rules.push([&[2], b].concat());
                        if name == "filter" {
                            let Ok(driver) = std::str::from_utf8(b) else {
                                return Self::read_git(repo, index, &paths);
                            };
                            for option in DRIVER {
                                append_config(
                                    &config,
                                    &format!("filter.{driver}.{option}"),
                                    &mut rules,
                                )?;
                            }
                        }
                    }
                    git2::AttrValue::String(_) => unreachable!("always_bytes returns byte strings"),
                }
            }
            snapshot.paths.insert(path.as_bytes().to_vec(), rules);
        }
        Ok(snapshot)
    }

    fn read_git(repo: &git2::Repository, index: &Path, paths: &[&str]) -> Result<Self, TrunkError> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut names = tempfile::tempfile().map_err(stage_error)?;
        for path in paths {
            names
                .write_all(path.as_bytes())
                .and_then(|()| names.write_all(&[0]))
                .map_err(stage_error)?;
        }
        names.rewind().map_err(stage_error)?;
        let mut attrs = path_git(repo, index)?;
        attrs
            .args(["check-attr", "-z", "--all", "--stdin"])
            .stdin(names.into());
        let mut config = path_git(repo, index)?;
        config.args(["config", "--null", "--get-regexp",
            r"^(core\.(autocrlf|eol|safecrlf|checkroundtripencoding)|filter\..*\.(clean|process|required))$"]);
        let (attrs, config) = tauri::async_runtime::block_on(async {
            tokio::try_join!(bounded_output(attrs), bounded_output(config))
        })
        .map_err(stage_error)?;
        if !attrs.status.success() {
            return Err(stage_error("Git could not read the conversion attributes."));
        }
        // --get-regexp exits 1 when none of the keys are configured.
        if !config.status.success() && config.status.code() != Some(1) {
            return Err(stage_error("Git could not read the conversion settings."));
        }
        // NUL-terminated config records distinguish a missing value (implicit
        // true) from an explicit empty value. The last entry wins for each key.
        let settings: BTreeMap<_, _> = config
            .stdout
            .split(|&b| b == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| (entry.split(|&b| b == b'\n').next().unwrap_or(entry), entry))
            .collect();
        let core = settings
            .iter()
            .filter(|(key, _)| key.starts_with(b"core."))
            .map(|(_, entry)| entry.to_vec())
            .collect();
        let mut snapshot = Self {
            core,
            paths: paths
                .iter()
                .map(|p| (p.as_bytes().to_vec(), Vec::new()))
                .collect(),
        };
        let mut booleans = HashMap::new();
        let mut entries = attrs.stdout.split(|&b| b == 0);
        while let Some(path) = entries.next().filter(|path| !path.is_empty()) {
            let name = entries
                .next()
                .ok_or_else(|| stage_error("Incomplete Git attributes."))?;
            let value = entries
                .next()
                .ok_or_else(|| stage_error("Missing Git attribute value."))?;
            let Some(&attribute) = ATTRIBUTES.iter().find(|a| a.as_bytes() == name) else {
                continue;
            };
            // check-attr prints both a Boolean and the corresponding literal
            // string as "set"/"unset". A pathspec tests the typed value.
            let boolean = if matches!(value, b"set" | b"unset") {
                let positive = value == b"set";
                let matching = match booleans.entry((attribute, positive)) {
                    Entry::Occupied(entry) => entry.into_mut(),
                    Entry::Vacant(entry) => entry.insert(boolean_conflicts(
                        repo, index, paths, attribute, positive, deadline,
                    )?),
                };
                matching.contains(path)
            } else {
                false
            };
            let rules = snapshot.paths.entry(path.to_vec()).or_default();
            let kind = if boolean { b':' } else { b'=' };
            rules.push([name, &[kind], value].concat());
            if name == b"filter" && !boolean {
                for option in DRIVER {
                    let key = [b"filter.", value, b".", option.as_bytes()].concat();
                    if let Some(entry) = settings.get(key.as_slice()) {
                        rules.push(entry.to_vec());
                    }
                }
            }
        }
        // Git may enumerate attributes in a different order after an unrelated edit.
        for rules in snapshot.paths.values_mut() {
            rules.sort();
        }
        Ok(snapshot)
    }

    pub(in crate::commands::merge_editor) fn validate(
        &self,
        repo: &git2::Repository,
        index: &Path,
        paths: &[&str],
    ) -> Result<(), TrunkError> {
        if paths.is_empty() {
            return Ok(());
        }
        let current = Self::read(repo, index, paths.iter().copied())?;
        for path in paths {
            let before = self.paths.get(path.as_bytes());
            if before.is_none()
                || self.core != current.core
                || before != current.paths.get(path.as_bytes())
            {
                return Err(stage_error(format!(
                    "Git's conversion rules changed for {path}. Review the rules and retry staging."
                )));
            }
        }
        Ok(())
    }
}

fn boolean_conflicts(
    repo: &git2::Repository,
    index: &Path,
    paths: &[&str],
    attribute: &str,
    positive: bool,
    deadline: Instant,
) -> Result<HashSet<Vec<u8>>, TrunkError> {
    let sign = if positive { "" } else { "-" };
    let file = if let [path] = paths { path } else { "" };
    let pathspec = format!(":(top,literal,attr:{sign}{attribute}){file}");
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| stage_error("Reading Git conversion attributes timed out."))?;
    let mut git = path_git(repo, index)?;
    git.env("GIT_LITERAL_PATHSPECS", "0")
        .args(["ls-files", "-z", "--unmerged", "--", &pathspec]);
    let output =
        tauri::async_runtime::block_on(async { git.spawn()?.wait_bounded(remaining).await })
            .map_err(stage_error)?;
    if !output.status.success() {
        return Err(stage_error(
            "Git could not distinguish the conversion attributes.",
        ));
    }
    // --unmerged prints mode, OID and stage before the tab. A filename can
    // contain subsequent tabs and newlines. NUL terminates each record.
    let mut matches = HashSet::new();
    for record in output.stdout.split(|&b| b == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|&b| b == b'\t')
            .ok_or_else(|| stage_error("Incomplete unmerged entry from Git."))?;
        matches.insert(record[tab + 1..].to_vec());
    }
    Ok(matches)
}

fn append_config(
    config: &git2::Config,
    key: &str,
    into: &mut Vec<Vec<u8>>,
) -> Result<(), git2::Error> {
    match config.get_entry(key) {
        Ok(entry) if entry.has_value() => {
            into.push([key.as_bytes(), b"\n", entry.value_bytes()].concat());
        }
        Ok(_) => into.push(key.as_bytes().to_vec()),
        Err(error) if error.code() == git2::ErrorCode::NotFound => (),
        Err(error) => return Err(error),
    }
    Ok(())
}

// libgit2 uses its own global/system configuration lookup and supports only
// gitdir, gitdir/i and onbranch includeIf conditions. Ask the installed Git
// when a caller overrides its inputs or the repository uses another condition.
fn requires_user_git(config: &git2::Config) -> Result<bool, git2::Error> {
    if [
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_SYSTEM",
        "GIT_ATTR_SOURCE",
        "GIT_ATTR_NOSYSTEM",
        "GIT_ATTR_GLOBAL",
        "GIT_ATTR_SYSTEM",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some())
        || std::env::var_os("GIT_CONFIG_COUNT").is_some_and(|n| n != "0")
        || std::env::var_os("GIT_CONFIG_GLOBAL").is_some_and(|p| p != "/dev/null")
    {
        return Ok(true);
    }
    let ignored_global = std::env::var_os("GIT_CONFIG_GLOBAL").is_some();
    let ignored_system = std::env::var_os("GIT_CONFIG_NOSYSTEM").is_some();
    let mut entries = config.entries(None)?;
    while let Some(entry) = entries.next() {
        let entry = entry?;
        let key = entry.name_bytes();
        if let Some(condition) = key.strip_prefix(b"includeif.")
            && ![b"gitdir:".as_slice(), b"gitdir/i:", b"onbranch:"]
                .iter()
                .any(|prefix| condition.starts_with(prefix))
        {
            return Ok(true);
        }
        let ignored = match entry.level() {
            git2::ConfigLevel::Global | git2::ConfigLevel::XDG => ignored_global,
            git2::ConfigLevel::System | git2::ConfigLevel::ProgramData => ignored_system,
            _ => false,
        };
        if ignored
            && (key == b"core.attributesfile"
                || key.starts_with(b"filter.")
                || CORE.iter().any(|k| k.as_bytes() == key))
        {
            return Ok(true);
        }
    }
    Ok(false)
}
