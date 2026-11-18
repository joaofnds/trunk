//! A conflicted file as git left it in the working tree, read into the regions the
//! merge editor shows: what git merged, and each conflict with both sides' lines.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MergeRegion {
    /// Lines git merged without a conflict, beside what each side holds there.
    #[serde(rename_all = "camelCase")]
    Merged {
        ours_lines: Vec<String>,
        theirs_lines: Vec<String>,
        merged_lines: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Conflict {
        ours_lines: Vec<String>,
        theirs_lines: Vec<String>,
    },
}

/// The two versions a conflict is between, as the index holds them.
#[derive(Clone, Copy)]
pub struct Sides<'a> {
    pub ours: &'a str,
    pub theirs: &'a str,
}

#[derive(Debug)]
pub enum ReadError {
    /// A conflict opens and never closes, so the file cannot be read as git wrote it.
    UnclosedConflict,
    Git(git2::Error),
}

impl From<git2::Error> for ReadError {
    fn from(error: git2::Error) -> Self {
        Self::Git(error)
    }
}

/// The marker size git writes when no `conflict-marker-size` attribute sets one.
pub const DEFAULT_MARKER_SIZE: usize = 7;

/// The regions of `working`, the file git wrote with conflict markers of `marker_size`
/// characters, beside the two sides it merged.
///
/// What git merged is read from the file, never merged again, so the result is the one
/// the user's git produced, its diff algorithm and merge drivers included, and any edit
/// the user made to the file since.
///
/// # Errors
///
/// Returns `UnclosedConflict` when a conflict in the file never closes, and the git
/// error when a side will not diff against the file.
pub fn regions(
    sides: Sides<'_>,
    working: &str,
    marker_size: usize,
) -> Result<Vec<MergeRegion>, ReadError> {
    let pieces = match read(working, marker_size) {
        Reading::Conflicts(pieces) => pieces,
        Reading::Unclosed => return Err(ReadError::UnclosedConflict),
        Reading::NoConflict => vec![Piece::Merged(split_lines(working))],
    };
    Ok(regions_of(sides, &pieces)?)
}

/// The regions of a file git did not merge, which it leaves as the current side: one
/// conflict between the sides, with the lines they share at each end merged.
///
/// # Errors
///
/// Returns the git error when a side will not diff against the file.
pub fn unmerged_regions(sides: Sides<'_>) -> Result<Vec<MergeRegion>, git2::Error> {
    regions_of(sides, &whole_file_conflict(sides))
}

fn regions_of(sides: Sides<'_>, pieces: &[Piece<'_>]) -> Result<Vec<MergeRegion>, git2::Error> {
    let ours = split_lines(sides.ours);
    let theirs = split_lines(sides.theirs);
    let ours_slices = side_slices(&ours, pieces, Side::Ours)?;
    let theirs_slices = side_slices(&theirs, pieces, Side::Theirs)?;

    let mut regions = pieces
        .iter()
        .zip(ours_slices.into_iter().zip(theirs_slices))
        .filter_map(|(piece, (ours_slice, theirs_slice))| match piece {
            Piece::Merged(merged)
                if merged.is_empty() && ours_slice.is_empty() && theirs_slice.is_empty() =>
            {
                None
            }
            Piece::Merged(merged) => Some(MergeRegion::Merged {
                ours_lines: owned(&ours[ours_slice]),
                theirs_lines: owned(&theirs[theirs_slice]),
                merged_lines: owned(merged),
            }),
            Piece::Conflict(conflict) => Some(MergeRegion::Conflict {
                ours_lines: owned(&conflict.ours),
                theirs_lines: owned(&conflict.theirs),
            }),
        })
        .collect();

    give_the_final_newline_to_its_sides(&mut regions);
    Ok(regions)
}

