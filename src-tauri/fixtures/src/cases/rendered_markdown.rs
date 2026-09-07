//! Case 11: the rendered-markdown diff defects, one commit pair each: an unchanged image
//! beside changed words, a markup-only edit, the fold inside a list and inside a
//! blockquote, a quote that stops being a container, and a task list. Transcribed from
//! cases/11-rendered-markdown/build.sh.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo, Signature};

const FIXTURE: Identity = Identity {
    name: "Trunk Fixture",
    email: "fixture@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "11-rendered-markdown",
    summary: "The rendered-markdown diff defects: badge, markup, fold, quote, task list.",
    repos: &["rendered-markdown"],
    build,
};

/// A 16x16 PNG, the bytes of cases/11-rendered-markdown/badge.png.
const BADGE_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x91, 0x68,
    0x36, 0x00, 0x00, 0x00, 0x16, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xd0, 0xad, 0xbd, 0x41,
    0x12, 0x62, 0x18, 0xd5, 0x30, 0xaa, 0x61, 0xf8, 0x6a, 0x00, 0x00, 0x8a, 0xa2, 0x82, 0x10, 0x4a,
    0x06, 0xc5, 0x31, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

fn day(n: i64) -> Signature {
    FIXTURE.at(BASE_SECS + n * DAY_SECS)
}

/// `fixture_write <repo> <path> <content>`: the content plus one newline.
fn fixture_write(repo: &mut Repo, rel: &str, content: &str) {
    repo.write(rel, &format!("{content}\n"));
}

/// `fixture_commit <repo> <day> <message>` with no paths: stage everything.
fn fixture_commit(repo: &mut Repo, on: i64, msg: &str) {
    repo.add_all();
    repo.commit(day(on), msg);
}

/// `fixture_scenario <repo> <text>`: SCENARIO.md, the text plus one newline.
fn fixture_scenario(repo: &mut Repo, text: &str) {
    repo.write("SCENARIO.md", &format!("{text}\n"));
}

/// `long_list <changed_at> <text> [prefix]`: twenty items, one carrying the text. The
/// shell read it through `$(…)`, which strips the trailing newline.
fn long_list(changed_at: usize, text: &str, prefix: &str) -> String {
    let list: String = (0..20)
        .map(|i| {
            if i == changed_at {
                format!("{prefix}- step {i} {text}\n")
            } else {
                format!("{prefix}- step {i}\n")
            }
        })
        .collect();

    list.trim_end_matches('\n').to_owned()
}

/// A thirty-item list carrying two changed items far enough apart (indices 5
/// and 24) that a gap of unchanged items survives between their two
/// three-line context windows.
fn two_far_changes(first: &str, second: &str) -> String {
    (0..30)
        .map(|i| match i {
            5 => format!("- step {i} {first}\n"),
            24 => format!("- step {i} {second}\n"),
            _ => format!("- step {i}\n"),
        })
        .collect::<String>()
        .trim_end_matches('\n')
        .to_owned()
}

/// A twenty-row markdown table, one row carrying `text` in its second column.
fn table_rows(changed_at: usize, text: &str) -> String {
    (0..20)
        .map(|i| {
            if i == changed_at {
                format!("| r{i} | {text} |\n")
            } else {
                format!("| r{i} | v |\n")
            }
        })
        .collect::<String>()
        .trim_end_matches('\n')
        .to_owned()
}

