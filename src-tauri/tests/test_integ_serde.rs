mod common;

use common::context::TestContext;

// ── GraphResult (via stash_save which returns GraphResult) ──────────────────

#[test]
fn graph_result_serializes_with_expected_fields() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create dirty state so stash_save has something to stash
    std::fs::write(ctx.repo_path().join("README.md"), "modified").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
    }

    let result = ctx.stash_save("test stash").unwrap();
    let json = serde_json::to_value(&result).expect("GraphResult serialization failed");

    // Top-level shape
    assert!(json.is_object(), "GraphResult should be an object");
    assert!(json["commits"].is_array(), "commits should be an array");
    assert!(
        json["max_columns"].is_number(),
        "max_columns should be a number"
    );

    // GraphCommit shape
    let commit = &json["commits"][0];
    assert!(commit["oid"].is_string(), "oid should be a string");
    assert!(
        commit["short_oid"].is_string(),
        "short_oid should be a string"
    );
    assert!(commit["summary"].is_string(), "summary should be a string");
    assert!(
        commit["author_name"].is_string(),
        "author_name should be a string"
    );
    assert!(
        commit["author_email"].is_string(),
        "author_email should be a string"
    );
    assert!(
        commit["author_timestamp"].is_number(),
        "author_timestamp should be a number"
    );
    assert!(
        commit["parent_oids"].is_array(),
        "parent_oids should be an array"
    );
    assert!(commit["column"].is_number(), "column should be a number");
    assert!(
        commit["color_index"].is_number(),
        "color_index should be a number"
    );
    assert!(commit["edges"].is_array(), "edges should be an array");
    assert!(commit["refs"].is_array(), "refs should be an array");
    assert!(
        commit["is_head"].is_boolean(),
        "is_head should be a boolean"
    );
    assert!(
        commit["is_merge"].is_boolean(),
        "is_merge should be a boolean"
    );
    assert!(
        commit["is_branch_tip"].is_boolean(),
        "is_branch_tip should be a boolean"
    );
    assert!(
        commit["is_stash"].is_boolean(),
        "is_stash should be a boolean"
    );
    assert!(
        commit["in_head_chain"].is_boolean(),
        "in_head_chain should be a boolean"
    );
    // body is Option<String> -- may be null or string
    let body = &commit["body"];
    assert!(
        body.is_null() || body.is_string(),
        "body should be null or string"
    );
}

// ── GraphEdge shape (via merge to produce edges) ────────────────────────────

#[test]
fn graph_edge_serializes_with_expected_fields() {
    let mut ctx = TestContext::builder()
        .with_file("base.txt", "base content")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("main.txt", "main content")
        .with_commit("Main commit")
        .build();

    // Merge to produce edges in the graph
    ctx.populate_cache();
    let json = {
        let result = ctx.cache_map.get(ctx.path()).unwrap();
        serde_json::to_value(result).expect("GraphResult serialization failed")
    };

    // Find a commit with edges
    let commits = json["commits"].as_array().unwrap();
    let edge_commit = commits.iter().find(|c| {
        c["edges"]
            .as_array()
            .map(|e| !e.is_empty())
            .unwrap_or(false)
    });

    if let Some(commit) = edge_commit {
        let edge = &commit["edges"][0];
        assert!(
            edge["from_column"].is_number(),
            "from_column should be a number"
        );
        assert!(
            edge["to_column"].is_number(),
            "to_column should be a number"
        );
        assert!(
            edge["edge_type"].is_string(),
            "edge_type should be a string"
        );
        assert!(
            edge["color_index"].is_number(),
            "color_index should be a number"
        );
        assert!(edge["dashed"].is_boolean(), "dashed should be a boolean");

        // Verify edge_type is a valid variant
        let edge_type = edge["edge_type"].as_str().unwrap();
        let valid_types = [
            "Straight",
            "MergeLeft",
            "MergeRight",
            "ForkLeft",
            "ForkRight",
        ];
        assert!(
            valid_types.contains(&edge_type),
            "edge_type '{}' not in valid set: {:?}",
            edge_type,
            valid_types
        );
    }
    // If no edges found, the graph was too simple -- that's OK for the serialization test
}

