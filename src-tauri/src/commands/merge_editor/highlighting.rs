//! Presentation spans for the exact lines shown in the merge editor.

use crate::syntax;
use crate::types::{LinePairing, MergeLineSpans, MergePartners, MergePresentation, WordSpan};
use crate::word_spans;
use std::time::Instant;
use syntect::easy::HighlightLines;
use trunk_git::conflicted_file::MergeRegion;

// Two side parsers run on the first read, and edits can request another parse
// for Output. Bound each pane independently and stop at the first skipped line
// because syntax on later lines depends on its parser state.
const MAX_LINES: usize = 1_000;
const MAX_BYTES: usize = 128 * 1024;
const MAX_LINE_BYTES: usize = 2_000;

struct Pane {
    parser: Option<HighlightLines<'static>>,
    number: usize,
    remaining_bytes: usize,
    spans: MergeLineSpans,
}

impl Pane {
    fn new(file_path: &str) -> Self {
        Self {
            parser: syntax::create_highlighter(syntax::extension_from_path(file_path)),
            number: 0,
            remaining_bytes: MAX_BYTES,
            spans: MergeLineSpans::new(),
        }
    }

    fn line(&mut self, line: &str, words: &[WordSpan]) {
        self.number += 1;
        if self.number > MAX_LINES || line.len() > self.remaining_bytes.min(MAX_LINE_BYTES) {
            self.parser = None;
        }
        let tokens = self.parser.as_mut().map_or_else(Vec::new, |parser| {
            self.remaining_bytes -= line.len();
            syntax::highlight_line_with(parser, line)
        });
        if tokens.is_empty() && words.is_empty() {
            return;
        }
        let mut spans = syntax::merge_spans(
            &tokens,
            words,
            u32::try_from(line.len()).unwrap_or(u32::MAX),
        );
        syntax::merged_spans_to_utf16(&mut spans, line);
        self.spans.insert(self.number, spans);
    }

    fn region(&mut self, lines: &[String], words: &[Vec<WordSpan>]) {
        if self.parser.is_none() && words.is_empty() {
            self.number += lines.len();
            return;
        }
        for (i, line) in lines.iter().enumerate() {
            self.line(line, words.get(i).map_or(&[], Vec::as_slice));
        }
    }
}

pub(super) fn syntax_for_text(file_path: &str, text: &str) -> Option<MergeLineSpans> {
    let mut pane = Pane::new(file_path);
    pane.parser.as_ref()?;
    for line in text.split('\n') {
        if pane.parser.is_none() {
            break;
        }
        pane.line(line, &[]);
    }
    Some(pane.spans)
}

