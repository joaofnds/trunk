mod common;

use common::context::TestContext;
use trunk_lib::git::types::DiffRequestOptions;

// -- diff_unstaged tests --

#[test]
fn modified_tracked_file_produces_unstaged_hunks() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(
        ctx.repo_path().join("README.md"),
        "modified content for diff",
    )
    .unwrap();

    let file_diffs = ctx
        .diff_unstaged("README.md")
        .expect("diff_unstaged failed");
    assert!(!file_diffs.is_empty(), "expected non-empty file_diffs");

    let fd = &file_diffs[0];
    assert!(!fd.is_binary, "expected is_binary == false");
    assert!(!fd.hunks.is_empty(), "expected non-empty hunks");
}

#[test]
fn clean_file_produces_empty_unstaged_diff() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let file_diffs = ctx
        .diff_unstaged("README.md")
        .expect("diff_unstaged failed");
    assert!(
        file_diffs.is_empty(),
        "expected empty file_diffs for clean file"
    );
}

#[test]
fn untracked_file_shows_content_in_unstaged_diff() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(
        ctx.repo_path().join("new_file.txt"),
        "line1\nline2\nline3\n",
    )
    .unwrap();

    let file_diffs = ctx
        .diff_unstaged("new_file.txt")
        .expect("diff_unstaged failed");
    assert!(
        !file_diffs.is_empty(),
        "expected non-empty file_diffs for untracked file"
    );

    let fd = &file_diffs[0];
    assert_eq!(fd.path, "new_file.txt");
    assert!(
        !fd.hunks.is_empty(),
        "expected hunks with content for untracked file"
    );
    assert!(
        !fd.hunks[0].lines.is_empty(),
        "expected lines in hunk for untracked file"
    );
}

#[test]
fn untracked_file_in_subdirectory_shows_in_unstaged_diff() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::create_dir_all(ctx.repo_path().join("docs")).unwrap();
    std::fs::write(ctx.repo_path().join("docs/notes.md"), "hello\nworld\n").unwrap();

    let file_diffs = ctx
        .diff_unstaged("docs/notes.md")
        .expect("diff_unstaged failed");
    assert!(
        !file_diffs.is_empty(),
        "expected non-empty file_diffs for untracked file in subdir"
    );

    let fd = &file_diffs[0];
    assert_eq!(fd.path, "docs/notes.md");
    assert!(!fd.hunks.is_empty(), "expected hunks with content");
    assert!(!fd.hunks[0].lines.is_empty(), "expected lines in hunk");
}

// -- diff_staged tests --

#[test]
fn staged_modification_produces_staged_hunks() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "staged content for diff").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
    }

    let file_diffs = ctx.diff_staged("README.md").expect("diff_staged failed");
    assert!(!file_diffs.is_empty(), "expected non-empty file_diffs");

    let fd = &file_diffs[0];
    assert!(!fd.hunks.is_empty(), "expected non-empty hunks");
}

#[test]
fn staged_file_on_unborn_head_produces_diff() {
    let ctx = TestContext::new_empty();

    std::fs::write(ctx.repo_path().join("new_file.txt"), "brand new content").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new("new_file.txt"))
            .unwrap();
        index.write().unwrap();
    }

    let file_diffs = ctx.diff_staged("new_file.txt").expect("diff_staged failed");
    assert!(
        !file_diffs.is_empty(),
        "expected non-empty file_diffs for unborn HEAD staged file"
    );
}

// -- diff_commit tests --

#[test]
fn diff_commit_succeeds_for_head() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_file("README.md", "modified")
        .with_commit("Second commit")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    let result = ctx.diff_commit(&head_oid);
    assert!(result.is_ok(), "expected Ok, got: {:?}", result);
}

#[test]
fn diff_commit_root_commit_shows_added_files() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Walk to find root commit (parent_count == 0)
    let repo = ctx.repo();
    let mut revwalk = repo.revwalk().unwrap();
    revwalk.push_head().unwrap();
    let root_oid = revwalk
        .filter_map(|id| id.ok())
        .find(|&id| {
            repo.find_commit(id)
                .map(|c| c.parent_count() == 0)
                .unwrap_or(false)
        })
        .expect("no root commit found");
    let root_oid_str = root_oid.to_string();
    drop(repo);

    let file_diffs = ctx.diff_commit(&root_oid_str).expect("diff_commit failed");
    assert!(
        !file_diffs.is_empty(),
        "expected non-empty file_diffs for root commit"
    );
}