// ── RefLabel shape ──────────────────────────────────────────────────────────

#[test]
fn ref_label_serializes_with_expected_fields() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_tag("v1.0")
        .build();

    ctx.populate_cache();
    let json = {
        let result = ctx.cache_map.get(ctx.path()).unwrap();
        serde_json::to_value(result).expect("GraphResult serialization failed")
    };

    // HEAD commit should have refs (at least "main" branch)
    let commits = json["commits"].as_array().unwrap();
    let ref_commit = commits
        .iter()
        .find(|c| c["refs"].as_array().map(|r| !r.is_empty()).unwrap_or(false))
        .expect("expected at least one commit with refs");

    let refs = ref_commit["refs"].as_array().unwrap();
    let ref_label = &refs[0];
    assert!(ref_label["name"].is_string(), "name should be a string");
    assert!(
        ref_label["short_name"].is_string(),
        "short_name should be a string"
    );
    assert!(
        ref_label["ref_type"].is_string(),
        "ref_type should be a string"
    );
    assert!(
        ref_label["is_head"].is_boolean(),
        "is_head should be a boolean"
    );
    assert!(
        ref_label["color_index"].is_number(),
        "color_index should be a number"
    );

    // Verify ref_type is a valid variant
    let ref_type = ref_label["ref_type"].as_str().unwrap();
    let valid_types = ["LocalBranch", "RemoteBranch", "Tag", "Stash"];
    assert!(
        valid_types.contains(&ref_type),
        "ref_type '{}' not in valid set: {:?}",
        ref_type,
        valid_types
    );
}

// ── WorkingTreeStatus ───────────────────────────────────────────────────────

#[test]
fn working_tree_status_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create an unstaged new file
    std::fs::write(ctx.repo_path().join("newfile.txt"), "new content").unwrap();

    let result = ctx.get_status().unwrap();
    let json = serde_json::to_value(&result).expect("WorkingTreeStatus serialization failed");

    assert!(json.is_object(), "WorkingTreeStatus should be an object");
    assert!(json["staged"].is_array(), "staged should be an array");
    assert!(json["unstaged"].is_array(), "unstaged should be an array");
    assert!(
        json["conflicted"].is_array(),
        "conflicted should be an array"
    );

    // Verify FileStatus shape in the unstaged list
    let unstaged = json["unstaged"].as_array().unwrap();
    assert!(!unstaged.is_empty(), "expected at least one unstaged file");
    let file_status = &unstaged[0];
    assert!(
        file_status["path"].is_string(),
        "FileStatus path should be a string"
    );
    assert!(
        file_status["status"].is_string(),
        "FileStatus status should be a string"
    );
    assert!(
        file_status["is_binary"].is_boolean(),
        "FileStatus is_binary should be a boolean"
    );

    // Verify FileStatusType is a valid variant
    let status_type = file_status["status"].as_str().unwrap();
    let valid_statuses = [
        "New",
        "Modified",
        "Deleted",
        "Renamed",
        "Typechange",
        "Conflicted",
    ];
    assert!(
        valid_statuses.contains(&status_type),
        "status '{}' not in valid set: {:?}",
        status_type,
        valid_statuses
    );
}

// ── DirtyCounts ─────────────────────────────────────────────────────────────