/// Git ends its closing marker with a newline whatever the sides end with, so where a
/// conflict ends the file, the newline after it belongs to the sides that have one. Kept
/// as merged text, it would end the file in a newline that taking a side without one
/// does not give.
fn give_the_final_newline_to_its_sides(regions: &mut Vec<MergeRegion>) {
    let [
        ..,
        MergeRegion::Conflict {
            ours_lines: ours_conflict,
            theirs_lines: theirs_conflict,
        },
        MergeRegion::Merged {
            ours_lines,
            theirs_lines,
            merged_lines,
        },
    ] = regions.as_mut_slice()
    else {
        return;
    };
    let is_newline = |lines: &[String]| lines == [""];
    let is_newline_or_nothing = |lines: &[String]| lines.is_empty() || is_newline(lines);
    if !is_newline(merged_lines)
        || !is_newline_or_nothing(ours_lines)
        || !is_newline_or_nothing(theirs_lines)
        || (is_newline(ours_lines) && is_newline(theirs_lines))
    {
        return;
    }

    ours_conflict.append(ours_lines);
    theirs_conflict.append(theirs_lines);
    regions.pop();
}

/// Whether `working` still holds a conflict git wrote with markers of `marker_size`,
/// or of the default size, closed or not.
#[must_use]
pub fn holds_conflict(working: &str, marker_size: usize) -> bool {
    !matches!(read(working, marker_size), Reading::NoConflict)
}

/// The file split as the editor joins it back: on every newline, so a file that ends in
/// one ends in an empty line.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n').collect()
}

fn owned(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|&line| line.to_owned()).collect()
}

/// The file between its conflicts, and each conflict. A merged piece stands before,
/// between and after the conflicts, empty where nothing does, so every conflict edge
/// has a merged piece beside it.
enum Piece<'a> {
    Merged(Vec<&'a str>),
    Conflict(ConflictLines<'a>),
}

#[derive(Default)]
struct ConflictLines<'a> {
    ours: Vec<&'a str>,
    theirs: Vec<&'a str>,
}

#[derive(Clone, Copy)]
enum Side {
    Ours,
    Theirs,
}

impl<'a> Piece<'a> {
    /// What the file holds here once every conflict is resolved to `side`.
    fn resolved_to(&self, side: Side) -> &[&'a str] {
        match (self, side) {
            (Self::Merged(merged), _) => merged,
            (Self::Conflict(conflict), Side::Ours) => &conflict.ours,
            (Self::Conflict(conflict), Side::Theirs) => &conflict.theirs,
        }
    }
}

/// The lines the sides share at each end stay merged, and the rest is the conflict.
fn whole_file_conflict(sides: Sides<'_>) -> Vec<Piece<'_>> {
    let ours = split_lines(sides.ours);
    let theirs = split_lines(sides.theirs);
    let shared_start = ours
        .iter()
        .zip(&theirs)
        .take_while(|(our, their)| our == their)
        .count();
    let shared_end = ours[shared_start..]
        .iter()
        .rev()
        .zip(theirs[shared_start..].iter().rev())
        .take_while(|(our, their)| our == their)
        .count();

    vec![
        Piece::Merged(ours[..shared_start].to_vec()),
        Piece::Conflict(ConflictLines {
            ours: ours[shared_start..ours.len() - shared_end].to_vec(),
            theirs: theirs[shared_start..theirs.len() - shared_end].to_vec(),
        }),
        Piece::Merged(ours[ours.len() - shared_end..].to_vec()),
    ]
}

enum Reading<'a> {
    Conflicts(Vec<Piece<'a>>),
    NoConflict,
    Unclosed,
}

/// The file read at the size its attributes name, or at git's default when that finds
/// no conflict, since an attribute the merge itself brought in was not the one git
/// wrote the markers with.
fn read(working: &str, marker_size: usize) -> Reading<'_> {
    match pieces(working, &Markers::new(marker_size)) {
        Reading::NoConflict if marker_size != DEFAULT_MARKER_SIZE => {
            pieces(working, &Markers::new(DEFAULT_MARKER_SIZE))
        }
        reading => reading,
    }
}

