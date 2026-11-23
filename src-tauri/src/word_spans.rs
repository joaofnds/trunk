//! Word-level emphasis for diff hunks.
//!
//! Each delete run and the add run that follows it are diffed as two whole
//! texts (the way git --word-diff, delta, and VS Code do), so an edit that
//! reflows lines still emphasizes only the words that changed.

use crate::types::{DiffLine, DiffOrigin, LinePairing, WordSpan};
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
///
/// A fraction rather than a float so the comparison is exact integer
/// arithmetic: the counters it weighs are character counts.
const WORD_DIFF_COVERAGE_MAX: (u64, u64) = (7, 10);
/// An unemphasized whitespace gap this short between two emphasized spans is
/// visual confetti; bridging it yields fewer, larger spans.
const WORD_DIFF_GAP_BRIDGE_MAX: u32 = 2;

/// The refinement budget one file shares across all its hunks.
///
/// A file whose budget runs out finishes with plain coloring on the remaining runs
/// rather than arriving seconds late: runs bound their own cost per run, so without a
/// shared budget a many-run file stacks them into seconds.
pub(crate) const WORD_DIFF_BUDGET: Duration = Duration::from_millis(500);

#[must_use]
pub fn word_diff_budget() -> Instant {
    Instant::now() + WORD_DIFF_BUDGET
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
        if matches!(lines[i].origin, DiffOrigin::Context | DiffOrigin::NoNewline) {
            i += 1;
            continue;
        }

        let del_start = i;
        while i < lines.len() && matches!(lines[i].origin, DiffOrigin::Delete) {
            i += 1;
        }
        let del_end = i;
        // The marker annotates the delete above it, so it sits between the two
        // runs of a replacement. Stepping over it keeps the add run attached to
        // its deletes; leaving it in would end the run and strand both sides.
        if del_end > del_start && i < lines.len() && lines[i].origin == DiffOrigin::NoNewline {
            i += 1;
        }
        let add_start = i;
        while i < lines.len() && matches!(lines[i].origin, DiffOrigin::Add) {
            i += 1;
        }

        if del_start == del_end || add_start == i {
            for (offset, pairing) in result.pairing[del_start..i].iter_mut().enumerate() {
                if lines[del_start + offset].origin != DiffOrigin::NoNewline {
                    *pairing = LinePairing::Alone;
                }
            }
            continue;
        }
        emphasize_run(
            lines,
            del_start..del_end,
            add_start..i,
            deadline,
            &mut result,
        );
    }

    result
}

fn run_fits(lengths: impl Iterator<Item = usize>) -> bool {
    let mut bytes = 0;
    for len in lengths {
        if len > WORD_DIFF_LINE_BYTES_MAX || len > WORD_DIFF_RUN_BYTES_MAX - bytes {
            return false;
        }
        bytes += len;
    }
    true
}

/// Refine the two line sequences the merge editor actually displays.
pub(crate) fn for_conflict(
    ours: &[String],
    theirs: &[String],
    deadline: Instant,
) -> Option<HunkWordDiff> {
    if ours.is_empty()
        || theirs.is_empty()
        || deadline <= Instant::now()
        || !run_fits(ours.iter().chain(theirs).map(|line| line.len() + 1))
    {
        return None;
    }
    let old: Vec<_> = ours.iter().map(String::as_str).collect();
    let new: Vec<_> = theirs.iter().map(String::as_str).collect();
    let len = old.len() + new.len();
    let mut result = HunkWordDiff {
        spans: vec![Vec::new(); len],
        pairing: vec![LinePairing::Unknown; len],
    };
    refine_run(&old, &new, (0, old.len()), deadline, &mut result);
    Some(result)
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
    let lengths = lines[del.clone()]
        .iter()
        .chain(&lines[add.clone()])
        .map(|line| line.content.len());
    if deadline <= Instant::now() || !run_fits(lengths) {
        return;
    }

    let old: Vec<_> = lines[del.clone()]
        .iter()
        .map(|line| line.content.as_str())
        .collect();
    let new: Vec<_> = lines[add.clone()]
        .iter()
        .map(|line| line.content.as_str())
        .collect();
    refine_run(&old, &new, (del.start, add.start), deadline, result);
}

