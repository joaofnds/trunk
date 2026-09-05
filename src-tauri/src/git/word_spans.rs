//! Word-level emphasis for diff hunks.
//!
//! Each delete run and the add run that follows it are diffed as two whole
//! texts (the way git --word-diff, delta, and VS Code do), so an edit that
//! reflows lines still emphasizes only the words that changed.

use crate::git::types::{DiffLine, DiffOrigin, LinePairing, WordSpan};
use similar::{ChangeTag, DiffTag};
use std::time::{Duration, Instant};

/// A run's worth of old or new text may not be word-diffed past these bounds:
/// beyond them the content is a rewrite or generated text, where emphasis is
/// noise and the diff cost is unbounded.
const WORD_DIFF_RUN_BYTES_MAX: usize = 100_000;
const WORD_DIFF_LINE_BYTES_MAX: usize = 500;
/// Past this share of an op's changed lines emphasized, the op reads as
/// rewritten, not edited: plain add/delete coloring says that better than
/// near-total marks. One verdict per op — judging lines one by one left the
/// most-changed lines as the only unmarked ones.
const WORD_DIFF_COVERAGE_MAX: f32 = 0.7;
/// An unemphasized whitespace gap this short between two emphasized spans is
/// visual confetti; bridging it yields fewer, larger spans.
const WORD_DIFF_GAP_BRIDGE_MAX: u32 = 2;

/// The refinement budget one file shares across all its hunks.
///
/// A file whose budget runs out finishes with plain coloring on the remaining runs
/// rather than arriving seconds late: runs bound their own cost per run, so without a
/// shared budget a many-run file stacks them into seconds.
#[must_use]
pub fn word_diff_budget() -> Instant {
    Instant::now() + Duration::from_millis(500)
}

/// What the run-level word diff learned about a hunk: the emphasized spans
/// per line, and how the split view should seat each line (`LinePairing`).
pub struct HunkWordDiff {
    pub spans: Vec<Vec<WordSpan>>,
    pub pairing: Vec<LinePairing>,
}

/// Word-diff all Delete/Add runs within a hunk, spending no refinement time past
/// `deadline`.
///
/// Both result Vecs are parallel to `lines`. Each delete run and the add run that
/// follows it are diffed as two whole texts (the way git --word-diff, delta, and VS
/// Code do), so an edit that reflows lines still emphasizes only the words that
/// changed. The same diff decides the pairing; positional per-line pairing emphasized
/// nearly everything on reflowed prose and seated unrelated lines side by side.
#[must_use]
pub fn compute_word_spans_for_hunk(lines: &[DiffLine], deadline: Instant) -> HunkWordDiff {
    let mut result = HunkWordDiff {
        spans: vec![Vec::new(); lines.len()],
        pairing: vec![LinePairing::Unknown; lines.len()],
    };
    let mut i = 0;

    while i < lines.len() {
        if matches!(lines[i].origin, DiffOrigin::Context) {
            i += 1;
            continue;
        }

        let del_start = i;
        while i < lines.len() && matches!(lines[i].origin, DiffOrigin::Delete) {
            i += 1;
        }
        let add_start = i;
        while i < lines.len() && matches!(lines[i].origin, DiffOrigin::Add) {
            i += 1;
        }

        if del_start == add_start || add_start == i {
            for pairing in &mut result.pairing[del_start..i] {
                *pairing = LinePairing::Alone;
            }
            continue;
        }
        emphasize_run(
            lines,
            del_start..add_start,
            add_start..i,
            deadline,
            &mut result,
        );
    }

    result
}

