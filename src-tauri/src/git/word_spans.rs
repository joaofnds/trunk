//! Word-level emphasis for diff hunks.
//!
//! Each delete run and the add run that follows it are diffed as two whole
//! texts (the way git --word-diff, delta, and VS Code do), so an edit that
//! reflows lines still emphasizes only the words that changed.

use crate::git::types::{DiffLine, DiffOrigin, WordSpan};
use similar::ChangeTag;
use std::time::{Duration, Instant};

/// A run's worth of old or new text may not be word-diffed past these bounds:
/// beyond them the content is a rewrite or generated text, where emphasis is
/// noise and the diff cost is unbounded.
const WORD_DIFF_RUN_BYTES_MAX: usize = 100_000;
const WORD_DIFF_LINE_BYTES_MAX: usize = 500;
/// Past this share of a line emphasized, the line reads as rewritten, not
/// edited: plain add/delete coloring says that better than near-total marks.
const WORD_DIFF_COVERAGE_MAX: f32 = 0.7;
/// An unemphasized whitespace gap this short between two emphasized spans is
/// visual confetti; bridging it yields fewer, larger spans.
const WORD_DIFF_GAP_BRIDGE_MAX: u32 = 2;

/// The refinement budget one file shares across all its hunks. A file whose
/// budget runs out finishes with plain coloring on the remaining runs rather
/// than arriving seconds late: runs bound their own cost per run, so without
/// a shared budget a many-run file stacks them into seconds.
pub fn word_diff_budget() -> Instant {
    Instant::now() + Duration::from_millis(500)
}

/// Compute word spans for all Delete/Add lines within a hunk, spending no
/// refinement time past `deadline`.
/// Returns a Vec parallel to `lines`, each entry being the word_spans for that
/// line index. Each delete run and the add run that follows it are diffed as
/// two whole texts (the way git --word-diff, delta, and VS Code do), so an
/// edit that reflows lines still emphasizes only the words that changed.
/// Positional per-line pairing emphasized nearly everything on reflowed prose.
pub fn compute_word_spans_for_hunk(lines: &[DiffLine], deadline: Instant) -> Vec<Vec<WordSpan>> {
    let mut word_spans: Vec<Vec<WordSpan>> = vec![Vec::new(); lines.len()];
    let mut i = 0;

    while i < lines.len() {
        if !matches!(lines[i].origin, DiffOrigin::Delete) {
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

        if i == add_start {
            continue;
        }
        emphasize_run(
            lines,
            del_start..add_start,
            add_start..i,
            deadline,
            &mut word_spans,
        );
    }

    word_spans
}

/// Word-diff one delete run against the add run that follows it and write the
/// emphasized spans for each line the refinement touched.
fn emphasize_run(
    lines: &[DiffLine],
    del: std::ops::Range<usize>,
    add: std::ops::Range<usize>,
    deadline: Instant,
    word_spans: &mut [Vec<WordSpan>],
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
                    spans.push(WordSpan {
                        start: offset,
                        end: offset + len,
                        emphasized: true,
                    });
                }
                offset += len;
            }

            word_spans[line_idx] = polish_spans(spans, &lines[line_idx].content);
        }
    }
}

/// Apply the readability rules to one line's emphasized spans: bridge tiny
/// whitespace gaps into fewer larger spans, drop whitespace-only slivers, and
/// drop everything when emphasis covers so much of the line that plain
/// coloring reads better.
fn polish_spans(spans: Vec<WordSpan>, content: &str) -> Vec<WordSpan> {
    let mut merged: Vec<WordSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        match merged.last_mut() {
            Some(last) if bridgeable(last.end, span.start, content) => last.end = span.end,
            _ => merged.push(span),
        }
    }
    merged.retain(|s| !content[s.start as usize..s.end as usize].trim().is_empty());

    let line_len = content.trim_end_matches(['\n', '\r']).len() as f32;
    let emphasized_len: u32 = merged.iter().map(|s| s.end - s.start).sum();
    if line_len > 0.0 && emphasized_len as f32 / line_len > WORD_DIFF_COVERAGE_MAX {
        return Vec::new();
    }

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
        }
    }

    fn add(content: &str) -> DiffLine {
        DiffLine {
            origin: DiffOrigin::Add,
            content: content.to_string(),
            old_lineno: None,
            new_lineno: Some(1),
            spans: vec![],
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

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget());

        assert_eq!(emphasized(&lines[0], &spans[0]), vec!["64"]);
        assert_eq!(emphasized(&lines[1], &spans[1]), vec!["63"]);
    }

    #[test]
    fn emphasizes_changed_words_on_both_sides() {
        let lines = vec![del("const a = foo(1);\n"), add("const b = foo(2);\n")];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget());

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

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget());

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

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget());

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

    #[test]
    fn dense_rewrite_gets_plain_coloring_without_emphasis() {
        let lines = vec![
            del("The quick brown fox jumps over the lazy dog near the river bank today.\n"),
            del("Server configuration lives in a YAML file loaded at startup by the daemon.\n"),
            add("Metrics are flushed every thirty seconds unless the buffer fills up first.\n"),
            add("Retry budgets cap exponential backoff so queues drain before clients give up.\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget());

        assert_eq!(
            all_emphasized(&lines, &spans),
            vec![Vec::<String>::new(); 4],
            "dissimilar lines must show plain add/delete coloring, never scattered emphasis"
        );
    }

    #[test]
    fn a_spent_budget_yields_plain_coloring_instead_of_late_emphasis() {
        let lines = vec![
            del("expect(cat.permissions.length).toBe(64);\n"),
            add("expect(cat.permissions.length).toBe(63);\n"),
        ];

        let spans = compute_word_spans_for_hunk(&lines, Instant::now());

        assert_eq!(
            all_emphasized(&lines, &spans),
            vec![Vec::<String>::new(); 2],
            "a file whose refinement budget is spent gets no further emphasis"
        );
    }

    #[test]
    fn unpaired_runs_get_no_emphasis() {
        let lines = vec![del("gone\n"), del("also gone\n")];

        let spans = compute_word_spans_for_hunk(&lines, word_diff_budget());

        assert_eq!(
            all_emphasized(&lines, &spans),
            vec![Vec::<String>::new(); 2]
        );
    }
}
