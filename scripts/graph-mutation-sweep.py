#!/usr/bin/env python3
"""Hand-applied mutation coverage for the commit-graph placement pipeline.

Each row below is an exact string replacement in `placement.rs` or `graph.rs`, asserted to
match its file exactly once. `--check` verifies only that — no build, no test run — and is
what `just check` runs: an anchor that stops matching means a measured site was reworded,
re-indented, deleted or moved, and the recorded verdict for it no longer describes the code.

`--run` applies each mutation in turn, builds, runs the four graph suites, restores from a
pristine copy taken before the sweep, and prints the verdict table on stdout. Progress goes
to stderr, so the stdout table can be diffed against the committed ledger.

Never edit `placement.rs` or `graph.rs` to kill a mutant. A survivor is closed by a fixture,
a named-rule test, or a documented equivalence — see `.claude/rules/commit-graph.md`.
"""

import argparse
import datetime
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
P, G = "placement.rs", "graph.rs"
SOURCES = {
    P: ROOT / "src-tauri" / "src" / "git" / "placement.rs",
    G: ROOT / "src-tauri" / "src" / "git" / "graph.rs",
}

# The measured ceiling is 82s (grill §3.5, mean ~24s). A timeout that fires on an honest
# cycle writes a false `killed` into the ledger, so this sits far above it.
DEFAULT_TIMEOUT = 600