fn refine_run(
    old: &[&str],
    new: &[&str],
    starts: (usize, usize),
    deadline: Instant,
    result: &mut HunkWordDiff,
) {
    let diff = similar::TextDiffConfig::default()
        .deadline(deadline)
        .diff_slices(old, new);
    let mut options = similar::InlineChangeOptions::new();
    options.semantic_cleanup(true);

    for op in diff.ops() {
        let mut refined = false;
        let mut op_spans: Vec<(usize, Vec<WordSpan>)> = Vec::new();
        let mut changed_bytes = 0;
        for change in diff.iter_inline_changes_with_options_deadline(op, options, Some(deadline)) {
            let (line_idx, line) = match change.tag() {
                ChangeTag::Delete => {
                    let Some(index) = change.old_index() else {
                        continue;
                    };
                    (starts.0 + index, old[index])
                }
                ChangeTag::Insert => {
                    let Some(index) = change.new_index() else {
                        continue;
                    };
                    (starts.1 + index, new[index])
                }
                ChangeTag::Equal => continue,
            };
            changed_bytes += line.trim_end_matches(['\n', '\r']).len();
            let mut spans = Vec::new();
            let mut offset: u32 = 0;
            for (emphasized, segment) in change.values() {
                let len = u32::try_from(segment.len()).unwrap_or(u32::MAX);
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

            op_spans.push((line_idx, polish_spans(spans, line)));
        }

        let accepted = refined && emphasis_within(&op_spans, changed_bytes);
        if accepted {
            for (index, spans) in op_spans {
                result.spans[index] = spans;
            }
        }
        pair_op_lines(op, accepted, old, new, starts, &mut result.pairing);
    }
    if deadline <= Instant::now() {
        // A deadline-cut verdict depends on machine timing. Use positional rows.
        result.pairing[starts.0..starts.0 + old.len()].fill(LinePairing::Unknown);
        result.pairing[starts.1..starts.1 + new.len()].fill(LinePairing::Unknown);
    }
}

/// Keep homologous lines on one row. An insertion or deletion in a replacement
/// can shift the remaining pairs. On a mismatch consume the surplus side first.
fn pair_op_lines(
    op: &similar::DiffOp,
    accepted: bool,
    old_lines: &[&str],
    new_lines: &[&str],
    starts: (usize, usize),
    pairing: &mut [LinePairing],
) {
    let mut old = op.old_range();
    let mut new = op.new_range();
    pairing[starts.0 + old.start..starts.0 + old.end].fill(LinePairing::Alone);
    pairing[starts.1 + new.start..starts.1 + new.end].fill(LinePairing::Alone);
    if op.tag() != DiffTag::Equal && !accepted {
        return;
    }
    while !old.is_empty() && !new.is_empty() {
        if op.tag() == DiffTag::Equal || lines_similar(old_lines[old.start], new_lines[new.start]) {
            let o = starts.0 + old.start;
            let n = starts.1 + new.start;
            pairing[o] = LinePairing::Partner {
                line: u32::try_from(n).unwrap_or(u32::MAX),
            };
            pairing[n] = LinePairing::Partner {
                line: u32::try_from(o).unwrap_or(u32::MAX),
            };
            old.start += 1;
            new.start += 1;
        } else {
            let order = old.len().cmp(&new.len());
            if !order.is_lt() {
                old.start += 1;
            }
            if !order.is_gt() {
                new.start += 1;
            }
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

/// Whether the op's polished spans emphasize at most `max` of its changed
/// lines, `max` being a fraction.
///
/// The edit-vs-rewrite verdict asks this once per op, so a run keeps either
/// coherent emphasis on every changed region or plain coloring throughout,
/// never marked lines beside unmarked more-changed ones.
fn emphasis_within(op_spans: &[(usize, Vec<WordSpan>)], changed: usize) -> bool {
    let emphasized: u32 = op_spans
        .iter()
        .flat_map(|(_, spans)| spans)
        .map(|s| s.end - s.start)
        .sum();

    if changed == 0 {
        return true;
    }

    // emphasized / changed <= num / den, cross-multiplied so nothing rounds.
    let (num, den) = WORD_DIFF_COVERAGE_MAX;
    u64::from(emphasized) * den <= changed as u64 * num
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

    /// git's "\\ No newline at end of file" marker, which libgit2 hands back as a
    /// line of the hunk between the delete and the add it annotates.
    fn eofnl() -> DiffLine {
        DiffLine {
            origin: DiffOrigin::NoNewline,
            content: "\n\\ No newline at end of file\n".to_string(),
            old_lineno: None,
            new_lineno: None,
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
    fn a_carriage_return_inside_a_line_keeps_the_visible_word_offsets() {
        let lines = [
            del("first\rchange old value\n"),
            add("first\rchange new value\n"),
        ];
        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget()).spans;
        assert_eq!(emphasized(&lines[0], &spans[0]), ["old"]);
        assert_eq!(emphasized(&lines[1], &spans[1]), ["new"]);
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
    fn a_no_newline_marker_does_not_split_the_run_it_sits_in() {
        let lines = vec![
            del("the final line of the file\n"),
            eofnl(),
            add("the final line of the file\n"),
        ];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![
                LinePairing::Partner { line: 2 },
                LinePairing::Unknown,
                LinePairing::Partner { line: 0 },
            ],
            "the marker annotates the delete; it must not end the delete run and strand the add"
        );
    }

    #[test]
    fn a_marker_on_each_side_still_leaves_one_replacement() {
        let lines = vec![
            del("the quick brown fox jumps over the lazy dog"),
            eofnl(),
            add("the quick brown cat jumps over the lazy dog"),
            eofnl(),
        ];

        assert_eq!(
            pairings(&lines, word_diff_budget()),
            vec![
                LinePairing::Partner { line: 2 },
                LinePairing::Unknown,
                LinePairing::Partner { line: 0 },
                LinePairing::Unknown,
            ],
            "a file lacking its final newline on both sides carries two markers, and \
             neither is a line to seat"
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
    fn an_inserted_line_does_not_displace_the_edited_line_it_precedes() {
        let lines = vec![
            del("const shortcut = 'Ctrl+O';\n"),
            add("// local edit\n"),
            add("const shortcut = 'Ctrl+K';\n"),
        ];

        let pairing = pairings(&lines, word_diff_budget());

        assert_eq!(
            pairing,
            [
                LinePairing::Partner { line: 2 },
                LinePairing::Alone,
                LinePairing::Partner { line: 0 }
            ]
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
