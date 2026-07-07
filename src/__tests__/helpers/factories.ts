import type { FileStatus, GraphCommit, GraphEdge, RefLabel } from "$lib/types";

export function makeCommit(
	overrides: Partial<GraphCommit> & { oid: string },
): GraphCommit {
	return {
		oid: overrides.oid,
		short_oid: overrides.oid.slice(0, 7),
		summary: overrides.summary ?? "test commit",
		body: overrides.body ?? null,
		author_name: overrides.author_name ?? "Test",
		author_email: overrides.author_email ?? "test@test.com",
		author_timestamp: overrides.author_timestamp ?? 0,
		parent_oids: overrides.parent_oids ?? [],
		column: overrides.column ?? 0,
		color_index: overrides.color_index ?? 0,
		edges: overrides.edges ?? [],
		refs: overrides.refs ?? [],
		is_head: overrides.is_head ?? false,
		is_merge: overrides.is_merge ?? false,
		is_branch_tip: overrides.is_branch_tip ?? false,
		is_stash: overrides.is_stash ?? false,
		in_head_chain: overrides.in_head_chain ?? false,
	};
}

export function makeEdge(
	overrides: Partial<GraphEdge> & { edge_type: GraphEdge["edge_type"] },
): GraphEdge {
	return {
		from_column: overrides.from_column ?? 0,
		to_column: overrides.to_column ?? 0,
		edge_type: overrides.edge_type,
		color_index: overrides.color_index ?? 0,
		dashed: overrides.dashed ?? false,
	};
}

export function makeFile(
	path: string,
	status: FileStatus["status"] = "Modified",
): FileStatus {
	return { path, status, is_binary: false };
}

export function makeRef(
	overrides: Partial<RefLabel> & { short_name: string },
): RefLabel {
	return {
		name: overrides.name ?? `refs/heads/${overrides.short_name}`,
		short_name: overrides.short_name,
		ref_type: overrides.ref_type ?? "LocalBranch",
		is_head: overrides.is_head ?? false,
		color_index: overrides.color_index ?? 0,
	};
}