// -- get_commit_detail tests --

#[test]
fn commit_detail_returns_metadata() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    let detail = ctx
        .get_commit_detail(&head_oid)
        .expect("get_commit_detail failed");
    assert_eq!(detail.oid.len(), 40, "expected 40-char oid");
    assert_eq!(detail.short_oid.len(), 7, "expected 7-char short_oid");
    assert!(!detail.summary.is_empty(), "expected non-empty summary");
    assert!(
        !detail.author_name.is_empty(),
        "expected non-empty author_name"
    );
}

#[test]
fn commit_detail_includes_committer_fields() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    let detail = ctx
        .get_commit_detail(&head_oid)
        .expect("get_commit_detail failed");
    assert!(
        !detail.committer_name.is_empty(),
        "expected non-empty committer_name"
    );
    assert!(
        !detail.committer_email.is_empty(),
        "expected non-empty committer_email"
    );
    assert!(
        detail.committer_timestamp > 0,
        "expected committer_timestamp > 0"
    );
}

// -- DiffRequestOptions tests --

#[test]
fn diff_unstaged_respects_context_lines() {
    let content: String = (1..=20).map(|i| format!("line {}\n", i)).collect();
    let ctx = TestContext::builder()
        .with_file("big.txt", &content)
        .with_commit("Initial commit")
        .build();

    let modified: String = (1..=20)
        .map(|i| {
            if i == 10 {
                "changed line 10\n".to_string()
            } else {
                format!("line {}\n", i)
            }
        })
        .collect();
    std::fs::write(ctx.repo_path().join("big.txt"), &modified).unwrap();

    let opts_1 = DiffRequestOptions {
        context_lines: 1,
        ..Default::default()
    };
    let result_1 = ctx.diff_unstaged_with_options("big.txt", &opts_1).unwrap();
    let lines_1: usize = result_1[0].hunks.iter().map(|h| h.lines.len()).sum();

    let opts_5 = DiffRequestOptions {
        context_lines: 5,
        ..Default::default()
    };
    let result_5 = ctx.diff_unstaged_with_options("big.txt", &opts_5).unwrap();
    let lines_5: usize = result_5[0].hunks.iter().map(|h| h.lines.len()).sum();

    assert!(
        lines_5 > lines_1,
        "context_lines=5 should produce more lines than context_lines=1: got {} vs {}",
        lines_5,
        lines_1
    );
}

#[test]
fn diff_unstaged_ignores_whitespace_when_enabled() {
    let ctx = TestContext::builder()
        .with_file("ws.txt", "hello world\n")
        .with_commit("Initial commit")
        .build();

    // Only change whitespace (add extra spaces)
    std::fs::write(ctx.repo_path().join("ws.txt"), "hello  world  \n").unwrap();

    // Without whitespace ignore -- should show changes
    let opts_normal = DiffRequestOptions::default();
    let result_normal = ctx
        .diff_unstaged_with_options("ws.txt", &opts_normal)
        .unwrap();
    assert!(
        !result_normal.is_empty(),
        "expected diff without whitespace ignore"
    );
    let has_changes = result_normal[0].hunks.iter().any(|h| !h.lines.is_empty());
    assert!(has_changes, "expected changes in normal diff");

    // With whitespace ignore -- should show no meaningful changes
    let opts_ignore = DiffRequestOptions {
        ignore_whitespace: true,
        ..Default::default()
    };
    let result_ignore = ctx
        .diff_unstaged_with_options("ws.txt", &opts_ignore)
        .unwrap();
    // When ignoring whitespace changes, git2 produces empty hunks or no hunks
    let ignore_lines: usize = result_ignore
        .iter()
        .flat_map(|fd| fd.hunks.iter())
        .flat_map(|h| h.lines.iter())
        .filter(|l| {
            matches!(
                l.origin,
                trunk_lib::git::types::DiffOrigin::Add | trunk_lib::git::types::DiffOrigin::Delete
            )
        })
        .count();
    assert_eq!(
        ignore_lines, 0,
        "expected no add/delete lines when ignoring whitespace"
    );
}