fn pieces<'a>(working: &'a str, markers: &Markers) -> Reading<'a> {
    let mut pieces = Vec::new();
    let mut merged: Vec<&str> = Vec::new();
    let mut open: Option<OpenConflict<'_>> = None;

    for line in split_lines(working) {
        match open.as_mut() {
            None if markers.opens(line) => open = Some(OpenConflict::new()),
            None => merged.push(line),
            Some(conflict) => {
                if conflict.take(line, markers) == Progress::Closed
                    && let Some(conflict) = open.take()
                {
                    pieces.push(Piece::Merged(std::mem::take(&mut merged)));
                    pieces.push(Piece::Conflict(conflict.lines));
                }
            }
        }
    }

    if open.is_some() {
        return Reading::Unclosed;
    }
    if pieces.is_empty() {
        return Reading::NoConflict;
    }
    pieces.push(Piece::Merged(merged));
    Reading::Conflicts(pieces)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Ours,
    Base,
    Theirs,
}

#[derive(PartialEq, Eq)]
enum Progress {
    Open,
    Closed,
}

/// A conflict whose closing marker has not been read yet.
struct OpenConflict<'a> {
    section: Section,
    lines: ConflictLines<'a>,
}

impl<'a> OpenConflict<'a> {
    fn new() -> Self {
        Self {
            section: Section::Ours,
            lines: ConflictLines::default(),
        }
    }

    fn take(&mut self, line: &'a str, markers: &Markers) -> Progress {
        match self.section {
            Section::Ours if markers.starts_base(line) => self.section = Section::Base,
            Section::Ours | Section::Base if markers.separates(line) => {
                self.section = Section::Theirs;
            }
            Section::Theirs if markers.closes(line) => return Progress::Closed,
            Section::Ours => self.lines.ours.push(line),
            Section::Base => {}
            Section::Theirs => self.lines.theirs.push(line),
        }
        Progress::Open
    }
}

/// Git's conflict markers at one size: a run of exactly that many marker characters,
/// then the end of the line, or a space and a label where git writes one.
struct Markers {
    size: usize,
}

impl Markers {
    const fn new(size: usize) -> Self {
        Self { size }
    }

    fn opens(&self, line: &str) -> bool {
        self.is_marker(line, '<', true)
    }

    fn starts_base(&self, line: &str) -> bool {
        self.is_marker(line, '|', true)
    }

    fn separates(&self, line: &str) -> bool {
        self.is_marker(line, '=', false)
    }

    fn closes(&self, line: &str) -> bool {
        self.is_marker(line, '>', true)
    }

    fn is_marker(&self, line: &str, marker: char, labelled: bool) -> bool {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let run = line.chars().take_while(|&c| c == marker).count();
        let rest = &line[run..];
        run == self.size && (rest.is_empty() || (labelled && rest.starts_with(' ')))
    }
}