/// Word-diff one delete run against the add run that follows it and write the
/// emphasized spans for each line the refinement touched.
fn emphasize_run(
    lines: &[DiffLine],
    del: std::ops::Range<usize>,
    add: std::ops::Range<usize>,
    deadline: Instant,
    result: &mut HunkWordDiff,
) {
    let run_lines = || lines[del.clone()].iter().chain(lines[add.clone()].iter());
    let run_bytes: usize = run_lines().map(|l| l.content.len()).sum();
    if deadline <= Instant::now()
        || run_bytes > WORD_DIFF_RUN_BYTES_MAX
        || run_lines().any(|l| l.content.len() > WORD_DIFF_LINE_BYTES_MAX)
    {
        return;
    }

    let old_text: String = lines[del.clone()]
        .iter()
        .map(|l| l.content.as_str())
        .collect();
    let new_text: String = lines[add.clone()]
        .iter()
        .map(|l| l.content.as_str())
        .collect();
    let diff = similar::TextDiffConfig::default()
        .deadline(deadline)
        .diff_lines(old_text.as_str(), new_text.as_str());
    let mut options = similar::InlineChangeOptions::new();
    options.semantic_cleanup(true);

    for op in diff.ops() {
        let mut refined = false;
        let mut op_spans: Vec<(usize, Vec<WordSpan>)> = Vec::new();
        for change in diff.iter_inline_changes_with_options_deadline(op, options, Some(deadline)) {
            let line_idx = match change.tag() {
                ChangeTag::Delete => change.old_index().map(|k| del.start + k),
                ChangeTag::Insert => change.new_index().map(|k| add.start + k),
                ChangeTag::Equal => None,
            };
            let Some(line_idx) = line_idx else { continue };

            let mut spans = Vec::new();
            let mut offset: u32 = 0;
            for (emphasized, segment) in change.values() {
                let len = segment.len() as u32;
                if *emphasized && len > 0 {
                    refined = true;
                    spans.push(WordSpan {
                        start: offset,
                        end: offset + len,
                        emphasized: true,
                    });
                }
                offset += len;
            }

            op_spans.push((line_idx, polish_spans(spans, &lines[line_idx].content)));
        }

        let reads_as_edit = emphasis_coverage(&op_spans, lines) <= WORD_DIFF_COVERAGE_MAX;
        if reads_as_edit {
            for (line_idx, spans) in op_spans {
                result.spans[line_idx] = spans;
            }
        }

        pair_op_lines(
            op,
            refined && reads_as_edit,
            lines,
            &del,
            &add,
            &mut result.pairing,
        );
    }

    // The budget ran out inside this run: whatever verdicts the coarse,
    // deadline-cut refinement produced depend on machine timing, so the run
    // falls back to positional pairing rather than seating lines by them.
    if deadline <= Instant::now() {
        for pairing in &mut result.pairing[del.start..add.end] {
            *pairing = LinePairing::Unknown;
        }
    }
}

/// Seat one op's lines. `Equal` lines are identical across the runs and pair
/// outright. An accepted `Replace` (its refinement produced emphasis and the
/// op reads as an edit, not a rewrite) pairs
/// positionally within the op, but each pair must also pass a direct
/// similarity check of its own two lines — the run-level refinement can
/// vouch for the run while a positional pair inside it shares nothing (its
/// real twin sitting one row further), and an uncertain pairing stays
/// unpaired (the initiative's rule). A refused `Replace` (similar's ratio
/// gate found the sides unrelated) leaves every line alone. The uneven tail
/// of an op is alone; one-sided ops have nothing to pair with.
fn pair_op_lines(
    op: &similar::DiffOp,
    op_accepted: bool,
    lines: &[DiffLine],
    del: &std::ops::Range<usize>,
    add: &std::ops::Range<usize>,
    pairing: &mut [LinePairing],
) {
    let old = op.old_range();
    let new = op.new_range();

    for k in 0..old.len().max(new.len()) {
        let old_idx = (k < old.len()).then(|| del.start + old.start + k);
        let new_idx = (k < new.len()).then(|| add.start + new.start + k);

        let homologous = match (op.tag(), old_idx, new_idx) {
            (DiffTag::Equal, _, _) => true,
            (DiffTag::Replace, Some(o), Some(n)) => {
                op_accepted && lines_similar(&lines[o].content, &lines[n].content)
            }
            _ => false,
        };

        if let Some(o) = old_idx {
            pairing[o] = match (homologous, new_idx) {
                (true, Some(n)) => LinePairing::Partner { line: n as u32 },
                _ => LinePairing::Alone,
            };
        }
        if let Some(n) = new_idx {
            pairing[n] = match (homologous, old_idx) {
                (true, Some(o)) => LinePairing::Partner { line: o as u32 },
                _ => LinePairing::Alone,
            };
        }
    }
}