#[test]
fn diff_unstaged_ignores_indentation_whitespace() {
    // Create a file with unindented content
    let ctx = TestContext::builder()
        .with_file("indent.rs", "fn main() {\nreturn 0;\n}\n")
        .with_commit("Initial commit")
        .build();

    // Modify to indent the body (add 4-space indentation)
    std::fs::write(
        ctx.repo_path().join("indent.rs"),
        "fn main() {\n    return 0;\n}\n",
    )
    .unwrap();

    // With ignore_whitespace: true -- indentation-only change should be invisible
    let opts_ignore = DiffRequestOptions {
        ignore_whitespace: true,
        ..Default::default()
    };
    let result_ignore = ctx
        .diff_unstaged_with_options("indent.rs", &opts_ignore)
        .unwrap();
    let ignore_add_del: usize = result_ignore
        .iter()
        .flat_map(|fd| fd.hunks.iter())
        .flat_map(|h| h.lines.iter())
        .filter(|l| {
            matches!(
                l.origin,
                trunk_lib::git::types::DiffOrigin::Add | trunk_lib::git::types::DiffOrigin::Delete
            )
        })
        .count();
    assert_eq!(
        ignore_add_del, 0,
        "expected no add/delete lines when ignoring indentation-only whitespace change, got {}",
        ignore_add_del
    );

    // Without ignore_whitespace (default) -- indentation change should be visible
    let opts_normal = DiffRequestOptions::default();
    let result_normal = ctx
        .diff_unstaged_with_options("indent.rs", &opts_normal)
        .unwrap();
    let normal_add_del: usize = result_normal
        .iter()
        .flat_map(|fd| fd.hunks.iter())
        .flat_map(|h| h.lines.iter())
        .filter(|l| {
            matches!(
                l.origin,
                trunk_lib::git::types::DiffOrigin::Add | trunk_lib::git::types::DiffOrigin::Delete
            )
        })
        .count();
    assert!(
        normal_add_del > 0,
        "expected add/delete lines in normal diff for indentation change, got 0"
    );
}

#[test]
fn diff_unstaged_show_full_file_returns_all_lines() {
    let content: String = (1..=50).map(|i| format!("line {}\n", i)).collect();
    let ctx = TestContext::builder()
        .with_file("full.txt", &content)
        .with_commit("Initial commit")
        .build();

    let modified: String = (1..=50)
        .map(|i| {
            if i == 25 {
                "changed line 25\n".to_string()
            } else {
                format!("line {}\n", i)
            }
        })
        .collect();
    std::fs::write(ctx.repo_path().join("full.txt"), &modified).unwrap();

    let opts = DiffRequestOptions {
        show_full_file: true,
        ..Default::default()
    };
    let result = ctx.diff_unstaged_with_options("full.txt", &opts).unwrap();
    let total_lines: usize = result[0].hunks.iter().map(|h| h.lines.len()).sum();

    // Full file should have at least 50 lines (50 original context + 1 delete + 1 add = ~52)
    assert!(
        total_lines >= 50,
        "show_full_file should return all lines, got {}",
        total_lines
    );
}