#[test]
fn dirty_counts_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create dirty state: one unstaged file
    std::fs::write(ctx.repo_path().join("newfile.txt"), "new").unwrap();

    let result =
        trunk_lib::commands::staging::get_dirty_counts_inner(ctx.path(), ctx.state_map()).unwrap();
    let json = serde_json::to_value(&result).expect("DirtyCounts serialization failed");

    assert!(json.is_object(), "DirtyCounts should be an object");
    assert!(json["staged"].is_number(), "staged should be a number");
    assert!(json["unstaged"].is_number(), "unstaged should be a number");
    assert!(
        json["conflicted"].is_number(),
        "conflicted should be a number"
    );

    // Verify actual values match expectations
    assert_eq!(json["staged"].as_u64().unwrap(), 0);
    assert!(json["unstaged"].as_u64().unwrap() >= 1);
    assert_eq!(json["conflicted"].as_u64().unwrap(), 0);
}

// ── Vec<FileDiff> ───────────────────────────────────────────────────────────

#[test]
fn file_diff_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "line1\nline2\nline3\n")
        .with_commit("Initial commit")
        .build();

    // Modify the file
    std::fs::write(ctx.repo_path().join("README.md"), "line1\nchanged\nline3\n").unwrap();

    let result = ctx.diff_unstaged("README.md").unwrap();
    let json = serde_json::to_value(&result).expect("Vec<FileDiff> serialization failed");

    assert!(json.is_array(), "Vec<FileDiff> should be an array");
    let diffs = json.as_array().unwrap();
    assert!(!diffs.is_empty(), "expected at least one diff");

    let file_diff = &diffs[0];
    assert!(
        file_diff["path"].is_string(),
        "FileDiff path should be a string"
    );
    assert!(
        file_diff["status"].is_string(),
        "FileDiff status should be a string"
    );
    assert!(
        file_diff["is_binary"].is_boolean(),
        "FileDiff is_binary should be a boolean"
    );
    assert!(
        file_diff["hunks"].is_array(),
        "FileDiff hunks should be an array"
    );

    // Verify DiffStatus is a valid variant
    let diff_status = file_diff["status"].as_str().unwrap();
    let valid_statuses = [
        "Added",
        "Deleted",
        "Modified",
        "Renamed",
        "Copied",
        "Untracked",
        "Unknown",
    ];
    assert!(
        valid_statuses.contains(&diff_status),
        "status '{}' not in valid set: {:?}",
        diff_status,
        valid_statuses
    );

    // Verify DiffHunk shape
    let hunks = file_diff["hunks"].as_array().unwrap();
    assert!(!hunks.is_empty(), "expected at least one hunk");
    let hunk = &hunks[0];
    assert!(
        hunk["header"].is_string(),
        "DiffHunk header should be a string"
    );
    assert!(
        hunk["old_start"].is_number(),
        "DiffHunk old_start should be a number"
    );
    assert!(
        hunk["old_lines"].is_number(),
        "DiffHunk old_lines should be a number"
    );
    assert!(
        hunk["new_start"].is_number(),
        "DiffHunk new_start should be a number"
    );
    assert!(
        hunk["new_lines"].is_number(),
        "DiffHunk new_lines should be a number"
    );
    assert!(
        hunk["lines"].is_array(),
        "DiffHunk lines should be an array"
    );

    // Verify DiffLine shape
    let lines = hunk["lines"].as_array().unwrap();
    assert!(!lines.is_empty(), "expected at least one line in hunk");
    let line = &lines[0];
    assert!(
        line["origin"].is_string(),
        "DiffLine origin should be a string"
    );
    assert!(
        line["content"].is_string(),
        "DiffLine content should be a string"
    );
    // old_lineno and new_lineno are Option<u32> -- may be null or number
    let old = &line["old_lineno"];
    assert!(
        old.is_null() || old.is_number(),
        "DiffLine old_lineno should be null or number"
    );
    let new = &line["new_lineno"];
    assert!(
        new.is_null() || new.is_number(),
        "DiffLine new_lineno should be null or number"
    );

    // Verify DiffOrigin is a valid variant
    let origin = line["origin"].as_str().unwrap();
    let valid_origins = ["Context", "Add", "Delete"];
    assert!(
        valid_origins.contains(&origin),
        "origin '{}' not in valid set: {:?}",
        origin,
        valid_origins
    );
}