# Appendix A of `.boris/plans/2026-08-05-commit-graph-snapshot-testing-5-grilled.md`, in row
# order. Indentation is part of the anchor; where indentation still collides, the anchor
# carries the following line.
MUTATIONS = [
    (1, P, "find_free_column_near",
     "let right = target + delta;",
     "let right = target * delta;"),
    (2, P, "find_free_column_near",
     "if delta <= target {",
     "if delta > target {"),
    (3, P, "find_free_column_near",
     "let left = target - delta;",
     "let left = target + delta;"),
    (4, P, "find_free_column_near",
     "let left = target - delta;",
     "let left = target / delta;"),
    (5, P, "find_free_column_near",
     "if left >= min_col && active_lanes[left].is_none() {",
     "if left < min_col && active_lanes[left].is_none() {"),
    (6, P, "find_free_column_near",
     "if left >= min_col && active_lanes[left].is_none() {",
     "if left >= min_col || active_lanes[left].is_none() {"),
    (7, G, "capture",
     "git2::Sort::TOPOLOGICAL | git2::Sort::TIME",
     "git2::Sort::TOPOLOGICAL ^ git2::Sort::TIME"),
    (8, P, "assign_lanes/head-ext colour",
     "lane_colors.insert(0, next_color);\n            next_color += 1;",
     "lane_colors.insert(0, next_color);\n            next_color -= 1;"),
    (9, P, "assign_lanes/head-ext colour",
     "lane_colors.insert(0, next_color);\n            next_color += 1;",
     "lane_colors.insert(0, next_color);\n            next_color *= 1;"),
    (10, P, "assign_lanes/is_merge",
     "let is_merge = !is_stash && commit_parents.len() >= 2;",
     "let is_merge = !is_stash || commit_parents.len() >= 2;"),
    (11, P, "can_inline clause 4",
     "|p| !head_chain.contains(&p) || input.head_tip == Some(p)",
     "|p| head_chain.contains(&p) || input.head_tip == Some(p)"),
    (12, P, "inline branch guard",
     "                if c >= active_lanes.len() {",
     "                if c < active_lanes.len() {"),
    (13, P, "inline branch resize",
     "active_lanes.resize(c + 1, None);",
     "active_lanes.resize(c - 1, None);"),
    (14, P, "inline branch resize",
     "active_lanes.resize(c + 1, None);",
     "active_lanes.resize(c * 1, None);"),
    (15, P, "post-phase-1 resize",
     "        if col >= active_lanes.len() {\n            active_lanes.resize(col + 1, None);\n        }",
     "        if col >= active_lanes.len() {\n            active_lanes.resize(col - 1, None);\n        }"),
    (16, P, "post-phase-1 resize",
     "        if col >= active_lanes.len() {\n            active_lanes.resize(col + 1, None);\n        }",
     "        if col >= active_lanes.len() {\n            active_lanes.resize(col * 1, None);\n        }"),
    (17, P, "is_branch_tip",
     "is_root_commit || col >= active_lanes.len() || active_lanes[col].is_none();",
     "is_root_commit && col >= active_lanes.len() || active_lanes[col].is_none();"),
    (18, P, "fork-out ladder",
     "let edge_type = if other_col < col {",
     "let edge_type = if other_col == col {"),
    (19, P, "fork-out ladder",
     "let edge_type = if other_col < col {",
     "let edge_type = if other_col <= col {"),
    (20, P, "first-parent same-column",
     "if existing_col == col {",
     "if existing_col != col {"),
    (21, P, "unclaimed-parent guard",
     "                    if col >= active_lanes.len() {",
     "                    if col < active_lanes.len() {"),
    (22, P, "unclaimed-parent resize",
     "                        active_lanes.resize(col + 1, None);",
     "                        active_lanes.resize(col - 1, None);"),
    (23, P, "unclaimed-parent resize",
     "                        active_lanes.resize(col + 1, None);",
     "                        active_lanes.resize(col * 1, None);"),
    (24, P, "secondary-parent min_col",
     "                    let min_col = if !head_chain.is_empty() { 1 } else { 0 };",
     "                    let min_col = if head_chain.is_empty() { 1 } else { 0 };"),
    (25, P, "secondary-parent colour",
     "                    lane_colors.insert(c, next_color);\n                    next_color += 1;",
     "                    lane_colors.insert(c, next_color);\n                    next_color *= 1;"),
    (26, P, "merge ladder",
     "                    if parent_col < col {",
     "                    if parent_col == col {"),
    (27, P, "merge ladder",
     "                    if parent_col < col {",
     "                    if parent_col > col {"),
    (28, P, "merge ladder",
     "                    if parent_col < col {",
     "                    if parent_col <= col {"),
    (29, P, "merge ladder",
     "                    } else if parent_col > col {",
     "                    } else if parent_col >= col {"),
    (30, P, "non-merge ladder",
     "                } else if parent_col < col {",
     "                } else if parent_col == col {"),
    (31, P, "non-merge ladder",
     "                } else if parent_col < col {",
     "                } else if parent_col > col {"),
    (32, P, "non-merge ladder",
     "                } else if parent_col < col {",
     "                } else if parent_col <= col {"),
    (33, P, "non-merge ladder",
     "} else if parent_col > col {\n                    EdgeType::ForkRight",
     "} else if parent_col == col {\n                    EdgeType::ForkRight"),
    (34, P, "non-merge ladder",
     "} else if parent_col > col {\n                    EdgeType::ForkRight",
     "} else if parent_col < col {\n                    EdgeType::ForkRight"),
    (35, P, "non-merge ladder",
     "} else if parent_col > col {\n                    EdgeType::ForkRight",
     "} else if parent_col >= col {\n                    EdgeType::ForkRight"),
    (36, P, "root lane cleanup",
     "if parents.is_empty() && !col_reoccupied {",
     "if parents.is_empty() || !col_reoccupied {"),
    (37, P, "root lane cleanup",
     "if parents.is_empty() && !col_reoccupied {",
     "if parents.is_empty() && col_reoccupied {"),
]

# The four graph suites, under the env scrub `just` applies. Never `just check`: ~24s against
# ~4 minutes, and no other suite asserts a placement.
TEST_CMD = [
    "env", "-u", "GIT_EDITOR", "-u", "EDITOR", "-u", "VISUAL", "GIT_CONFIG_GLOBAL=/dev/null",
    "cargo", "test", "--quiet", "--no-fail-fast",
    "--manifest-path", str(ROOT / "src-tauri" / "Cargo.toml"),
    "--test", "test_graph",
    "--test", "test_graph_goldens",
    "--test", "test_placement",
    "--test", "test_graph_input",
]


def anchor_failures():
    """Every anchor that does not match its file exactly once."""
    bad = []
    for row, name, symbol, old, _new in MUTATIONS:
        count = SOURCES[name].read_text().count(old)
        if count != 1:
            bad.append(f"row {row} ({name} {symbol}): {count} matches for {old!r}")
    return bad