fn build(out: &Path) {
    let mut repo = Repo::init(&out.join("rendered-markdown"), "main", FIXTURE);
    repo.config("commit.gpgsign", "false");
    repo.write_bytes("badge.png", BADGE_PNG);

    fixture_write(
        &mut repo,
        "README.md",
        r##"# Project

![badge](badge.png) A caption that will change, beside a badge that will not.

The paragraph below is here so the file has more than one block.
"##,
    );
    fixture_commit(&mut repo, 0, r##"docs: add a readme with a badge"##);
    fixture_write(
        &mut repo,
        "README.md",
        r##"# Project

![badge](badge.png) A caption that has now changed, beside a badge that did not.

The paragraph below is here so the file has more than one block.
"##,
    );
    fixture_commit(
        &mut repo,
        1,
        r##"docs: reword the caption beside the badge

Rendered view: the caption's words are marked, and the badge is NOT.
A struck-through badge duplicated beside itself is the defect (TRUNK-102).
The image renders once, unmarked."##,
    );
    fixture_write(
        &mut repo,
        "CHECKLIST.md",
        r##"# Checklist

- run the **full** suite before pushing
- update the changelog
- tag the release
"##,
    );
    fixture_commit(
        &mut repo,
        2,
        r##"docs: add a checklist with one bold phrase"##,
    );
    fixture_write(
        &mut repo,
        "CHECKLIST.md",
        r##"# Checklist

- run the full suite before pushing
- update the changelog
- tag the release
"##,
    );
    fixture_commit(
        &mut repo,
        3,
        r##"docs: unbold a phrase, formatting only

Rendered view: the first item carries a tint saying it changed, and NO
del/ins word marks, since no visible word changed. A plain list that reads
identically to an unchanged one is the defect (TRUNK-101)."##,
    );
    fixture_write(
        &mut repo,
        "STEPS.md",
        &format!("# Steps\n\n{}", long_list(9, "with **emphasis** here", "")),
    );
    fixture_commit(&mut repo, 4, r##"docs: add a twenty-step list"##);
    fixture_write(
        &mut repo,
        "STEPS.md",
        &format!("# Steps\n\n{}", long_list(9, "with emphasis here", "")),
    );
    fixture_commit(
        &mut repo,
        5,
        r##"docs: unbold one step of twenty

Rendered view: the list folds, and step 9 survives the fold carrying its
tint. A fold that hides the one changed item shows the reader an unmarked
list in the default view, which is the defect."##,
    );
    fixture_write(
        &mut repo,
        "QUOTED.md",
        &format!(
            "# Quoted\n\n{}",
            long_list(9, "as originally written", "> ")
        ),
    );
    fixture_commit(
        &mut repo,
        6,
        r##"docs: add a twenty-item list inside a blockquote"##,
    );
    fixture_write(
        &mut repo,
        "QUOTED.md",
        &format!("# Quoted\n\n{}", long_list(9, "as revised today", "> ")),
    );
    fixture_commit(
        &mut repo,
        7,
        r##"docs: edit one item of a quoted list

Rendered view: the quoted list FOLDS, like the same list unquoted, and the
changed item's words are marked. Twenty quoted items rendered whole is the
defect (TRUNK-103) — a reader should not scan them all to find one edit."##,
    );
    fixture_write(
        &mut repo,
        "GAINED.md",
        r##"# Gained a paragraph

> - one
> - two
"##,
    );
    fixture_commit(&mut repo, 8, r##"docs: add a short quoted list"##);
    fixture_write(
        &mut repo,
        "GAINED.md",
        r##"# Gained a paragraph

> - one
> - two
>
> and a closing thought
"##,
    );
    fixture_commit(
        &mut repo,
        9,
        r##"docs: append a paragraph to a quoted list

Rendered view: BOTH sides are on screen. The after side showing nothing at
all is the defect — the quote stops being a container, and a diff that reads
one side's structure for both blanks the new content."##,
    );
    fixture_write(
        &mut repo,
        "STABLE.md",
        r##"# Stable

> A quoted paragraph of prose, which is not a container and must keep the
> whole-fragment path it has always taken.

A list item whose source wraps
across two lines without changing a word.

- alpha
- beta
"##,
    );
    fixture_commit(
        &mut repo,
        10,
        r##"docs: add the shapes that must not change"##,
    );
    fixture_write(
        &mut repo,
        "STABLE.md",
        r##"# Stable

> A quoted paragraph of prose, which is not a container and must keep the
> whole-fragment path it has always chosen.

A list item whose source wraps across two lines without changing a word.

- alpha
- beta
"##,
    );
    fixture_commit(
        &mut repo,
        11,
        r##"docs: edit quoted prose and rewrap a paragraph

Rendered view, two things at once.

The quoted prose marks the changed word: it is prose, not a container, so
the words are struck and inserted and no tint appears.

The rewrapped paragraph moved no rendered word, so the word merge declines
and the before/after PAIR renders, both copies washed, with the note
'Reflowed — renders identically' under them. Two identical-looking copies
plus that note is CORRECT: the note is what tells the reader why they read
the same. What would be wrong is a del/ins mark on a word, or the note
missing so the two copies say nothing."##,
    );
    fixture_write(
        &mut repo,
        "HTMLBLOCK.md",
        r##"# Wrapped in raw HTML

<details>
<summary>An expandable section</summary>
The prose inside is what the reader came for.
It is wrapped in tags the renderer refuses to emit.
</details>

A closing paragraph outside the block.
"##,
    );
    fixture_commit(&mut repo, 12, r##"docs: add a raw-HTML section"##);
    fixture_write(
        &mut repo,
        "HTMLBLOCK.md",
        r##"# Wrapped in raw HTML

<details>
<summary>An expandable section</summary>
The prose inside is what the reader came for.
It is wrapped in tags the renderer will not emit.
</details>

A closing paragraph outside the block.
"##,
    );
    fixture_commit(
        &mut repo,
        13,
        r##"docs: edit prose inside a raw-HTML block

Rendered view: the block's SOURCE is on screen, both sides, as a code block.

Sanitization strips raw HTML by design, so this block renders to nothing at
all. Showing the source is what puts the change in front of the reader. An
empty tinted block is the defect, and an empty block under the note
'Reflowed - renders identically' is the same defect stating the opposite of
the truth: the content is exactly what changed."##,
    );
    fixture_write(
        &mut repo,
        "TASKS.md",
        r##"# Tasks

- [ ] draft the release notes
- [x] run the suite
- [ ] tag the release
"##,
    );
    fixture_commit(&mut repo, 14, r##"docs: add a task list"##);
    fixture_write(
        &mut repo,
        "TASKS.md",
        r##"# Tasks

- [ ] draft the release notes carefully
- [x] run the suite
- [ ] tag the release
"##,
    );
    fixture_commit(
        &mut repo,
        15,
        r##"docs: edit one item of a task list

Rendered view: the first item's added word is marked, and the checkboxes
render on every item. No mark anywhere, or a missing merged copy, is the
defect (TRUNK-112) — a task item is an ordinary list item to the reader."##,
    );
    fixture_write(
        &mut repo,
        "ROWFOLD.md",
        &format!(
            "# Row fold\n\nA paragraph far from the change, kept unchanged across both \
             revisions.\n\n{}",
            long_list(9, "before the row-level fix", "")
        ),
    );
    fixture_commit(
        &mut repo,
        16,
        r##"docs: add a paragraph far from a twenty-item list"##,
    );
    fixture_write(
        &mut repo,
        "ROWFOLD.md",
        &format!(
            "# Row fold\n\nA paragraph far from the change, kept unchanged across both \
             revisions.\n\n{}",
            long_list(9, "after the row-level fix", "")
        ),
    );
    fixture_commit(
        &mut repo,
        17,
        r##"docs: edit a list item far from an unrelated paragraph

Rendered view: hunk mode hides the paragraph, the same as source mode. Both
measure distance to the changed LINE, not to the whole changed block's span
(TRUNK-144, doc-60 finding F3). The paragraph on screen in hunk mode is the
defect — it sits more than three source lines from the one changed line, so
neither mode should show it."##,
    );
    fixture_write(
        &mut repo,
        "HEADING.md",
        &format!(
            "# Severity\n\n{}\n\n{}",
            (0..8)
                .map(|i| format!("Filler sentence {i}, not part of the list below."))
                .collect::<Vec<_>>()
                .join("\n\n"),
            long_list(5, "before", "")
        ),
    );
    fixture_commit(
        &mut repo,
        18,
        r##"docs: add a heading, filler prose, then a twenty-item list"##,
    );
    fixture_write(
        &mut repo,
        "HEADING.md",
        &format!(
            "# Severity\n\n{}\n\n{}",
            (0..8)
                .map(|i| format!("Filler sentence {i}, not part of the list below."))
                .collect::<Vec<_>>()
                .join("\n\n"),
            long_list(5, "after", "")
        ),
    );
    fixture_commit(
        &mut repo,
        19,
        r##"docs: edit one item of a list far below a heading

Rendered view: the heading '# Severity' stays on screen as context even though
it sits far outside the change's context window — the heading exception
(João, 2026-09-07, TRUNK-144 AC #9). Every filler sentence between the heading
and the list folds away: none of them is within three source lines of the
changed line, and only the heading itself is exempt from that rule."##,
    );
    fixture_write(
        &mut repo,
        "TWOGAPS.md",
        &format!(
            "# Two gaps\n\n{}",
            two_far_changes("before first", "before second")
        ),
    );
    fixture_commit(&mut repo, 20, r##"docs: add a thirty-item list"##);
    fixture_write(
        &mut repo,
        "TWOGAPS.md",
        &format!(
            "# Two gaps\n\n{}",
            two_far_changes("after first", "after second")
        ),
    );
    fixture_commit(
        &mut repo,
        21,
        r##"docs: edit two list items far enough apart to leave a gap between them

Rendered view: hunk mode shows THREE runs of visible items separated by TWO
fold notes — above the first change, between the two changes, and below the
second — because a surviving gap sits between the two context windows
(TRUNK-144 AC #4 doc-60 finding, the per-gap note)."##,
    );
    fixture_write(
        &mut repo,
        "TABLEFOLD.md",
        &format!(
            "# Table fold\n\n| step | detail |\n| --- | --- |\n{}",
            table_rows(10, "before")
        ),
    );
    fixture_commit(&mut repo, 22, r##"docs: add a twenty-row table"##);
    fixture_write(
        &mut repo,
        "TABLEFOLD.md",
        &format!(
            "# Table fold\n\n| step | detail |\n| --- | --- |\n{}",
            table_rows(10, "after")
        ),
    );
    fixture_commit(
        &mut repo,
        23,
        r##"docs: edit one row of a twenty-row table

Rendered view: the table folds like the lists above, and the hidden-rows note
spans both columns of its own row rather than sitting beside them — a table
row is a leaf like a list item, and its note must respect the table's shape."##,
    );
    fixture_scenario(
        &mut repo,
        r##"# Rendered markdown diff

Thirteen defects and design cases, one commit pair each. Open a commit,
switch the centre pane to the rendered view (the toggle beside the diff), and
compare against the commit's own message: each says what the rendered view
should show and what would count as wrong.

Start with the working tree. `README.md` is edited and unstaged, which is
the path where the two sides carry different revisions — the case where an
unchanged image used to render struck through and duplicated.

| Look at | Should show | Would be wrong |
|---|---|---|
| Working tree, `README.md` | The caption's words marked; the badge rendered once, unmarked | The badge struck through and a second copy beside it |
| `docs: reword the caption beside the badge` | Same, between two commits | Same |
| `docs: unbold a phrase, formatting only` | The first item tinted, no del/ins marks | A plain list reading like an unchanged one |
| `docs: unbold one step of twenty` | A folded list; step 9 present and tinted | Step 9 hidden, or no mark anywhere |
| `docs: edit one item of a quoted list` | The quoted list folded, changed item marked | All twenty quoted items rendered |
| `docs: append a paragraph to a quoted list` | Both sides on screen | The after side blank |
| `docs: edit one item of a task list` | The added word marked, checkboxes on every item | No mark anywhere, or the item rendered without its checkbox |
| `docs: edit quoted prose and rewrap a paragraph` | Quoted prose word-marked; the rewrap renders as two washed copies under the note 'Reflowed — renders identically' | A del/ins mark on a rewrapped word, or the note missing so two identical copies say nothing |
| `docs: edit prose inside a raw-HTML block` | The block's source on screen, both sides, as a code block | An empty tinted block, or an empty one under the note 'Reflowed — renders identically' |
| `docs: edit a list item far from an unrelated paragraph` | The paragraph hidden in hunk mode, same as source | The paragraph on screen in hunk mode (TRUNK-144, the row-level fix) |
| `docs: edit one item of a list far below a heading` | The heading on screen as context; every filler sentence between it and the list gone | A filler sentence surviving, or the heading itself gone |
| `docs: edit two list items far enough apart to leave a gap between them` | Three visible runs, two separate fold notes | One run, or one note covering both changes |
| `docs: edit one row of a twenty-row table` | The table folds; its note spans both columns of its own row | The note beside the row instead of spanning it, or the table unfolded |

The rendered view has an inline (merged) mode and a split mode, and a hunk
(folded) mode and a full-file mode. The fold rows above are about hunk mode,
which is the default; check the fold rows in full-file mode too, where every
item should be present.

## Where preview and source still disagree

Hunk mode's row and leaf folds now measure distance to the nearest changed
source line rather than to a whole changed block's span, which is what
source-mode hunks measure against too. Three disagreements survive that
change (TRUNK-144):

- **A list item longer than the context window.** Source shows a partial
  item — as many of its lines as the window reaches. Preview's smallest unit
  is a leaf, so it shows the item whole. Neither mode is wrong; a leaf cannot
  render half of itself.
- **A rewrap that moves no rendered word.** Source's changed-line set comes
  from the line diff, so a paragraph whose wrapping changed sits inside
  source's context window and source shows the lines around it. Preview
  treats a rewrap as no visible change (the 'Reflowed — renders identically'
  case above) and shows nothing extra for it. This is by design: the
  rendered view exists to hide exactly this kind of source-only churn.
- **A markup-only edit, or a leaf an insertion or deletion anchors between.**
  Preview keeps these leaves even when no source line inside them is within
  the context window of a changed line, because the leaf fold widens its
  keep set for them regardless of distance (`leaves_to_keep` in
  `markdown.rs`). Source has no equivalent leaf concept, so it never widens
  to match; a leaf preview keeps this way can sit further from the change
  than anything source's window would show.

The first two are named in the TRUNK-144 design (doc-60) as the residue of
choosing leaves as preview's unit; closing them would mean rendering partial
leaves, which is a different and larger design. The third follows from the
change rule that keeps a changed leaf legible (`.claude/rules/rendered-markdown.md`
'A fold never hides every mark the unfolded copy carries'), which has no
source-mode counterpart to disagree with.
"##,
    );
    fixture_commit(&mut repo, 25, r##"docs: record what to look at"##);
    fixture_write(
        &mut repo,
        "README.md",
        r##"# Project

![badge](badge.png) A caption that has now changed, beside a badge that still did not.

The paragraph below is here so the file has more than one block.
"##,
    );
}