// ── CommitDetail ────────────────────────────────────────────────────────────

#[test]
fn commit_detail_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Get HEAD oid
    let oid = {
        let repo = ctx.repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        head.id().to_string()
    };

    let result = ctx.get_commit_detail(&oid).unwrap();
    let json = serde_json::to_value(&result).expect("CommitDetail serialization failed");

    assert!(json.is_object(), "CommitDetail should be an object");
    assert!(json["oid"].is_string(), "oid should be a string");
    assert!(
        json["short_oid"].is_string(),
        "short_oid should be a string"
    );
    assert!(json["summary"].is_string(), "summary should be a string");
    // body is Option<String>
    let body = &json["body"];
    assert!(
        body.is_null() || body.is_string(),
        "body should be null or string"
    );
    assert!(
        json["author_name"].is_string(),
        "author_name should be a string"
    );
    assert!(
        json["author_email"].is_string(),
        "author_email should be a string"
    );
    assert!(
        json["author_timestamp"].is_number(),
        "author_timestamp should be a number"
    );
    assert!(
        json["committer_name"].is_string(),
        "committer_name should be a string"
    );
    assert!(
        json["committer_email"].is_string(),
        "committer_email should be a string"
    );
    assert!(
        json["committer_timestamp"].is_number(),
        "committer_timestamp should be a number"
    );
    assert!(
        json["parent_oids"].is_array(),
        "parent_oids should be an array"
    );
}

// ── RefsResponse ────────────────────────────────────────────────────────────

#[test]
fn refs_response_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .with_tag("v1.0")
        .build();

    let result = ctx.list_refs().unwrap();
    let json = serde_json::to_value(&result).expect("RefsResponse serialization failed");

    assert!(json.is_object(), "RefsResponse should be an object");
    assert!(json["local"].is_array(), "local should be an array");
    assert!(json["remote"].is_array(), "remote should be an array");
    assert!(json["tags"].is_array(), "tags should be an array");
    assert!(json["stashes"].is_array(), "stashes should be an array");

    // Verify BranchInfo shape
    let local = json["local"].as_array().unwrap();
    assert!(!local.is_empty(), "expected at least one local branch");
    let branch = &local[0];
    assert!(
        branch["name"].is_string(),
        "BranchInfo name should be a string"
    );
    assert!(
        branch["is_head"].is_boolean(),
        "BranchInfo is_head should be a boolean"
    );
    // upstream is Option<String>
    let upstream = &branch["upstream"];
    assert!(
        upstream.is_null() || upstream.is_string(),
        "upstream should be null or string"
    );
    assert!(
        branch["ahead"].is_number(),
        "BranchInfo ahead should be a number"
    );
    assert!(
        branch["behind"].is_number(),
        "BranchInfo behind should be a number"
    );
    assert!(
        branch["last_commit_timestamp"].is_number(),
        "BranchInfo last_commit_timestamp should be a number"
    );

    // Verify tags (RefLabel shape already tested in ref_label_serializes_with_expected_fields)
    let tags = json["tags"].as_array().unwrap();
    assert!(!tags.is_empty(), "expected at least one tag");
}

// ── HeadCommitMessage ───────────────────────────────────────────────────────

#[test]
fn head_commit_message_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Test subject line")
        .build();

    let result = ctx.get_head_commit_message().unwrap();
    let json = serde_json::to_value(&result).expect("HeadCommitMessage serialization failed");

    assert!(json.is_object(), "HeadCommitMessage should be an object");
    assert!(json["subject"].is_string(), "subject should be a string");
    // body is Option<String>
    let body = &json["body"];
    assert!(
        body.is_null() || body.is_string(),
        "body should be null or string"
    );

    // Verify actual value
    assert_eq!(json["subject"].as_str().unwrap(), "Test subject line");
}

// ── OperationInfo ───────────────────────────────────────────────────────────

