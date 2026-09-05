use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

struct BenchRepo {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

/// Create a linear repo with `n` commits for graph benchmarks.
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

/// Create a repo with branches and unstaged changes for combined benchmarks.
fn make_startup_repo() -> BenchRepo {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("Bench", "bench@test.com").unwrap();

    // Create 100 commits
    let mut parent_oid: Option<git2::Oid> = None;
    for i in 0..100 {
        std::fs::write(
            dir.path().join(format!("file{i}.txt")),
            format!("content-{i}"),
        )
        .unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new(&format!("file{i}.txt")))
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
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

    // Create 10 branches
    let head_commit = repo.find_commit(parent_oid.unwrap()).unwrap();
    for b in 0..10 {
        repo.branch(&format!("feature-{b}"), &head_commit, false)
            .unwrap();
    }

    // Create unstaged changes
    std::fs::write(dir.path().join("file0.txt"), "modified content").unwrap();

    BenchRepo {
        path: dir.path().to_path_buf(),
        _dir: dir,
    }
}

// OnceLock fixtures
static REPO_1K: OnceLock<BenchRepo> = OnceLock::new();
static REPO_STARTUP: OnceLock<BenchRepo> = OnceLock::new();

/// BENCH-03: Measure IPC round-trip cost = inner function + serde serialization.
/// This captures the server-side processing time that dominates each `invoke()` call.
fn bench_ipc_get_graph(c: &mut Criterion) {
    let mut group = c.benchmark_group("ipc_round_trip");
    group.warm_up_time(Duration::from_secs(3));
    group.measurement_time(Duration::from_secs(5));

    let bench_repo = REPO_1K.get_or_init(|| make_linear_repo(1_000));

    // Measure: graph::snapshot (compute) + serde_json::to_string (serialize)
    group.bench_function("get_commit_graph", |b| {
        b.iter(|| {
            let mut repo = git2::Repository::open(&bench_repo.path).unwrap();
            let result = trunk_lib::git::graph::snapshot(
                &mut repo,
                &trunk_lib::git::graph_input::RefVisibility::default(),
            )
            .unwrap()
            .layout;
            // Simulate the command boundary: slice to 200 commits + serialize
            let len = result.commits.len();
            let end = 200.min(len);
            let response = trunk_lib::commands::history::GraphResponse {
                commits: result.commits[..end].to_vec(),
                max_columns: result.max_columns,
            };
            serde_json::to_string(&response).unwrap()
        });
    });

    group.finish();
}

fn bench_ipc_list_refs(c: &mut Criterion) {
    let mut group = c.benchmark_group("ipc_round_trip");

    let bench_repo = REPO_STARTUP.get_or_init(make_startup_repo);
    let path = bench_repo.path.display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), bench_repo.path.clone());

    // Measure: list_refs_inner (compute) + serde_json::to_string (serialize)
    group.bench_function("list_refs", |b| {
        b.iter(|| {
            let result = trunk_lib::commands::branches::list_refs_inner(&path, &state_map).unwrap();
            serde_json::to_string(&result).unwrap()
        });
    });

    group.finish();
}

fn bench_ipc_diff_unstaged(c: &mut Criterion) {
    let mut group = c.benchmark_group("ipc_round_trip");

    let bench_repo = REPO_STARTUP.get_or_init(make_startup_repo);
    let path = bench_repo.path.display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), bench_repo.path.clone());

    // Measure: diff_unstaged_inner (compute) + serde_json::to_string (serialize)
    group.bench_function("diff_unstaged", |b| {
        b.iter(|| {
            let result = trunk_lib::commands::diff::diff_unstaged_inner(
                &path,
                "file0.txt",
                &state_map,
                &trunk_lib::git::types::DiffRequestOptions::default(),
            )
            .unwrap();
            serde_json::to_string(&result).unwrap()
        });
    });

    group.finish();
}

/// BENCH-04: Measure cold-start sequence — the sequential operations that must complete
/// before the app can show its first meaningful paint:
///   open repo → `graph::snapshot` → `list_refs` → `get_status`
fn bench_startup_sequence(c: &mut Criterion) {
    let mut group = c.benchmark_group("startup");
    group.warm_up_time(Duration::from_secs(3));
    group.measurement_time(Duration::from_secs(5));

    let bench_repo = REPO_STARTUP.get_or_init(make_startup_repo);
    let path_str = bench_repo.path.display().to_string();

    let configs: &[(&str, usize)] = &[("100_commits", 100)];

    for &(label, _) in configs {
        let mut state_map: HashMap<String, PathBuf> = HashMap::new();
        state_map.insert(path_str.clone(), bench_repo.path.clone());

        group.bench_with_input(
            BenchmarkId::from_parameter(label),
            &(&bench_repo.path, &path_str, &state_map),
            |b, &(repo_path, path, smap)| {
                b.iter(|| {
                    // 1. Open repository
                    let mut repo = git2::Repository::open(repo_path).unwrap();

                    // 2. Walk commits (populates graph cache in real app)
                    let graph = trunk_lib::git::graph::snapshot(
                        &mut repo,
                        &trunk_lib::git::graph_input::RefVisibility::default(),
                    )
                    .unwrap()
                    .layout;
                    let _ = serde_json::to_string(&trunk_lib::commands::history::GraphResponse {
                        commits: graph.commits[..200.min(graph.commits.len())].to_vec(),
                        max_columns: graph.max_columns,
                    })
                    .unwrap();

                    // 3. List refs (populates sidebar)
                    let refs = trunk_lib::commands::branches::list_refs_inner(path, smap).unwrap();
                    let _ = serde_json::to_string(&refs).unwrap();

                    // 4. Get status (populates staging panel)
                    let status =
                        trunk_lib::commands::staging::get_status_inner(path, smap).unwrap();
                    let _ = serde_json::to_string(&status).unwrap();
                });
            },
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_ipc_get_graph,
    bench_ipc_list_refs,
    bench_ipc_diff_unstaged,
    bench_startup_sequence
);
criterion_main!(benches);