def mutated_sources_are_dirty():
    """Whether git reports a modification to either file the sweep rewrites.

    Scoped to those two files, not the whole tree: verifying a new test means running
    `--only` with the test present and again with it absent, and both states dirty
    `test_placement.rs`. The guard exists to stop a stale mutation compounding, and only
    these two files can carry one.
    """
    paths = [str(p.relative_to(ROOT)) for p in SOURCES.values()]
    result = subprocess.run(
        ["git", "status", "--porcelain", "--"] + paths,
        capture_output=True, text=True, cwd=ROOT, check=True,
    )
    return result.stdout.strip()


def restore(pristine):
    """Put both sources back from the copies taken before the first mutation."""
    for name, path in SOURCES.items():
        shutil.copy(pristine[name], path)


def cycle(row, name, symbol, old, new, pristine, timeout):
    """Apply one mutation to pristine source, run the suites, restore, return the verdict."""
    source = pristine[name].read_text()
    assert source.count(old) == 1, f"row {row}: anchor no longer unique in the pristine copy"
    SOURCES[name].write_text(source.replace(old, new, 1))

    started = time.time()
    try:
        result = subprocess.run(
            TEST_CMD, capture_output=True, text=True, cwd=ROOT, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        restore(pristine)
        return "killed (timeout)", time.time() - started

    restore(pristine)
    blob = result.stdout + result.stderr
    if "error[" in blob or "could not compile" in blob:
        verdict = "UNVIABLE"
    elif result.returncode == 0:
        verdict = "SURVIVES"
    else:
        verdict = "killed"
    return verdict, time.time() - started


def cell(text):
    """Markdown-table-safe rendering of an anchor: pipes escaped, newlines as `⏎`."""
    return text.replace("|", r"\|").replace("\n", "⏎")


def sweep(rows, timeout):
    if bad := mutated_sources_are_dirty():
        print("refusing to start: the sweep rewrites these files and git reports them modified",
              file=sys.stderr)
        print(bad, file=sys.stderr)
        return 1

    selected = [m for m in MUTATIONS if m[0] in rows]
    today = datetime.date.today().isoformat()

    with tempfile.TemporaryDirectory(prefix="graph-mutation-sweep.") as tmp:
        pristine = {name: pathlib.Path(tmp) / name for name in SOURCES}
        for name, path in SOURCES.items():
            shutil.copy(path, pristine[name])
        restore(pristine)

        table = ["| # | File | Symbol | Mutation | Verdict | Date |",
                 "|---|---|---|---|---|---|"]
        for index, (row, name, symbol, old, new) in enumerate(selected, 1):
            verdict, elapsed = cycle(row, name, symbol, old, new, pristine, timeout)
            print(f"{index}/{len(selected)}\trow {row}\t{verdict}\t{elapsed:.0f}s",
                  file=sys.stderr, flush=True)
            table.append(
                f"| {row} | {name} | {symbol} | `{cell(old)}` → `{cell(new)}` "
                f"| {verdict} | {today} |"
            )

    print("\n".join(table))
    return 0


def parse_rows(spec):
    rows = set()
    for part in spec.split(","):
        part = part.strip()
        if not part.isdigit() or not 1 <= int(part) <= len(MUTATIONS):
            raise SystemExit(f"--only takes Appendix A row numbers 1-{len(MUTATIONS)}, got {part!r}")
        rows.add(int(part))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true",
                       help="verify every anchor matches exactly once, then exit")
    group.add_argument("--run", action="store_true", help="sweep all 37 rows")
    group.add_argument("--only", metavar="N[,N…]", help="sweep the given Appendix A rows")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help=f"seconds per test run before the verdict is killed (timeout) "
                             f"(default: {DEFAULT_TIMEOUT})")
    args = parser.parse_args()

    if bad := anchor_failures():
        print("ANCHOR FAILURES:", file=sys.stderr)
        for line in bad:
            print(" ", line, file=sys.stderr)
        return 1
    print(f"all {len(MUTATIONS)} anchors match exactly once", file=sys.stderr)

    if args.check:
        return 0
    rows = parse_rows(args.only) if args.only else {m[0] for m in MUTATIONS}
    return sweep(rows, args.timeout)


if __name__ == "__main__":
    sys.exit(main())