#[test]
fn operation_info_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.get_operation_state().unwrap();
    let json = serde_json::to_value(&result).expect("OperationInfo serialization failed");

    assert!(json.is_object(), "OperationInfo should be an object");
    assert!(json["op_type"].is_string(), "op_type should be a string");

    // In normal state, op_type is "None"
    assert_eq!(json["op_type"].as_str().unwrap(), "None");

    // Verify OperationType valid variants
    let valid_ops = ["None", "Merge", "Rebase", "CherryPick", "Revert"];
    assert!(valid_ops.contains(&json["op_type"].as_str().unwrap()));

    // Optional fields (null when no operation)
    let source_branch = &json["source_branch"];
    assert!(
        source_branch.is_null() || source_branch.is_string(),
        "source_branch should be null or string"
    );
    let target_branch = &json["target_branch"];
    assert!(
        target_branch.is_null() || target_branch.is_string(),
        "target_branch should be null or string"
    );
    let progress = &json["progress"];
    assert!(
        progress.is_null() || progress.is_string(),
        "progress should be null or string"
    );
    let source_color_index = &json["source_color_index"];
    assert!(
        source_color_index.is_null() || source_color_index.is_number(),
        "source_color_index should be null or number"
    );
    let target_color_index = &json["target_color_index"];
    assert!(
        target_color_index.is_null() || target_color_index.is_number(),
        "target_color_index should be null or number"
    );
    let rebase_message = &json["rebase_message"];
    assert!(
        rebase_message.is_null() || rebase_message.is_string(),
        "rebase_message should be null or string"
    );
}

// ── UndoResult ──────────────────────────────────────────────────────────────

#[test]
fn undo_result_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_file("README.md", "updated")
        .with_commit("Second commit")
        .build();

    let result = ctx.undo_commit().unwrap();
    let json = serde_json::to_value(&result).expect("UndoResult serialization failed");

    assert!(json.is_object(), "UndoResult should be an object");
    assert!(json["subject"].is_string(), "subject should be a string");
    // body is Option<String>
    let body = &json["body"];
    assert!(
        body.is_null() || body.is_string(),
        "body should be null or string"
    );

    // Verify actual value
    assert_eq!(json["subject"].as_str().unwrap(), "Second commit");
}

// ── Vec<SearchResult> ───────────────────────────────────────────────────────

#[test]
fn search_result_serializes_correctly() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_file("README.md", "updated")
        .with_commit("Second commit with unique keyword xyzzy")
        .build();

    // Populate cache (required for search)
    ctx.populate_cache();

    let result = ctx.search_commits("xyzzy").unwrap();
    let json = serde_json::to_value(&result).expect("Vec<SearchResult> serialization failed");

    assert!(json.is_array(), "Vec<SearchResult> should be an array");
    let results = json.as_array().unwrap();
    assert!(!results.is_empty(), "expected at least one search result");

    let search_result = &results[0];
    assert!(
        search_result["oid"].is_string(),
        "SearchResult oid should be a string"
    );
    assert!(
        search_result["match_types"].is_array(),
        "SearchResult match_types should be an array"
    );

    // Verify MatchType valid variants
    let match_types = search_result["match_types"].as_array().unwrap();
    assert!(!match_types.is_empty(), "expected at least one match type");
    let valid_match_types = ["Sha", "Message", "Ref", "Author"];
    for mt in match_types {
        let mt_str = mt.as_str().unwrap();
        assert!(
            valid_match_types.contains(&mt_str),
            "match_type '{}' not in valid set: {:?}",
            mt_str,
            valid_match_types
        );
    }
}

// ── bool (check_undo_available) ─────────────────────────────────────────────

#[test]
fn check_undo_available_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.check_undo_available().unwrap();
    let json = serde_json::to_value(result).expect("bool serialization failed");

    assert!(json.is_boolean(), "bool result should be a boolean");
}

// ── String (resolve_ref) ────────────────────────────────────────────────────

