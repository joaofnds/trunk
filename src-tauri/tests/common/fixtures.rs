use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

const CORPORA: [(&str, &str); 3] = [
    ("qa-stash-fixtures.sh", "stash"),
    ("qa-graph-lane-fixtures.sh", "lane"),
    ("qa-graph-merge-fixtures.sh", "merge"),
];

/// The fixture corpus root, built once per process and reused across runs.
pub fn corpus() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(build_corpus)
}

/// Every fixture repository in the corpus, as (name, path), sorted by name.
pub fn repositories() -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();

    for (_, subdir) in CORPORA {
        let dir = corpus().join(subdir);
        for entry in std::fs::read_dir(&dir).expect("read corpus subdir") {
            let path = entry.expect("read corpus entry").path();
            if !is_repository(&path) {
                continue;
            }
            let name = path
                .file_name()
                .expect("fixture has a name")
                .to_string_lossy()
                .into_owned();
            found.push((format!("{subdir}-{name}"), path));
        }
    }

    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// The bare fixture has no `.git`; its HEAD sits at the top level.
fn is_repository(path: &Path) -> bool {
    path.join(".git").is_dir() || path.join("HEAD").is_file()
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("manifest dir has a parent")
        .to_path_buf()
}

/// Run every fixture script into `dest`, one subdirectory per corpus.
pub fn build_into(dest: &Path) {
    let root = repo_root();

    for (script, subdir) in CORPORA {
        let status = Command::new(root.join("scripts").join(script))
            .arg(dest.join(subdir))
            .stdout(Stdio::null())
            .status()
            .unwrap_or_else(|e| panic!("run {script}: {e}"));
        assert!(status.success(), "{script} exited {status}");
    }
}

fn build_corpus() -> PathBuf {
    let root = repo_root();
    let scripts: Vec<PathBuf> = CORPORA
        .iter()
        .map(|(script, _)| root.join("scripts").join(script))
        .collect();

    let key = cache_key(&scripts);
    let cache = root
        .join("src-tauri/target/graph-fixtures")
        .join(format!("{key:016x}"));
    if cache.join(".complete").is_file() {
        return cache;
    }

    let staging = cache
        .parent()
        .expect("cache has a parent")
        .join(format!("staging-{key:016x}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).expect("create staging dir");

    build_into(&staging);
    std::fs::write(staging.join(".complete"), "").expect("write completion marker");

    // Another test binary may have finished the same corpus first; its copy is
    // equivalent, so losing the rename is success, not failure.
    if std::fs::rename(&staging, &cache).is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    cache
}

/// Every reference in a repository, as sorted `name=oid` pairs. Two builds of a
/// reproducible fixture agree here; a drifting timestamp or identity does not.
pub fn reference_fingerprint(path: &Path) -> Vec<String> {
    let repo = git2::Repository::open(path).expect("open fixture repository");
    let mut refs = Vec::new();

    for reference in repo.references().expect("list references") {
        let reference = reference.expect("read reference");
        if let (Ok(name), Some(oid)) = (reference.name(), reference.target()) {
            refs.push(format!("{name}={oid}"));
        }
    }

    refs.sort();
    refs
}

fn cache_key(scripts: &[PathBuf]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for script in scripts {
        std::fs::read_to_string(script)
            .unwrap_or_else(|e| panic!("read {}: {e}", script.display()))
            .hash(&mut hasher);
    }
    hasher.finish()
}
