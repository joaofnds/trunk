import { describe, it, expect } from 'vitest';
import { buildRefPillData, sortRefs } from './ref-pill-data.js';
import { PILL_HEIGHT, PILL_PADDING_X, PILL_GAP, PILL_MARGIN_LEFT, ICON_WIDTH, LANE_WIDTH, ROW_HEIGHT } from './graph-constants.js';
import type { GraphCommit, OverlayNode, RefLabel } from './types.js';

/** Mock measure: each char = 7px */
const mockMeasure = (text: string, _font: string): number => text.length * 7;

/** cx/cy helpers matching CommitGraph.svelte */
const cx = (col: number) => col * LANE_WIDTH + LANE_WIDTH / 2;
const cy = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

/** Minimal OverlayNode factory */
function makeNode(overrides: Partial<OverlayNode> & { x: number; y: number }): OverlayNode {
  return {
    oid: overrides.oid ?? `oid-${overrides.y}`,
    x: overrides.x,
    y: overrides.y,
    colorIndex: overrides.colorIndex ?? 0,
    isMerge: overrides.isMerge ?? false,
    isBranchTip: overrides.isBranchTip ?? false,
    isStash: overrides.isStash ?? false,
    isWip: overrides.isWip ?? false,
  };
}

/** Minimal GraphCommit factory */
function makeCommit(overrides: Partial<GraphCommit> & { refs?: RefLabel[] }): GraphCommit {
  return {
    oid: overrides.oid ?? 'abc123',
    short_oid: overrides.short_oid ?? 'abc',
    summary: overrides.summary ?? 'test commit',
    body: overrides.body ?? null,
    author_name: overrides.author_name ?? 'Test',
    author_email: overrides.author_email ?? 'test@test.com',
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
  };
}

/** Minimal RefLabel factory */
function makeRef(overrides: Partial<RefLabel> & { short_name: string }): RefLabel {
  return {
    name: overrides.name ?? overrides.short_name,
    short_name: overrides.short_name,
    ref_type: overrides.ref_type ?? 'LocalBranch',
    is_head: overrides.is_head ?? false,
    color_index: overrides.color_index ?? 0,
  };
}

describe('sortRefs', () => {
  it('HEAD branch comes first', () => {
    const refs: RefLabel[] = [
      makeRef({ short_name: 'feature', ref_type: 'LocalBranch' }),
      makeRef({ short_name: 'main', ref_type: 'LocalBranch', is_head: true }),
    ];
    const sorted = sortRefs(refs);
    expect(sorted[0].short_name).toBe('main');
    expect(sorted[0].is_head).toBe(true);
  });

  it('sorts by type: LocalBranch > Tag > Stash > RemoteBranch', () => {
    const refs: RefLabel[] = [
      makeRef({ short_name: 'origin/main', ref_type: 'RemoteBranch' }),
      makeRef({ short_name: 'v1.0', ref_type: 'Tag' }),
      makeRef({ short_name: 'stash@{0}', ref_type: 'Stash' }),
      makeRef({ short_name: 'main', ref_type: 'LocalBranch' }),
    ];
    const sorted = sortRefs(refs);
    expect(sorted.map(r => r.ref_type)).toEqual([
      'LocalBranch',
      'Tag',
      'Stash',
      'RemoteBranch',
    ]);
  });
});