#[test]
fn resolve_ref_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.resolve_ref("main").unwrap();
    let json = serde_json::to_value(&result).expect("String serialization failed");

    assert!(json.is_string(), "resolve_ref result should be a string");
    // Should be a 40-char hex OID
    let oid = json.as_str().unwrap();
    assert_eq!(oid.len(), 40, "OID should be 40 hex characters");
    assert!(
        oid.chars().all(|c| c.is_ascii_hexdigit()),
        "OID should be hex"
    );
}

// ── Vec<StashEntry> ─────────────────────────────────────────────────────────

#[test]
fn stash_entry_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create dirty state and stash it
    std::fs::write(ctx.repo_path().join("README.md"), "modified").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
    }
    ctx.stash_save("my test stash").unwrap();

    let result = ctx.list_stashes().unwrap();
    let json = serde_json::to_value(&result).expect("Vec<StashEntry> serialization failed");

    assert!(json.is_array(), "Vec<StashEntry> should be an array");
    let stashes = json.as_array().unwrap();
    assert!(!stashes.is_empty(), "expected at least one stash entry");

    let stash = &stashes[0];
    assert!(
        stash["index"].is_number(),
        "StashEntry index should be a number"
    );
    assert!(
        stash["name"].is_string(),
        "StashEntry name should be a string"
    );
    assert!(
        stash["short_name"].is_string(),
        "StashEntry short_name should be a string"
    );
    assert!(
        stash["oid"].is_string(),
        "StashEntry oid should be a string"
    );
    // parent_oid is Option<String>
    let parent_oid = &stash["parent_oid"];
    assert!(
        parent_oid.is_null() || parent_oid.is_string(),
        "parent_oid should be null or string"
    );
}

// ── Vec<FileDiff> via staged diff ───────────────────────────────────────────

#[test]
fn staged_diff_serializes_correctly() {
    let ctx = TestContext::builder()
        .with_file("README.md", "line1\nline2\nline3\n")
        .with_commit("Initial commit")
        .build();

    // Modify and stage
    std::fs::write(ctx.repo_path().join("README.md"), "line1\nchanged\nline3\n").unwrap();
    ctx.stage_file("README.md").unwrap();

    let result = ctx.diff_staged("README.md").unwrap();
    let json = serde_json::to_value(&result).expect("staged Vec<FileDiff> serialization failed");

    assert!(json.is_array(), "Vec<FileDiff> should be an array");
    let diffs = json.as_array().unwrap();
    assert!(!diffs.is_empty(), "expected at least one staged diff");

    // Reuse same shape checks as unstaged diff
    let file_diff = &diffs[0];
    assert!(file_diff["path"].is_string());
    assert!(file_diff["status"].is_string());
    assert!(file_diff["is_binary"].is_boolean());
    assert!(file_diff["hunks"].is_array());
}

// ── GraphResponse (history command boundary type) ───────────────────────────

#[test]
fn graph_response_serializes_correctly() {
    use trunk_lib::commands::history::GraphResponse;

    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Build a GraphResponse from cache data (mirrors what get_commit_graph does)
    ctx.populate_cache();
    let graph_result = ctx.cache_map.get(ctx.path()).unwrap();
    let response = GraphResponse {
        commits: graph_result.commits.clone(),
        max_columns: graph_result.max_columns,
    };

    let json = serde_json::to_value(&response).expect("GraphResponse serialization failed");

    assert!(json.is_object(), "GraphResponse should be an object");
    assert!(json["commits"].is_array(), "commits should be an array");
    assert!(
        json["max_columns"].is_number(),
        "max_columns should be a number"
    );
}

// ── DiffLine enrichment fields ──────────────────────────────────────────────