/// Which of `side_lines` sit beside each piece. Each merged piece takes the side's own
/// lines there, found by diffing the side against the file with every conflict
/// resolved to it, and lines a merge removed at a conflict's edge go to the merged
/// piece beside it rather than into the conflict.
fn side_slices(
    side_lines: &[&str],
    pieces: &[Piece<'_>],
    side: Side,
) -> Result<Vec<std::ops::Range<usize>>, git2::Error> {
    let resolved: Vec<&str> = pieces
        .iter()
        .flat_map(|piece| piece.resolved_to(side))
        .copied()
        .collect();
    let hunks = line_hunks(side_lines, &resolved)?;

    let mut slices = Vec::with_capacity(pieces.len());
    let mut resolved_start = 0;
    let mut side_start = 0;
    for piece in pieces {
        let resolved_end = resolved_start + piece.resolved_to(side).len();
        let (early, late) = side_position(&hunks, resolved_end);
        // A side that dropped a conflict's lines holds none of them, so an empty
        // conflict can end before the merged piece in front of it did.
        let side_end = match piece {
            Piece::Merged(_) => late,
            Piece::Conflict(_) => early.max(side_start),
        };

        slices.push(side_start..side_end);
        side_start = side_end;
        resolved_start = resolved_end;
    }

    Ok(slices)
}

/// One change between a side and the resolved file, as line ranges in each.
struct Hunk {
    side: std::ops::Range<usize>,
    resolved: std::ops::Range<usize>,
}

fn line_hunks(side: &[&str], resolved: &[&str]) -> Result<Vec<Hunk>, git2::Error> {
    // Every line ends in a newline here, so libgit2's lines are exactly these.
    let text = |lines: &[&str]| -> Vec<u8> {
        let mut text = Vec::with_capacity(lines.iter().map(|line| line.len() + 1).sum());
        for line in lines {
            text.extend_from_slice(line.as_bytes());
            text.push(b'\n');
        }
        text
    };
    let mut options = git2::DiffOptions::new();
    options.context_lines(0).interhunk_lines(0).force_text(true);
    let side = text(side);
    let resolved = text(resolved);
    let patch = git2::Patch::from_buffers(&side, None, &resolved, None, Some(&mut options))?;

    (0..patch.num_hunks())
        .map(|index| {
            let (hunk, _) = patch.hunk(index)?;
            Ok(Hunk {
                side: hunk_range(hunk.old_start(), hunk.old_lines()),
                resolved: hunk_range(hunk.new_start(), hunk.new_lines()),
            })
        })
        .collect()
}

/// A hunk header's 1-based start as a range of line indexes. An empty range's start
/// names the line it follows, which is the index it sits before.
const fn hunk_range(start: u32, lines: u32) -> std::ops::Range<usize> {
    let start = start as usize;
    let lines = lines as usize;
    if lines == 0 {
        start..start
    } else {
        start - 1..start - 1 + lines
    }
}

/// Where the boundary before resolved line `at` falls in the side. Lines the side has
/// and the resolved file lacks at that boundary can go before it or after it, so both
/// ends come back, earliest first.
fn side_position(hunks: &[Hunk], at: usize) -> (usize, usize) {
    let mut offset_side = 0;
    let mut offset_resolved = 0;
    for hunk in hunks {
        if at < hunk.resolved.start || (at == hunk.resolved.start && !hunk.resolved.is_empty()) {
            let position = hunk.side.start - (hunk.resolved.start - at);
            return (position, position);
        }
        if at < hunk.resolved.end {
            let position = hunk.side.start + (at - hunk.resolved.start).min(hunk.side.len());
            return (position, position);
        }
        if at == hunk.resolved.end {
            let early = hunk.side.start + hunk.resolved.len().min(hunk.side.len());
            return (early, hunk.side.end);
        }
        offset_side = hunk.side.end;
        offset_resolved = hunk.resolved.end;
    }

    let position = offset_side + (at - offset_resolved);
    (position, position)
}

#[cfg(test)]
mod tests {
    use super::{MergeRegion, ReadError, Side, Sides, regions, unmerged_regions};

    const MARKER_SIZE: usize = 7;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_owned).collect()
    }

    fn merged_output(regions: &[MergeRegion]) -> String {
        let lines: Vec<&str> = regions
            .iter()
            .flat_map(|region| match region {
                MergeRegion::Merged { merged_lines, .. } => merged_lines.as_slice(),
                MergeRegion::Conflict { .. } => &[],
            })
            .map(String::as_str)
            .collect();
        lines.join("\n")
    }

    /// A side's pane: its own lines beside what git merged, and its lines of each conflict.
    fn pane(regions: &[MergeRegion], side: Side) -> String {
        let lines: Vec<&str> = regions
            .iter()
            .flat_map(|region| match (region, side) {
                (
                    MergeRegion::Merged { ours_lines, .. }
                    | MergeRegion::Conflict { ours_lines, .. },
                    Side::Ours,
                ) => ours_lines.as_slice(),
                (
                    MergeRegion::Merged { theirs_lines, .. }
                    | MergeRegion::Conflict { theirs_lines, .. },
                    Side::Theirs,
                ) => theirs_lines.as_slice(),
            })
            .map(String::as_str)
            .collect();
        lines.join("\n")
    }

    /// The file with every conflict resolved to `side`.
    fn taking(regions: &[MergeRegion], side: Side) -> String {
        let lines: Vec<&str> = regions
            .iter()
            .flat_map(|region| match (region, side) {
                (MergeRegion::Merged { merged_lines, .. }, _) => merged_lines.as_slice(),
                (MergeRegion::Conflict { ours_lines, .. }, Side::Ours) => ours_lines.as_slice(),
                (MergeRegion::Conflict { theirs_lines, .. }, Side::Theirs) => {
                    theirs_lines.as_slice()
                }
            })
            .map(String::as_str)
            .collect();
        lines.join("\n")
    }

    /// A fixed-seed generator, so a failure names an input that reproduces.
    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from(self.0 >> 33).unwrap() % bound
        }

        /// Lines drawn from a few that repeat, as braces and blank lines repeat in code.
        fn file(&mut self) -> Vec<String> {
            let len = 4 + self.below(24);
            (0..len).map(|_| self.line()).collect()
        }

        fn line(&mut self) -> String {
            ["a", "b", "c", "}", "", "d"][self.below(6)].to_owned()
        }

        fn edit(&mut self, base: &[String]) -> Vec<String> {
            let mut lines = base.to_vec();
            for _ in 0..=self.below(4) {
                let at = self.below(lines.len() + 1);
                match self.below(3) {
                    0 if at < lines.len() => drop(lines.remove(at)),
                    1 if at < lines.len() => lines[at] = format!("{}y", self.line()),
                    _ => lines.insert(at, format!("{}x", self.line())),
                }
            }
            lines
        }

        /// Most files end in a newline, and a few do not.
        fn ends_in_newline(&mut self) -> bool {
            self.below(4) != 0
        }
    }

    fn text(lines: &[String], ends_in_newline: bool) -> String {
        let text = lines.join("\n");
        if ends_in_newline && !text.is_empty() {
            text + "\n"
        } else {
            text
        }
    }

    fn merge(
        base: &str,
        ours: &str,
        theirs: &str,
        configure: impl Fn(&mut git2::MergeFileOptions),
    ) -> String {
        fn input(content: &str) -> git2::MergeFileInput<'_> {
            let mut input = git2::MergeFileInput::new();
            input.content(content.as_bytes()).path("file");
            input
        }
        // git2 0.21's `merge_file` never initialises libgit2, which then fails with "no
        // error", and opening a config is one call that does.
        drop(git2::Config::new());
        let mut options = git2::MergeFileOptions::new();
        configure(&mut options);
        let result = git2::merge_file(
            &input(base),
            &input(ours),
            &input(theirs),
            Some(&mut options),
        )
        .unwrap();
        String::from_utf8(result.content().to_vec()).unwrap()
    }

    #[test]
    fn every_merge_git_writes_reads_back_as_both_sides_and_both_resolutions() {
        let mut generator = Lcg(7);
        for case in 0..2_000 {
            let base = generator.file();
            let ours = text(&generator.edit(&base), generator.ends_in_newline());
            let theirs = text(&generator.edit(&base), generator.ends_in_newline());
            let base = text(&base, generator.ends_in_newline());
            let style = case % 3;
            let working = merge(&base, &ours, &theirs, |options| {
                options.style_diff3(style == 1).style_zdiff3(style == 2);
            });
            let favoring = |favor| {
                merge(&base, &ours, &theirs, |options| {
                    options.favor(favor);
                })
            };

            let regions = regions(
                Sides {
                    ours: &ours,
                    theirs: &theirs,
                },
                &working,
                MARKER_SIZE,
            )
            .unwrap();

            let found = (
                pane(&regions, Side::Ours),
                pane(&regions, Side::Theirs),
                taking(&regions, Side::Ours),
                taking(&regions, Side::Theirs),
            );
            let wanted = (
                ours.clone(),
                theirs.clone(),
                favoring(git2::FileFavor::Ours),
                favoring(git2::FileFavor::Theirs),
            );
            assert_eq!(
                found, wanted,
                "case {case}: base {base:?} ours {ours:?} theirs {theirs:?} working {working:?}"
            );
        }
    }

    #[test]
    fn a_file_git_merged_cleanly_reads_as_the_file_git_wrote_beside_both_sides() {
        let ours = "d\ndx0\ne\nb\na\na\nc\nb\nb\na\n";
        let theirs = "d\ne\nb\ndy\na\n}\nc\nb\na\na\n";
        let working = "d\ndx0\ne\nb\ndy\na\nc\nb\na\n";

        let regions = regions(Sides { ours, theirs }, working, MARKER_SIZE).unwrap();

        assert_eq!(
            (
                merged_output(&regions),
                pane(&regions, Side::Ours),
                pane(&regions, Side::Theirs),
            ),
            (working.to_owned(), ours.to_owned(), theirs.to_owned())
        );
    }

    #[test]
    fn a_conflict_holds_each_sides_lines() {
        let ours = "top\nmine\nbottom\n";
        let theirs = "top\nyours\nbottom\n";
        let working = "top\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> feature\nbottom\n";

        let regions = regions(Sides { ours, theirs }, working, MARKER_SIZE).unwrap();

        assert_eq!(
            regions,
            [
                MergeRegion::Merged {
                    ours_lines: lines("top"),
                    theirs_lines: lines("top"),
                    merged_lines: lines("top"),
                },
                MergeRegion::Conflict {
                    ours_lines: lines("mine"),
                    theirs_lines: lines("yours"),
                },
                MergeRegion::Merged {
                    ours_lines: lines("bottom\n"),
                    theirs_lines: lines("bottom\n"),
                    merged_lines: lines("bottom\n"),
                },
            ]
        );
    }

    fn conflicts(regions: &[MergeRegion]) -> Vec<(Vec<String>, Vec<String>)> {
        regions
            .iter()
            .filter_map(|region| match region {
                MergeRegion::Conflict {
                    ours_lines,
                    theirs_lines,
                } => Some((ours_lines.clone(), theirs_lines.clone())),
                MergeRegion::Merged { .. } => None,
            })
            .collect()
    }

    #[test]
    fn the_base_of_a_diff3_conflict_belongs_to_neither_side() {
        let working =
            "top\n<<<<<<< HEAD\nmine\n||||||| base\nold\n=======\nyours\n>>>>>>> feature\nbottom\n";

        let regions = regions(
            Sides {
                ours: "top\nmine\nbottom\n",
                theirs: "top\nyours\nbottom\n",
            },
            working,
            MARKER_SIZE,
        )
        .unwrap();

        assert_eq!(conflicts(&regions), [(lines("mine"), lines("yours"))]);
    }

    #[test]
    fn a_line_the_user_removed_after_a_conflict_stays_in_the_side_that_has_it() {
        let ours = "top\nmine\nkept\nbottom\n";
        let working = "top\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> feature\nbottom\n";

        let regions = regions(
            Sides {
                ours,
                theirs: "top\nyours\nkept\nbottom\n",
            },
            working,
            MARKER_SIZE,
        )
        .unwrap();

        assert_eq!(pane(&regions, Side::Ours), ours);
    }

    #[test]
    fn a_conflict_that_never_closes_is_refused() {
        let working = "top\n<<<<<<< HEAD\nmine\n=======\nyours\nbottom\n";

        let read = regions(
            Sides {
                ours: "top\nmine\nbottom\n",
                theirs: "top\nyours\nbottom\n",
            },
            working,
            MARKER_SIZE,
        );

        assert!(matches!(read, Err(ReadError::UnclosedConflict)));
    }

    #[test]
    fn markers_of_the_default_size_are_read_when_the_attributes_name_another() {
        let working = "top\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> feature\nbottom\n";

        let regions = regions(
            Sides {
                ours: "top\nmine\nbottom\n",
                theirs: "top\nyours\nbottom\n",
            },
            working,
            3,
        )
        .unwrap();

        assert_eq!(conflicts(&regions), [(lines("mine"), lines("yours"))]);
    }

    #[test]
    fn a_file_git_did_not_merge_is_one_conflict_between_the_sides() {
        let ours = "top\nmine\nmore\nbottom\n";
        let theirs = "top\nyours\nbottom\n";

        let regions = unmerged_regions(Sides { ours, theirs }).unwrap();

        assert_eq!(
            regions,
            [
                MergeRegion::Merged {
                    ours_lines: lines("top"),
                    theirs_lines: lines("top"),
                    merged_lines: lines("top"),
                },
                MergeRegion::Conflict {
                    ours_lines: lines("mine\nmore"),
                    theirs_lines: lines("yours"),
                },
                MergeRegion::Merged {
                    ours_lines: lines("bottom\n"),
                    theirs_lines: lines("bottom\n"),
                    merged_lines: lines("bottom\n"),
                },
            ]
        );
    }

    #[test]
    fn a_conflict_that_ends_a_file_without_a_newline_resolves_without_one() {
        let working = "<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> feature\n";

        let regions = regions(
            Sides {
                ours: "mine",
                theirs: "yours",
            },
            working,
            MARKER_SIZE,
        )
        .unwrap();

        assert_eq!(
            (taking(&regions, Side::Ours), taking(&regions, Side::Theirs)),
            ("mine".to_owned(), "yours".to_owned())
        );
    }

    /// Inside the conflict, the newline both sides end on would be taken once per
    /// side, so taking both sides would leave a blank line between them.
    #[test]
    fn a_newline_both_sides_end_on_stays_out_of_the_last_conflict() {
        let working = "<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> feature\n";

        let regions = regions(
            Sides {
                ours: "mine\n",
                theirs: "yours\n",
            },
            working,
            MARKER_SIZE,
        )
        .unwrap();

        assert_eq!(conflicts(&regions), [(lines("mine"), lines("yours"))]);
    }

    #[test]
    fn a_conflict_reads_through_windows_line_endings() {
        let working =
            "top\r\n<<<<<<< HEAD\r\nmine\r\n=======\r\nyours\r\n>>>>>>> feature\r\nbottom\r\n";

        let regions = regions(
            Sides {
                ours: "top\r\nmine\r\nbottom\r\n",
                theirs: "top\r\nyours\r\nbottom\r\n",
            },
            working,
            MARKER_SIZE,
        )
        .unwrap();

        assert_eq!(conflicts(&regions), [(lines("mine\r"), lines("yours\r"))]);
    }

    mod when_a_line_looks_like_a_marker {
        use super::{MARKER_SIZE, Sides, conflicts, lines, regions};

        #[test]
        fn a_marker_run_followed_by_more_text_is_content() {
            let working =
                "top\n<<<<<<< HEAD\nmine\n=======x\n=======\nyours\n>>>>>>> feature\nbottom\n";

            let regions = regions(
                Sides {
                    ours: "top\nmine\n=======x\nbottom\n",
                    theirs: "top\nyours\nbottom\n",
                },
                working,
                MARKER_SIZE,
            )
            .unwrap();

            assert_eq!(
                conflicts(&regions),
                [(lines("mine\n=======x"), lines("yours"))]
            );
        }

        #[test]
        fn a_run_of_another_size_is_content() {
            let working =
                "top\n<<<<<<<<< HEAD\nmine\n=======\n=========\nyours\n>>>>>>>>> feature\nbottom\n";

            let regions = regions(
                Sides {
                    ours: "top\nmine\n=======\nbottom\n",
                    theirs: "top\nyours\nbottom\n",
                },
                working,
                9,
            )
            .unwrap();

            assert_eq!(
                conflicts(&regions),
                [(lines("mine\n======="), lines("yours"))]
            );
        }
    }
}
