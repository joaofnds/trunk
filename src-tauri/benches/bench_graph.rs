use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use std::sync::OnceLock;
use std::time::Duration;

struct BenchRepo {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

/// Create a linear repo with `n` commits on a single `refs/heads/main` branch.
///
/// Uses git2's in-memory blob + treebuilder API to avoid filesystem I/O.
/// Each commit gets its own single-file tree (not cumulative) to keep creation fast.
fn make_linear_repo(n: usize) -> BenchRepo {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("Bench", "bench@test.com").unwrap();

    let mut parent_oid: Option<git2::Oid> = None;

    for i in 0..n {
        let blob_oid = repo.blob(format!("content-{i}").as_bytes()).unwrap();

        let mut tb = repo.treebuilder(None).unwrap();
        tb.insert(format!("file{i}.txt"), blob_oid, 0o100644)
            .unwrap();
        let tree_oid = tb.write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();

        let parents: Vec<git2::Commit> = parent_oid
            .map(|oid| repo.find_commit(oid).unwrap())
            .into_iter()
            .collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

        let oid = repo
            .commit(
                Some("refs/heads/main"),
                &sig,
                &sig,
                &format!("Commit {i}"),
                &tree,
                &parent_refs,
            )
            .unwrap();
        parent_oid = Some(oid);
    }

    BenchRepo {
        path: dir.path().to_path_buf(),
        _dir: dir,
    }
}

// OnceLock-cached fixtures -- created once, reused across all iterations
static REPO_100: OnceLock<BenchRepo> = OnceLock::new();
static REPO_1K: OnceLock<BenchRepo> = OnceLock::new();
static REPO_10K: OnceLock<BenchRepo> = OnceLock::new();

fn bench_snapshot(c: &mut Criterion) {
    let mut group = c.benchmark_group("snapshot");
    group.warm_up_time(Duration::from_secs(3));
    group.measurement_time(Duration::from_secs(5));

    let configs: &[(&str, usize, &OnceLock<BenchRepo>)] = &[
        ("100", 100, &REPO_100),
        ("1k", 1_000, &REPO_1K),
        ("10k", 10_000, &REPO_10K),
    ];

    for &(label, size, lock) in configs {
        let bench_repo = lock.get_or_init(|| make_linear_repo(size));

        // Use smaller sample size for the 10k case since each iteration is slower
        if size >= 10_000 {
            group.sample_size(20);
        }

        group.bench_with_input(
            BenchmarkId::from_parameter(label),
            &bench_repo.path,
            |b, path| {
                b.iter(|| {
                    let mut repo = git2::Repository::open(path).unwrap();
                    trunk_lib::git::graph::snapshot(
                        &mut repo,
                        &trunk_lib::git::graph_input::RefVisibility::default(),
                    )
                    .unwrap()
                });
            },
        );
    }
    group.finish();
}

static TOGGLE_REPO_1K: OnceLock<BenchRepo> = OnceLock::new();
static TOGGLE_REPO_10K: OnceLock<BenchRepo> = OnceLock::new();

/// A sidebar toggle against a walk of the same repository: the toggle re-lays out the
/// cached capture, so its cost is the visibility pass plus placement, never git.
fn bench_toggle_visibility(c: &mut Criterion) {
    use trunk_lib::git::graph_input::RefVisibility;

    let mut group = c.benchmark_group("toggle_visibility");
    group.warm_up_time(Duration::from_secs(3));
    group.measurement_time(Duration::from_secs(5));

    let configs: &[(&str, usize, &OnceLock<BenchRepo>)] = &[
        ("1k", 1_000, &TOGGLE_REPO_1K),
        ("10k", 10_000, &TOGGLE_REPO_10K),
    ];

    for &(label, size, lock) in configs {
        let bench_repo = lock.get_or_init(|| make_linear_repo_with_side_branch(size));
        let mut hidden = RefVisibility::default();
        hidden.hidden_refs.insert("refs/heads/side".to_owned());
        let cached = {
            let mut repo = git2::Repository::open(&bench_repo.path).unwrap();
            trunk_lib::git::graph::snapshot(&mut repo, &RefVisibility::default()).unwrap()
        };

        if size >= 10_000 {
            group.sample_size(20);
        }

        group.bench_with_input(
            BenchmarkId::new("walk", label),
            &bench_repo.path,
            |b, path| {
                b.iter(|| {
                    let mut repo = git2::Repository::open(path).unwrap();
                    trunk_lib::git::graph::snapshot(&mut repo, &hidden).unwrap()
                });
            },
        );
        group.bench_with_input(BenchmarkId::new("cached", label), &cached, |b, cached| {
            b.iter(|| cached.with_visibility(hidden.clone()));
        });
    }
    group.finish();
}

/// `make_linear_repo` plus `refs/heads/side` on the tip, so there is a ref to hide that is
/// not HEAD's.
fn make_linear_repo_with_side_branch(n: usize) -> BenchRepo {
    let bench_repo = make_linear_repo(n);
    let repo = git2::Repository::open(&bench_repo.path).unwrap();
    let tip = repo.head().unwrap().target().unwrap();
    repo.reference("refs/heads/side", tip, false, "bench")
        .unwrap();

    bench_repo
}

criterion_group!(benches, bench_snapshot, bench_toggle_visibility);
criterion_main!(benches);