describe('buildRefPillData', () => {
  it('returns empty array for nodes with no refs', () => {
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs: [] })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result).toEqual([]);
  });

  it('skips WIP nodes', () => {
    const nodes = [makeNode({ x: 0, y: 0, isWip: true })];
    const commits = [makeCommit({ refs: [makeRef({ short_name: 'main', is_head: true })] })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result).toEqual([]);
  });

  it('skips stash nodes', () => {
    const nodes = [makeNode({ x: 0, y: 0, isStash: true })];
    const commits = [makeCommit({ refs: [makeRef({ short_name: 'stash@{0}', ref_type: 'Stash' })] })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result).toEqual([]);
  });

  it('single ref produces pill with correct x, y, width, height', () => {
    const ref = makeRef({ short_name: 'main', is_head: true });
    const nodes = [makeNode({ x: 1, y: 0, colorIndex: 2 })];
    const commits = [makeCommit({ refs: [ref], color_index: 2 })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result).toHaveLength(1);

    const pill = result[0];
    expect(pill.x).toBe(PILL_MARGIN_LEFT);
    expect(pill.y).toBe(cy(0));
    expect(pill.height).toBe(PILL_HEIGHT);
    // "main" = 4 chars * 7 = 28px text + PILL_PADDING_X*2 = 40px (no icon for branch)
    expect(pill.width).toBe(28 + PILL_PADDING_X * 2);
  });

  it('HEAD branch pill has isHead=true', () => {
    const ref = makeRef({ short_name: 'main', is_head: true });
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs: [ref] })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result[0].isHead).toBe(true);
    expect(result[0].isNonHead).toBe(false);
  });

  it('overflowCount = refs.length - 1 for commits with multiple refs', () => {
    const refs = [
      makeRef({ short_name: 'main', is_head: true }),
      makeRef({ short_name: 'develop' }),
      makeRef({ short_name: 'v1.0', ref_type: 'Tag' }),
    ];
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result[0].overflowCount).toBe(2);
  });

  it('allRefs contains all sorted refs for hover expansion', () => {
    const refs = [
      makeRef({ short_name: 'origin/main', ref_type: 'RemoteBranch' }),
      makeRef({ short_name: 'main', is_head: true }),
    ];
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    // After sort: main (HEAD) first, origin/main second
    expect(result[0].allRefs[0].short_name).toBe('main');
    expect(result[0].allRefs[1].short_name).toBe('origin/main');
    expect(result[0].allRefs).toHaveLength(2);
  });

  it('isRemoteOnly=true when ref is RemoteBranch AND no sibling LocalBranch or Tag', () => {
    const refs = [makeRef({ short_name: 'origin/feature', ref_type: 'RemoteBranch' })];
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result[0].isRemoteOnly).toBe(true);
  });

  it('isRemoteOnly=false when remote branch has a matching local branch on same commit', () => {
    const refs = [
      makeRef({ short_name: 'main', ref_type: 'LocalBranch' }),
      makeRef({ short_name: 'origin/main', ref_type: 'RemoteBranch' }),
    ];
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    // Primary pill is "main" (LocalBranch, sorted first) — not remote-only
    expect(result[0].isRemoteOnly).toBe(false);
  });

  it('isNonHead=true for all non-HEAD pills', () => {
    const refs = [makeRef({ short_name: 'feature' })];
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result[0].isNonHead).toBe(true);
    expect(result[0].isHead).toBe(false);
  });

  it('connector coordinates: dotCx = cx(node.x), dotCy = cy(node.y), commitColorIndex = node.colorIndex', () => {
    const ref = makeRef({ short_name: 'main', is_head: true });
    const nodes = [makeNode({ x: 2, y: 3, colorIndex: 5 })];
    const commits = [
      makeCommit({}), makeCommit({}), makeCommit({}), // filler
      makeCommit({ refs: [ref], color_index: 5 }),
    ];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    expect(result[0].dotCx).toBe(cx(2));
    expect(result[0].dotCy).toBe(cy(3));
    expect(result[0].commitColorIndex).toBe(5);
  });

  it('text truncation applied when label exceeds available width', () => {
    // refColumnWidth = 30, "longbranchname" = 14 chars * 7 = 98px — too wide
    const ref = makeRef({ short_name: 'longbranchname', is_head: true });
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs: [ref] })];
    const result = buildRefPillData(nodes, commits, 30, mockMeasure);
    expect(result[0].truncatedLabel).toContain('…');
    expect(result[0].truncatedLabel).not.toBe('longbranchname');
  });

  it('pill width = textWidth + PILL_PADDING_X*2 for branches (no icon)', () => {
    const ref = makeRef({ short_name: 'dev', is_head: true });
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs: [ref] })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    // "dev" = 3*7 = 21px text
    expect(result[0].width).toBe(21 + PILL_PADDING_X * 2);
  });

  it('pill width includes ICON_WIDTH for Tag refs', () => {
    const ref = makeRef({ short_name: 'v1.0', ref_type: 'Tag' });
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs: [ref] })];
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    // "v1.0" = 4*7 = 28px text + ICON_WIDTH + PILL_PADDING_X*2
    expect(result[0].width).toBe(28 + ICON_WIDTH + PILL_PADDING_X * 2);
  });

  it('pill width includes ICON_WIDTH for Stash refs', () => {
    const ref = makeRef({ short_name: 'stash@{0}', ref_type: 'Stash' });
    const nodes = [makeNode({ x: 0, y: 0 })];
    const commits = [makeCommit({ refs: [ref] })];
    // Note: stash nodes are skipped (isStash=true), but a non-stash node
    // might have a stash-type ref in edge cases
    const result = buildRefPillData(nodes, commits, 200, mockMeasure);
    // "stash@{0}" = 9*7 = 63px text + ICON_WIDTH + PILL_PADDING_X*2
    expect(result[0].width).toBe(63 + ICON_WIDTH + PILL_PADDING_X * 2);
  });
});