pub(super) fn sides(file_path: &str, regions: &[MergeRegion]) -> MergePresentation {
    let mut ours = Pane::new(file_path);
    let mut theirs = Pane::new(file_path);
    // Only word refinement spends this file-wide budget. Parsing context
    // between conflicts must not starve the next comparison.
    let mut remaining = word_spans::WORD_DIFF_BUDGET;
    let mut conflict_partners = MergePartners::new();
    for (index, region) in regions.iter().enumerate() {
        match region {
            MergeRegion::Merged {
                ours_lines,
                theirs_lines,
                ..
            } => {
                ours.region(ours_lines, &[]);
                theirs.region(theirs_lines, &[]);
            }
            MergeRegion::Conflict {
                ours_lines,
                theirs_lines,
            } => {
                let start = Instant::now();
                let words = word_spans::for_conflict(ours_lines, theirs_lines, start + remaining);
                remaining = remaining.saturating_sub(start.elapsed());
                let spans = words.as_ref().map_or(&[][..], |diff| diff.spans.as_slice());
                let (old, new) = spans.split_at(ours_lines.len().min(spans.len()));
                ours.region(ours_lines, old);
                theirs.region(theirs_lines, new);
                if let Some(diff) = words
                    && diff.pairing[0] != LinePairing::Unknown
                {
                    let partners = diff.pairing[..ours_lines.len()]
                        .iter()
                        .map(|verdict| match verdict {
                            LinePairing::Partner { line } => {
                                Some(*line as usize - ours_lines.len())
                            }
                            _ => None,
                        })
                        .collect();
                    conflict_partners.insert(index, partners);
                }
            }
        }
    }
    MergePresentation {
        ours_spans: ours.spans,
        theirs_spans: theirs.spans,
        conflict_partners,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replacements(ours: &[&str], theirs: &[&str]) -> MergeRegion {
        MergeRegion::Conflict {
            ours_lines: ours.iter().map(|line| (*line).to_owned()).collect(),
            theirs_lines: theirs.iter().map(|line| (*line).to_owned()).collect(),
        }
    }

    fn emphasis<'a>(lines: &MergeLineSpans, number: usize, ascii: &'a str) -> Vec<&'a str> {
        lines[&number]
            .iter()
            .filter(|span| span.emphasized)
            .map(|span| &ascii[span.start as usize..span.end as usize])
            .collect()
    }

    #[test]
    fn text_files_show_the_changed_values_without_a_syntax_grammar() {
        let old = ["  accent: \"cyan\",", "  fontSize: 15,"];
        let new = ["  accent: \"amber\",", "  fontSize: 12,"];
        let MergePresentation {
            ours_spans: ours,
            theirs_spans: theirs,
            ..
        } = sides("theme.unknown", &[replacements(&old, &new)]);
        assert_eq!(emphasis(&ours, 1, old[0]), ["cyan"]);
        assert_eq!(emphasis(&theirs, 1, new[0]), ["amber"]);
        assert_eq!(emphasis(&ours, 2, old[1]), ["15"]);
        assert_eq!(emphasis(&theirs, 2, new[1]), ["12"]);
        assert!(
            ours.values()
                .flatten()
                .all(|span| span.syntax_class.is_empty())
        );
    }

    #[test]
    fn separate_parsers_follow_each_side_across_conflict_boundaries() {
        let tail = "let value = 1;";
        let regions = [
            replacements(&["/*"], &["// comment"]),
            MergeRegion::Merged {
                ours_lines: vec![tail.into()],
                theirs_lines: vec![tail.into()],
                merged_lines: vec![tail.into()],
            },
        ];
        let MergePresentation {
            ours_spans: ours,
            theirs_spans: theirs,
            ..
        } = sides("file.ts", &regions);
        assert!(
            ours[&2]
                .iter()
                .all(|span| span.syntax_class == "syn-comment")
        );
        assert!(
            theirs[&2]
                .iter()
                .any(|span| span.syntax_class == "syn-number")
        );
    }

    #[test]
    fn document_limits_end_syntax_and_keep_words_in_later_conflicts() {
        let old = "const value = 15;";
        let new = "const value = 12;";
        let padding = format!("//{}", "x".repeat(MAX_LINE_BYTES - 2));
        for lines in [
            vec!["//"; MAX_LINES],
            vec![padding.as_str(); MAX_BYTES / MAX_LINE_BYTES + 1],
        ] {
            let last = lines.len() + 1;
            let regions = [replacements(&lines, &[]), replacements(&[old], &[new])];
            let MergePresentation {
                ours_spans: ours, ..
            } = sides("file.ts", &regions);
            assert!(ours[&last].iter().all(|span| span.syntax_class.is_empty()));
            assert_eq!(emphasis(&ours, last, old), ["15"]);
        }
    }

    #[test]
    fn excessive_lines_end_syntax_but_later_conflicts_still_get_word_emphasis() {
        let huge = "x".repeat(MAX_LINE_BYTES + 1);
        let regions = [
            replacements(&[&huge], &[]),
            replacements(&["const value = 15;"], &["const value = 12;"]),
        ];
        let MergePresentation {
            ours_spans: ours,
            theirs_spans: theirs,
            ..
        } = sides("file.ts", &regions);
        assert!(!ours.contains_key(&1));
        assert!(ours[&2].iter().all(|s| s.syntax_class.is_empty()));
        assert_eq!(emphasis(&ours, 2, "const value = 15;"), ["15"]);
        assert!(
            theirs[&1]
                .iter()
                .any(|s| s.emphasized && s.syntax_class == "syn-number")
        );
    }
}