#[test]
fn word_span_basic_pair() {
    let ctx = TestContext::builder()
        .with_file("greet.txt", "hello world\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("greet.txt"), "hello mars\n").unwrap();

    let file_diffs = ctx
        .diff_unstaged_enriched("greet.txt")
        .expect("diff failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    // Find Delete and Add lines
    let del_line = hunk
        .lines
        .iter()
        .find(|l| matches!(l.origin, trunk_lib::git::types::DiffOrigin::Delete))
        .expect("expected a Delete line");
    let add_line = hunk
        .lines
        .iter()
        .find(|l| matches!(l.origin, trunk_lib::git::types::DiffOrigin::Add))
        .expect("expected an Add line");

    // Both should have non-empty spans (merged spans always cover content)
    assert!(
        !del_line.spans.is_empty(),
        "Delete line should have non-empty spans"
    );
    assert!(
        !add_line.spans.is_empty(),
        "Add line should have non-empty spans"
    );

    // At least one span on the Delete line should be emphasized (covering "world")
    assert!(
        del_line.spans.iter().any(|s| s.emphasized),
        "Delete line should have at least one emphasized span"
    );
    // At least one span on the Add line should be emphasized (covering "mars")
    assert!(
        add_line.spans.iter().any(|s| s.emphasized),
        "Add line should have at least one emphasized span"
    );

    // Verify the emphasized span on Delete covers "world" in content "hello world\n"
    let del_emph = del_line
        .spans
        .iter()
        .find(|s| s.emphasized)
        .expect("no emphasized span on Delete");
    let del_text = &del_line.content[del_emph.start as usize..del_emph.end as usize];
    assert!(
        del_text.contains("world"),
        "Delete emphasized span should cover 'world', got '{}'",
        del_text
    );

    // Verify the emphasized span on Add covers "mars" in content "hello mars\n"
    let add_emph = add_line
        .spans
        .iter()
        .find(|s| s.emphasized)
        .expect("no emphasized span on Add");
    let add_text = &add_line.content[add_emph.start as usize..add_emph.end as usize];
    assert!(
        add_text.contains("mars"),
        "Add emphasized span should cover 'mars', got '{}'",
        add_text
    );
}

#[test]
fn word_span_unpaired_add_has_no_emphasis() {
    let ctx = TestContext::builder()
        .with_file("lines.txt", "line1\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("lines.txt"), "line1\nline2\nline3\n").unwrap();

    let file_diffs = ctx
        .diff_unstaged_enriched("lines.txt")
        .expect("diff failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    // This should be pure Add lines (no Deletes since "line1" is unchanged).
    // All Add lines should have spans but none emphasized (no Delete to pair with).
    let add_lines: Vec<_> = hunk
        .lines
        .iter()
        .filter(|l| matches!(l.origin, trunk_lib::git::types::DiffOrigin::Add))
        .collect();
    assert!(!add_lines.is_empty(), "expected Add lines");

    for add_line in &add_lines {
        assert!(
            !add_line.spans.iter().any(|s| s.emphasized),
            "Unpaired Add line '{}' should have no emphasized spans",
            add_line.content.trim()
        );
    }
}

#[test]
fn word_span_long_line_skipped() {
    // Create a 600+ character line
    let long_line = "a".repeat(600) + "\n";
    let ctx = TestContext::builder()
        .with_file("long.txt", &long_line)
        .with_commit("Initial commit")
        .build();

    let modified = "b".repeat(600) + "\n";
    std::fs::write(ctx.repo_path().join("long.txt"), &modified).unwrap();

    let file_diffs = ctx.diff_unstaged_enriched("long.txt").expect("diff failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    // Both Delete and Add lines should have spans but none emphasized (line > 500 chars)
    for line in &hunk.lines {
        if matches!(
            line.origin,
            trunk_lib::git::types::DiffOrigin::Delete | trunk_lib::git::types::DiffOrigin::Add
        ) {
            assert!(
                !line.spans.iter().any(|s| s.emphasized),
                "Line over 500 chars should have no emphasized spans, origin={:?}, len={}",
                line.origin,
                line.content.len()
            );
        }
    }
}

#[test]
fn word_span_dissimilar_skipped() {
    let ctx = TestContext::builder()
        .with_file("dissimilar.txt", "aaa bbb ccc\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("dissimilar.txt"), "xxx yyy zzz\n").unwrap();

    let file_diffs = ctx
        .diff_unstaged_enriched("dissimilar.txt")
        .expect("diff failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    // Completely different content -- ratio < 0.4, so no emphasis
    for line in &hunk.lines {
        if matches!(
            line.origin,
            trunk_lib::git::types::DiffOrigin::Delete | trunk_lib::git::types::DiffOrigin::Add
        ) {
            assert!(
                !line.spans.iter().any(|s| s.emphasized),
                "Dissimilar lines should have no emphasized spans, origin={:?}",
                line.origin
            );
        }
    }
}

#[test]
fn word_span_context_lines_have_no_emphasis() {
    let content: String = (1..=10).map(|i| format!("line {}\n", i)).collect();
    let ctx = TestContext::builder()
        .with_file("ctx.txt", &content)
        .with_commit("Initial commit")
        .build();

    let modified: String = (1..=10)
        .map(|i| {
            if i == 5 {
                "changed line 5\n".to_string()
            } else {
                format!("line {}\n", i)
            }
        })
        .collect();
    std::fs::write(ctx.repo_path().join("ctx.txt"), &modified).unwrap();

    let file_diffs = ctx.diff_unstaged_enriched("ctx.txt").expect("diff failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    let context_lines: Vec<_> = hunk
        .lines
        .iter()
        .filter(|l| matches!(l.origin, trunk_lib::git::types::DiffOrigin::Context))
        .collect();
    assert!(!context_lines.is_empty(), "expected Context lines");

    for ctx_line in &context_lines {
        assert!(
            !ctx_line.spans.iter().any(|s| s.emphasized),
            "Context line '{}' should have no emphasized spans",
            ctx_line.content.trim()
        );
    }
}

#[test]
fn word_span_covers_entire_content() {
    let ctx = TestContext::builder()
        .with_file("cover.txt", "hello world\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("cover.txt"), "hello mars\n").unwrap();

    let file_diffs = ctx
        .diff_unstaged_enriched("cover.txt")
        .expect("diff failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    // All non-empty lines should have spans covering the entire content
    for line in &hunk.lines {
        if line.content.is_empty() {
            continue;
        }
        assert!(
            !line.spans.is_empty(),
            "Non-empty content should have spans"
        );
        assert_eq!(line.spans[0].start, 0, "First span should start at 0");
        let last_span = line.spans.last().unwrap();
        assert_eq!(
            last_span.end as usize,
            line.content.len(),
            "Last span end ({}) should equal content byte length ({}) for line '{}'",
            last_span.end,
            line.content.len(),
            line.content.trim()
        );
        // No gaps between spans
        for w in line.spans.windows(2) {
            assert_eq!(
                w[0].end, w[1].start,
                "Spans should be contiguous: span end {} != next start {}",
                w[0].end, w[1].start
            );
        }
    }
}

// -- Syntax highlighting tests --

#[test]
fn syntax_tokens_populated_for_rust_file() {
    let rust_content = "fn main() {\n    let x = 42;\n}\n";
    let ctx = TestContext::builder()
        .with_file("main.rs", rust_content)
        .with_commit("Initial commit")
        .build();

    // Modify to create a diff
    std::fs::write(
        ctx.repo_path().join("main.rs"),
        "fn main() {\n    let x = 99;\n}\n",
    )
    .unwrap();

    let file_diffs = ctx.diff_unstaged_enriched("main.rs").expect("diff failed");
    assert!(!file_diffs.is_empty());
    let hunk = &file_diffs[0].hunks[0];

    // At least some spans should have non-empty syntax_class for .rs files
    let has_syntax = hunk
        .lines
        .iter()
        .any(|line| line.spans.iter().any(|s| !s.syntax_class.is_empty()));
    assert!(has_syntax, "Rust file should have syntax-highlighted spans");
}

#[test]
fn syntax_extension_detection_unknown_ext_no_syntax() {
    let ctx = TestContext::builder()
        .with_file("data.xyz123", "some content\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("data.xyz123"), "different content\n").unwrap();

    let file_diffs = ctx
        .diff_unstaged_enriched("data.xyz123")
        .expect("diff failed");
    assert!(!file_diffs.is_empty());
    let hunk = &file_diffs[0].hunks[0];

    // Unknown extension: spans should exist (covering content) but all with empty syntax_class
    for line in &hunk.lines {
        for span in &line.spans {
            assert!(
                span.syntax_class.is_empty(),
                "Unknown extension should have empty syntax_class, got '{}'",
                span.syntax_class
            );
        }
    }
}

#[test]
fn merged_spans_cover_entire_content() {
    let ctx = TestContext::builder()
        .with_file("test.rs", "let x = 1;\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("test.rs"), "let y = 2;\n").unwrap();

    let file_diffs = ctx.diff_unstaged_enriched("test.rs").expect("diff failed");
    assert!(!file_diffs.is_empty());

    for hunk in &file_diffs[0].hunks {
        for line in &hunk.lines {
            if line.content.is_empty() {
                continue;
            }
            assert!(
                !line.spans.is_empty(),
                "Non-empty content should have spans"
            );
            // First span starts at 0
            assert_eq!(line.spans[0].start, 0, "First span should start at 0");
            // Last span ends at content.len()
            let last = line.spans.last().unwrap();
            assert_eq!(
                last.end as usize,
                line.content.len(),
                "Last span end ({}) should equal content len ({})",
                last.end,
                line.content.len()
            );
            // No gaps between spans
            for w in line.spans.windows(2) {
                assert_eq!(
                    w[0].end, w[1].start,
                    "Spans should be contiguous: span end {} != next start {}",
                    w[0].end, w[1].start
                );
            }
        }
    }
}

#[test]
fn syntax_and_word_diff_coexist() {
    let ctx = TestContext::builder()
        .with_file("combo.rs", "let x = 1;\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("combo.rs"), "let x = 99;\n").unwrap();

    let file_diffs = ctx.diff_unstaged_enriched("combo.rs").expect("diff failed");
    assert!(!file_diffs.is_empty());
    let hunk = &file_diffs[0].hunks[0];

    // Find Add or Delete lines that should have both syntax highlighting and word emphasis
    let modified_lines: Vec<_> = hunk
        .lines
        .iter()
        .filter(|l| {
            matches!(
                l.origin,
                trunk_lib::git::types::DiffOrigin::Add | trunk_lib::git::types::DiffOrigin::Delete
            )
        })
        .collect();
    assert!(!modified_lines.is_empty());

    for line in &modified_lines {
        // Should have some spans with syntax_class (syntax highlighting)
        let has_syntax = line.spans.iter().any(|s| !s.syntax_class.is_empty());
        assert!(has_syntax, "Modified .rs line should have syntax spans");

        // Should have some spans with emphasized=true (word diff)
        let has_emphasis = line.spans.iter().any(|s| s.emphasized);
        assert!(
            has_emphasis,
            "Modified line should have emphasized spans from word diff"
        );
    }
}

#[test]
fn diff_commit_respects_context_lines() {
    let content: String = (1..=20).map(|i| format!("line {}\n", i)).collect();
    let modified: String = (1..=20)
        .map(|i| {
            if i == 10 {
                "changed line 10\n".to_string()
            } else {
                format!("line {}\n", i)
            }
        })
        .collect();

    let ctx = TestContext::builder()
        .with_file("big.txt", &content)
        .with_commit("Initial commit")
        .with_file("big.txt", &modified)
        .with_commit("Modify line 10")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    let opts_1 = DiffRequestOptions {
        context_lines: 1,
        ..Default::default()
    };
    let result_1 = ctx.diff_commit_with_options(&head_oid, &opts_1).unwrap();
    let lines_1: usize = result_1[0].hunks.iter().map(|h| h.lines.len()).sum();

    let opts_5 = DiffRequestOptions {
        context_lines: 5,
        ..Default::default()
    };
    let result_5 = ctx.diff_commit_with_options(&head_oid, &opts_5).unwrap();
    let lines_5: usize = result_5[0].hunks.iter().map(|h| h.lines.len()).sum();

    assert!(
        lines_5 > lines_1,
        "context_lines=5 should produce more lines than context_lines=1 for commit diff: got {} vs {}",
        lines_5,
        lines_1
    );
}

// F1 end-to-end: the default 3-line context window puts the hunk's first
// (context) line on the closing `";` of a string that opened one line
// earlier, off-screen. A fresh per-hunk highlighter (the diagnosed defect)
// misreads that line as top-level code and flips into "inside a string" for
// everything after; seeded from the real file content it resolves correctly.
#[test]
fn commit_diff_highlights_a_hunk_starting_mid_string_from_real_file_content() {
    let before = concat!(
        "fn build_sql() -> String {\n", // 1
        "    let a = 1;\n",             // 2
        "    let sql = \"SELECT *\n",   // 3 - string opens
        "FROM t WHERE x = 1\";\n",      // 4 - string closes
        "    let mut stmt = sql;\n",    // 5
        "    let unused = 0;\n",        // 6
        "    stmt\n",                   // 7 - edited below
        "}\n",                          // 8
    );
    let after = before.replace("    stmt\n", "    stmt.clone()\n");

    let ctx = TestContext::builder()
        .with_file("sql.rs", before)
        .with_commit("Initial commit")
        .with_file("sql.rs", &after)
        .with_commit("Use stmt.clone()")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    let file_diffs = ctx.diff_commit(&head_oid).expect("diff_commit failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    let first_line = &hunk.lines[0];
    assert_eq!(
        first_line.content.trim_end(),
        "FROM t WHERE x = 1\";",
        "hunk should start on the string's closing line, got {:?}",
        first_line.content
    );
    assert!(
        first_line
            .spans
            .iter()
            .any(|s| s.syntax_class == "syn-string"),
        "hunk's first (context) line, inside the real string, should carry syn-string, got {:?}",
        first_line.spans
    );

    let let_line = hunk
        .lines
        .iter()
        .find(|l| l.content.contains("let mut stmt"))
        .expect("expected the 'let mut stmt' line in the hunk");
    assert!(
        let_line
            .spans
            .iter()
            .any(|s| s.syntax_class == "syn-keyword"),
        "line after the string closes should carry syn-keyword, got {:?}",
        let_line.spans
    );
}

// Same F1 scenario as above, but unstaged: the new side is workdir-backed
// (diff_index_to_workdir), so this exercises the disk-read path in
// resolve_side_content rather than an ODB blob read.
#[test]
fn unstaged_diff_highlights_a_hunk_starting_mid_string_via_workdir_read() {
    let before = concat!(
        "fn build_sql() -> String {\n",
        "    let a = 1;\n",
        "    let sql = \"SELECT *\n",
        "FROM t WHERE x = 1\";\n",
        "    let mut stmt = sql;\n",
        "    let unused = 0;\n",
        "    stmt\n",
        "}\n",
    );
    let after = before.replace("    stmt\n", "    stmt.clone()\n");

    let ctx = TestContext::builder()
        .with_file("sql.rs", before)
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("sql.rs"), &after).unwrap();

    let file_diffs = ctx.diff_unstaged("sql.rs").expect("diff_unstaged failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    let first_line = &hunk.lines[0];
    assert_eq!(
        first_line.content.trim_end(),
        "FROM t WHERE x = 1\";",
        "hunk should start on the string's closing line, got {:?}",
        first_line.content
    );
    assert!(
        first_line
            .spans
            .iter()
            .any(|s| s.syntax_class == "syn-string"),
        "hunk's first (context) line, inside the real string, should carry syn-string, got {:?}",
        first_line.spans
    );

    let let_line = hunk
        .lines
        .iter()
        .find(|l| l.content.contains("let mut stmt"))
        .expect("expected the 'let mut stmt' line in the hunk");
    assert!(
        let_line
            .spans
            .iter()
            .any(|s| s.syntax_class == "syn-keyword"),
        "line after the string closes should carry syn-keyword, got {:?}",
        let_line.spans
    );
}

// An untracked file has no old side (Delta::Untracked's old oid is zero) and
// a workdir-backed new side. Its Add lines should still highlight as real
// Rust code, proving the untracked path resolves new content from disk
// rather than skipping it because the OID looks like "no content".
#[test]
fn unstaged_diff_highlights_an_untracked_rust_file_with_no_old_side() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(
        ctx.repo_path().join("new_mod.rs"),
        "fn helper() -> i32 {\n    let x = 1;\n    x\n}\n",
    )
    .unwrap();

    let file_diffs = ctx
        .diff_unstaged("new_mod.rs")
        .expect("diff_unstaged failed");
    assert!(!file_diffs.is_empty(), "expected file diffs");
    let hunk = &file_diffs[0].hunks[0];

    assert!(
        hunk.lines
            .iter()
            .all(|l| !matches!(l.origin, trunk_lib::git::types::DiffOrigin::Delete)),
        "an untracked file's diff should have no Delete lines"
    );

    let let_line = hunk
        .lines
        .iter()
        .find(|l| l.content.contains("let x"))
        .expect("expected the 'let x' line in the hunk");
    assert!(
        let_line
            .spans
            .iter()
            .any(|s| s.syntax_class == "syn-keyword"),
        "untracked Add line should highlight as real code, got {:?}",
        let_line.spans
    );
}

// -- Token cache tests --

#[test]
fn a_second_view_of_a_modified_tracked_file_parses_nothing() {
    let ctx = TestContext::builder()
        .with_file("main.rs", "fn main() {\n    let x = 1;\n}\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(
        ctx.repo_path().join("main.rs"),
        "fn main() {\n    let x = 2;\n}\n",
    )
    .unwrap();

    let first = ctx.diff_unstaged("main.rs").expect("first diff failed");
    let parses_after_first = ctx.token_cache().parse_count();
    let second = ctx.diff_unstaged("main.rs").expect("second diff failed");

    assert_eq!(first, second, "cache-hit output must equal the cold parse");
    assert_eq!(
        ctx.token_cache().parse_count(),
        parses_after_first,
        "a second view of an already-seen diff must do no syntax parsing"
    );
}

#[test]
fn a_second_view_of_an_untracked_file_parses_nothing() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(
        ctx.repo_path().join("new_mod.rs"),
        "fn helper() -> i32 {\n    let x = 1;\n    x\n}\n",
    )
    .unwrap();

    let first = ctx.diff_unstaged("new_mod.rs").expect("first diff failed");
    let parses_after_first = ctx.token_cache().parse_count();
    let second = ctx.diff_unstaged("new_mod.rs").expect("second diff failed");

    assert_eq!(first, second, "cache-hit output must equal the cold parse");
    assert_eq!(
        ctx.token_cache().parse_count(),
        parses_after_first,
        "a second view of an already-seen diff must do no syntax parsing"
    );
}

#[test]
fn touching_mtime_without_changing_bytes_still_hits_the_cache() {
    let ctx = TestContext::builder()
        .with_file("main.rs", "fn main() {\n    let x = 1;\n}\n")
        .with_commit("Initial commit")
        .build();

    let path = ctx.repo_path().join("main.rs");
    std::fs::write(&path, "fn main() {\n    let x = 2;\n}\n").unwrap();
    ctx.diff_unstaged("main.rs").expect("first diff failed");
    let parses_after_first = ctx.token_cache().parse_count();

    // Rewrite the exact same bytes: the mtime changes, the content OID does not.
    let content = std::fs::read(&path).unwrap();
    std::fs::write(&path, &content).unwrap();

    ctx.diff_unstaged("main.rs").expect("second diff failed");
    assert_eq!(
        ctx.token_cache().parse_count(),
        parses_after_first,
        "an mtime-only change must still hit the cache, since the content OID is unchanged"
    );
}

// -- warm_diff tests --

#[test]
fn diff_commit_file_and_a_cold_baseline_agree_and_the_second_request_hits_the_cache() {
    let ctx = TestContext::builder()
        .with_file("main.rs", "fn main() {\n    let x = 1;\n}\n")
        .with_commit("Initial commit")
        .with_file("main.rs", "fn main() {\n    let x = 2;\n}\n")
        .with_commit("Second commit")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    // The warm path: the exact function `warm_diff` calls, its result kept here
    // only to compare against a cold baseline.
    let warmed = ctx
        .diff_commit_file(&head_oid, "main.rs")
        .expect("warm diff failed");
    let parses_after_warm = ctx.token_cache().parse_count();

    let cold_cache = trunk_lib::git::token_cache::SyntaxTokenCache::new(
        trunk_lib::git::token_cache::DEFAULT_TOKEN_CACHE_BUDGET_BYTES,
    );
    let cold_baseline = trunk_lib::commands::diff::diff_commit_file_inner(
        ctx.path(),
        &head_oid,
        "main.rs",
        ctx.state_map(),
        &DiffRequestOptions::default(),
        &cold_cache,
    )
    .expect("cold diff failed");
    assert_eq!(
        warmed, cold_baseline,
        "warming must produce the same output a cold parse would"
    );

    let second = ctx
        .diff_commit_file(&head_oid, "main.rs")
        .expect("second diff failed");
    assert_eq!(warmed, second);
    assert_eq!(
        ctx.token_cache().parse_count(),
        parses_after_warm,
        "a request for a file warm_diff already populated must hit the cache"
    );
}

#[test]
fn diff_commit_file_error_carries_the_code_and_message_shape_warm_diff_relies_on() {
    let ctx = TestContext::new_empty();
    let bogus_oid = "0".repeat(40);

    let err = ctx
        .diff_commit_file(&bogus_oid, "missing.rs")
        .expect_err("expected an error for a nonexistent oid");

    let json = err.to_json();
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("error must parse as JSON");
    assert!(
        parsed.get("code").and_then(|v| v.as_str()).is_some(),
        "error JSON must carry a string code, got {json}"
    );
    assert!(
        parsed.get("message").and_then(|v| v.as_str()).is_some(),
        "error JSON must carry a string message, got {json}"
    );
}

// -- list_commit_files size hint tests --

#[test]
fn list_commit_files_reports_the_modified_files_new_byte_size() {
    let new_content = "fn main() {\n    let x = 2;\n}\n";
    let ctx = TestContext::builder()
        .with_file("main.rs", "fn main() {\n    let x = 1;\n}\n")
        .with_commit("Initial commit")
        .with_file("main.rs", new_content)
        .with_commit("Second commit")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    let files = ctx
        .list_commit_files(&head_oid)
        .expect("list_commit_files failed");
    let fd = files
        .iter()
        .find(|f| f.path == "main.rs")
        .expect("expected main.rs in the file list");

    assert_eq!(
        fd.size_bytes,
        Some(new_content.len() as u64),
        "size_bytes must match the new side's real byte length"
    );
}

#[test]
fn diff_commit_file_never_reports_a_size_hint() {
    let ctx = TestContext::builder()
        .with_file("main.rs", "fn main() {\n    let x = 1;\n}\n")
        .with_commit("Initial commit")
        .with_file("main.rs", "fn main() {\n    let x = 2;\n}\n")
        .with_commit("Second commit")
        .build();

    let repo = ctx.repo();
    let head_oid = repo.head().unwrap().target().unwrap().to_string();
    drop(repo);

    let files = ctx
        .diff_commit_file(&head_oid, "main.rs")
        .expect("diff_commit_file failed");
    assert_eq!(
        files[0].size_bytes, None,
        "a path that already resolved real content has no need for the size hint"
    );
}