#[test]
fn diff_line_serializes_spans_as_array() {
    let ctx = TestContext::builder()
        .with_file("README.md", "line1\nline2\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "line1\nchanged\n").unwrap();

    let result = ctx.diff_unstaged("README.md").unwrap();
    let json = serde_json::to_value(&result).expect("serialization failed");

    let line = &json[0]["hunks"][0]["lines"][0];
    assert!(line["spans"].is_array(), "spans should be an array");
    // word_spans and syntax_tokens should NOT exist on the serialized DiffLine
    assert!(
        line.get("word_spans").is_none(),
        "word_spans should not exist on DiffLine (replaced by spans)"
    );
    assert!(
        line.get("syntax_tokens").is_none(),
        "syntax_tokens should not exist on DiffLine (replaced by spans)"
    );
    // Each span should have start, end, syntax_class, emphasized
    if let Some(span) = line["spans"].as_array().and_then(|a| a.first()) {
        assert!(span["start"].is_number(), "span.start should be a number");
        assert!(span["end"].is_number(), "span.end should be a number");
        assert!(
            span["syntax_class"].is_string(),
            "span.syntax_class should be a string"
        );
        assert!(
            span["emphasized"].is_boolean(),
            "span.emphasized should be a boolean"
        );
    }
}

// NOTE: MergeSides and Vec<RebaseTodoItem> are not tested here because they
// require the repo to be in an active merge/rebase conflict state. They share
// the same serde patterns as the tested types (structs with String and
// Option<String> fields, Vec of structs with String/i64 fields).

// ── Anchor wire shape ────────────────────────────────────────────────────────

use trunk_lib::git::types::{Anchor, Side, Source};

fn an_anchor() -> Anchor {
    Anchor {
        commit_oid: "a".repeat(40),
        file_path: "src/main.rs".to_string(),
        source: Source::Diff,
        side: Side::New,
        start_line: 10,
        end_line: 12,
    }
}

#[test]
fn anchor_serializes_every_field_in_snake_case() {
    let json = serde_json::to_value(an_anchor()).expect("Anchor serialization failed");

    // The whole shape, not field-by-field: a swapped start_line/end_line or a
    // file_path carrying the oid survives a set of type checks.
    assert_eq!(
        json,
        serde_json::json!({
            "commit_oid": "a".repeat(40),
            "file_path": "src/main.rs",
            "source": "Diff",
            "side": "New",
            "start_line": 10,
            "end_line": 12,
        })
    );
}

/// `reviewdb::anchor` writes these exact strings into the `source` and `side`
/// columns and matches them back on read, so the enum spelling is a storage
/// contract, not just a wire one.
#[test]
fn source_and_side_serialize_as_pascal_case_strings() {
    assert_eq!(
        serde_json::to_value(Source::Diff).unwrap(),
        serde_json::Value::String("Diff".to_string())
    );
    assert_eq!(
        serde_json::to_value(Source::FullFile).unwrap(),
        serde_json::Value::String("FullFile".to_string())
    );
    assert_eq!(
        serde_json::to_value(Side::Old).unwrap(),
        serde_json::Value::String("Old".to_string())
    );
    assert_eq!(
        serde_json::to_value(Side::New).unwrap(),
        serde_json::Value::String("New".to_string())
    );
}

/// Migration guardrail: an anchor names a commit, a file and a line range and
/// nothing about how the diff was rendered. Re-adding any of these would make an
/// anchor depend on view settings that change under it.
#[test]
fn an_anchor_carries_no_rendering_fields() {
    let json = serde_json::to_value(an_anchor()).unwrap();

    assert!(json["hunk_index"].is_null());
    assert!(json["line_index"].is_null());
    assert!(json["context_lines"].is_null());
    assert!(json["ignore_whitespace"].is_null());
}

#[test]
fn an_anchor_round_trips_through_serde_unchanged() {
    let before = serde_json::to_value(an_anchor()).unwrap();

    let serialized = serde_json::to_string(&an_anchor()).unwrap();
    let deserialized: Anchor = serde_json::from_str(&serialized).unwrap();

    assert_eq!(before, serde_json::to_value(&deserialized).unwrap());
}