/// The direct check behind a positional pair: the two lines share at least
/// 40% of the smaller side's word bytes (multiset intersection of their
/// words). Words, not characters — English lines share most of their
/// letters while sharing nothing. Lines with no words on either side
/// (punctuation, braces) pair; a worded line never pairs with a wordless
/// one.
fn lines_similar(old: &str, new: &str) -> bool {
    let old_words = word_multiset(old);
    let new_words = word_multiset(new);
    let old_total: usize = word_bytes(&old_words);
    let new_total: usize = word_bytes(&new_words);

    if old_total == 0 && new_total == 0 {
        return true;
    }
    if old_total == 0 || new_total == 0 {
        return false;
    }

    let shared: usize = old_words
        .iter()
        .filter_map(|(word, count)| {
            let both = (*count).min(*new_words.get(word)?);
            Some(both as usize * word.len())
        })
        .sum();

    shared * 5 >= old_total.min(new_total) * 2
}

fn word_multiset(content: &str) -> std::collections::HashMap<&str, u32> {
    let mut words: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for word in content
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        *words.entry(word).or_insert(0) += 1;
    }
    words
}

fn word_bytes(words: &std::collections::HashMap<&str, u32>) -> usize {
    words
        .iter()
        .map(|(word, count)| word.len() * *count as usize)
        .sum()
}

/// The share of the op's changed lines that its polished spans emphasize.
/// The edit-vs-rewrite verdict compares this once per op, so a run keeps
/// either coherent emphasis on every changed region or plain coloring
/// throughout, never marked lines beside unmarked more-changed ones.
fn emphasis_coverage(op_spans: &[(usize, Vec<WordSpan>)], lines: &[DiffLine]) -> f32 {
    let changed: usize = op_spans
        .iter()
        .map(|(i, _)| lines[*i].content.trim_end_matches(['\n', '\r']).len())
        .sum();
    let emphasized: u32 = op_spans
        .iter()
        .flat_map(|(_, spans)| spans)
        .map(|s| s.end - s.start)
        .sum();

    if changed == 0 {
        return 0.0;
    }
    emphasized as f32 / changed as f32
}

/// Apply the readability rules to one line's emphasized spans: bridge tiny
/// whitespace gaps into fewer larger spans and drop whitespace-only slivers.
fn polish_spans(spans: Vec<WordSpan>, content: &str) -> Vec<WordSpan> {
    let mut merged: Vec<WordSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        match merged.last_mut() {
            Some(last) if bridgeable(last.end, span.start, content) => last.end = span.end,
            _ => merged.push(span),
        }
    }
    merged.retain(|s| !content[s.start as usize..s.end as usize].trim().is_empty());

    merged
}

/// A gap between two emphasized spans is bridged when it is whitespace-only
/// and at most `WORD_DIFF_GAP_BRIDGE_MAX` bytes.
fn bridgeable(gap_start: u32, gap_end: u32, content: &str) -> bool {
    gap_end - gap_start <= WORD_DIFF_GAP_BRIDGE_MAX
        && content[gap_start as usize..gap_end as usize]
            .trim()
            .is_empty()
}

#[cfg(test)]
mod word_span_tests {
    use super::*;

    fn del(content: &str) -> DiffLine {
        DiffLine {
            origin: DiffOrigin::Delete,
            content: content.to_string(),
            old_lineno: Some(1),
            new_lineno: None,
            spans: vec![],
            pairing: LinePairing::Unknown,
        }
    }

