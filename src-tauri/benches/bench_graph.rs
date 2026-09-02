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
        let blob_oid = repo.blob(format!("content-{}", i).as_bytes()).unwrap();

        let mut tb = repo.treebuilder(None).unwrap();
        tb.insert(format!("file{}.txt", i), blob_oid, 0o100644)
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
                &format!("Commit {}", i),
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

fn bench_walk_commits(c: &mut Criterion) {
    let mut group = c.benchmark_group("walk_commits");
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
                    trunk_lib::git::graph::walk_commits(
                        &mut repo,
                        0,
                        usize::MAX,
                        &trunk_lib::git::graph_input::RefVisibility::default(),
                    )
                    .unwrap()
                });
            },
        );
    }
    group.finish();
}

criterion_group!(benches, bench_walk_commits);
criterion_main!(benches);