    fn add(content: &str) -> DiffLine {
        DiffLine {
            origin: DiffOrigin::Add,
            content: content.to_string(),
            old_lineno: None,
            new_lineno: Some(1),
            spans: vec![],
            pairing: LinePairing::Unknown,
        }
    }

    fn emphasized(line: &DiffLine, spans: &[WordSpan]) -> Vec<String> {
        spans
            .iter()
            .filter(|s| s.emphasized)
            .map(|s| line.content[s.start as usize..s.end as usize].to_string())
            .collect()
    }

    fn all_emphasized(lines: &[DiffLine], spans: &[Vec<WordSpan>]) -> Vec<Vec<String>> {
        lines
            .iter()
            .zip(spans.iter())
            .map(|(l, s)| emphasized(l, s))
            .collect()
    }

    #[test]
    fn emphasizes_only_the_changed_word() {
        let lines = vec![
            del("expect(cat.permissions.length).toBe(64);\n"),
            add("expect(cat.permissions.length).toBe(63);\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        assert_eq!(emphasized(&lines[0], &spans[0]), vec!["64"]);
        assert_eq!(emphasized(&lines[1], &spans[1]), vec!["63"]);
    }

    #[test]
    fn emphasizes_changed_words_on_both_sides() {
        let lines = vec![del("const a = foo(1);\n"), add("const b = foo(2);\n")];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        assert_eq!(emphasized(&lines[0], &spans[0]), vec!["a", "1"]);
        assert_eq!(emphasized(&lines[1], &spans[1]), vec!["b", "2"]);
    }

    // The dotfiles baccec9 repro: deleting one sentence from a hard-wrapped
    // paragraph reflows the two lines after it. Positional per-line pairing
    // emphasized nearly every word of every line; run-level inline diff must
    // emphasize exactly the removed sentence and leave the added side clean.
    #[test]
    fn reflowed_prose_emphasizes_only_the_removed_sentence() {
        let lines = vec![
            del(
                "- On conflict, the more specific rule governs. The repo's own AGENTS.md or CLAUDE.md\n",
            ),
            del(
                "  wins over this skill. A language file wins over this core file. The doctrine holds\n",
            ),
            del(
                "  the reasons at principle level and wins where this skill seems to differ from it.\n",
            ),
            add(
                "- On conflict, the more specific rule governs. A language file wins over this core\n",
            ),
            add(
                "  file. The doctrine holds the reasons at principle level and wins where this skill\n",
            ),
            add("  seems to differ from it.\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        for (i, line) in lines.iter().enumerate().skip(3) {
            assert_eq!(
                emphasized(line, &spans[i]),
                Vec::<String>::new(),
                "add side must carry no emphasis, line {i}"
            );
        }

        let removed: Vec<String> = spans[..3]
            .iter()
            .zip(lines.iter())
            .flat_map(|(s, l)| emphasized(l, s))
            .collect();
        let removed_words: Vec<&str> = removed.iter().flat_map(|t| t.split_whitespace()).collect();
        assert_eq!(
            removed_words.join(" "),
            "The repo's own AGENTS.md or CLAUDE.md wins over this skill.",
            "delete side must emphasize exactly the removed sentence"
        );
    }

    #[test]
    fn whitespace_only_emphasis_does_not_survive() {
        let lines = vec![
            del(
                "- On conflict, the more specific rule governs. The repo's own AGENTS.md or CLAUDE.md\n",
            ),
            del(
                "  wins over this skill. A language file wins over this core file. The doctrine holds\n",
            ),
            del(
                "  the reasons at principle level and wins where this skill seems to differ from it.\n",
            ),
            add(
                "- On conflict, the more specific rule governs. A language file wins over this core\n",
            ),
            add(
                "  file. The doctrine holds the reasons at principle level and wins where this skill\n",
            ),
            add("  seems to differ from it.\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        for (line, line_spans) in lines.iter().zip(spans.iter()) {
            for text in emphasized(line, line_spans) {
                assert!(
                    !text.trim().is_empty(),
                    "whitespace-only emphasized span {text:?} on {:?}",
                    line.content
                );
            }
        }
    }

    // The dotfiles a113532 repro: a bullet whose head and tail survive while
    // the middle grows by two whole lines. A per-line coverage verdict marked
    // the lightly-changed lines and left the fully-added middle unmarked, so
    // the biggest change read as untouched. The edit-vs-rewrite verdict is one
    // per run: a run that reads as an edit emphasizes all its changed regions.
    #[test]
    fn an_edited_run_emphasizes_its_fully_added_middle_lines() {
        let lines = vec![
            del(
                "- **Carried**: our corpus already answers the need. Cite where, and say which side\n",
            ),
            del("  answers it better; when the subject's side does, that difference is a gap\n"),
            del("  observed here, judged under Import.\n"),
            add("- **Carried**: our corpus already answers the need. Cite where, test the\n"),
            add("  citation against the worst case the mechanism guarded (a mechanism guarding\n"),
            add("  drift rather than a case is tested by comparison alone), and say which side\n"),
            add("  answers the need better. A citation that fails its case, and a need the\n"),
            add("  subject answers better, are both gaps observed here, judged under Import.\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        let added = [
            (4, "citation against the worst case the mechanism guarded"),
            (5, "drift rather than a case is tested by comparison alone"),
        ];
        for (i, text) in added {
            let marked = emphasized(&lines[i], &spans[i]).join("");
            assert!(
                marked.contains(text),
                "added middle line {i} must emphasize {text:?}, got {marked:?}"
            );
        }
    }

    #[test]
    fn a_rewrite_dominated_run_drops_its_small_edits_too() {
        let lines = vec![
            del("let total = 1;\n"),
            del("The quick brown fox jumps over the lazy dog near the river bank.\n"),
            add("let total = 2;\n"),
            add("Metrics are flushed every thirty seconds unless the buffer fills.\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        assert_eq!(
            all_emphasized(&lines, &spans),
            vec![Vec::<String>::new(); 4],
            "a run that reads as a rewrite carries plain coloring throughout, not islands of marks"
        );
    }

    #[test]
    fn dense_rewrite_gets_plain_coloring_without_emphasis() {
        let lines = vec![
            del("The quick brown fox jumps over the lazy dog near the river bank today.\n"),
            del("Server configuration lives in a YAML file loaded at startup by the daemon.\n"),
            add("Metrics are flushed every thirty seconds unless the buffer fills up first.\n"),
            add("Retry budgets cap exponential backoff so queues drain before clients give up.\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        assert_eq!(
            all_emphasized(&lines, &spans),
            vec![Vec::<String>::new(); 4],
            "dissimilar lines must show plain add/delete coloring, never scattered emphasis"
        );
    }

    fn pairings(lines: &[DiffLine], deadline: Instant) -> Vec<LinePairing> {
        compute_word_spans_for_hunk(lines, deadline).pairing
    }

    #[test]
    fn reflowed_prose_pairs_each_line_with_its_reflowed_counterpart() {
        let lines = vec![
            del(
                "- On conflict, the more specific rule governs. The repo's own AGENTS.md or CLAUDE.md\n",
            ),
            del(
                "  wins over this skill. A language file wins over this core file. The doctrine holds\n",
            ),
            del(
                "  the reasons at principle level and wins where this skill seems to differ from it.\n",
            ),
            add(
                "- On conflict, the more specific rule governs. A language file wins over this core\n",
            ),
            add(
                "  file. The doctrine holds the reasons at principle level and wins where this skill\n",
            ),
            add("  seems to differ from it.\n"),
        ];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![
                LinePairing::Partner { line: 3 },
                LinePairing::Partner { line: 4 },
                LinePairing::Partner { line: 5 },
                LinePairing::Partner { line: 0 },
                LinePairing::Partner { line: 1 },
                LinePairing::Partner { line: 2 },
            ]
        );
    }

    #[test]
    fn dense_rewrite_lines_stay_alone() {
        let lines = vec![
            del("The quick brown fox jumps over the lazy dog near the river bank today.\n"),
            del("Server configuration lives in a YAML file loaded at startup by the daemon.\n"),
            add("Metrics are flushed every thirty seconds unless the buffer fills up first.\n"),
            add("Retry budgets cap exponential backoff so queues drain before clients give up.\n"),
        ];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![LinePairing::Alone; 4]
        );
    }

    // The op's own refinement produced emphasis and "let total" passes the
    // word-share check, but the rewrite verdict cleared the op: a cleared op
    // stops vouching for positional pairing entirely.
    #[test]
    fn a_rewrite_dominated_run_does_not_vouch_for_its_similar_pair() {
        let lines = vec![
            del("let total = 1;\n"),
            del("The quick brown fox jumps over the lazy dog near the river bank.\n"),
            add("let total = 2;\n"),
            add("Metrics are flushed every thirty seconds unless the buffer fills.\n"),
        ];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![LinePairing::Alone; 4]
        );
    }

    #[test]
    fn an_unrelated_line_inside_an_accepted_replace_stays_alone() {
        let lines = vec![
            del("let total = sum(values);\n"),
            del("zebra quantum harpsichord velvet\n"),
            add("let total = sum(values) + 1;\n"),
            add("mitochondria asphalt trombone glacier\n"),
        ];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![
                LinePairing::Partner { line: 2 },
                LinePairing::Alone,
                LinePairing::Partner { line: 0 },
                LinePairing::Alone,
            ],
            "a pair sharing no words is never seated side by side"
        );
    }

    #[test]
    fn a_line_whose_twin_sits_elsewhere_does_not_pair_with_a_stranger() {
        let lines = vec![
            del("aaa bbb ccc\n"),
            add("xxx yyy zzz\n"),
            add("aaa bbb ccc extra\n"),
        ];

        let pairing = pairings(&lines, word_diff_budget());

        assert_ne!(
            pairing[0],
            LinePairing::Partner { line: 1 },
            "the delete shares no words with the first add and must not be seated beside it"
        );
    }

    #[test]
    fn a_one_sided_run_is_alone() {
        let lines = vec![del("gone\n"), del("also gone\n")];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![LinePairing::Alone; 2]
        );
    }

    #[test]
    fn a_guarded_run_leaves_pairing_unknown() {
        let long = "x".repeat(600) + "\n";
        let lines = vec![del(&long), add(&long.replace('x', "y"))];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![LinePairing::Unknown; 2]
        );
    }

    #[test]
    fn leftover_lines_of_an_uneven_replace_stay_alone() {
        let lines = vec![
            del("let total = sum(values);\n"),
            del("return total;\n"),
            add("let total = sum(values) + 1;\n"),
        ];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![
                LinePairing::Partner { line: 2 },
                LinePairing::Alone,
                LinePairing::Partner { line: 0 },
            ]
        );
    }

    #[test]
    fn a_spent_budget_yields_plain_coloring_instead_of_late_emphasis() {
        let lines = vec![
            del("expect(cat.permissions.length).toBe(64);\n"),
            add("expect(cat.permissions.length).toBe(63);\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, Instant::now()).spans;

        assert_eq!(
            all_emphasized(&lines, &spans),
            vec![Vec::<String>::new(); 2],
            "a file whose refinement budget is spent gets no further emphasis"
        );
    }

    #[test]
    fn unpaired_runs_get_no_emphasis() {
        let lines = vec![del("gone\n"), del("also gone\n")];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;

        assert_eq!(
            all_emphasized(&lines, &spans),
            vec![Vec::<String>::new(); 2]
        );
    }
}
