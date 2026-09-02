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
        "TASKS.md",
        r##"# Tasks

- [ ] draft the release notes
- [x] run the suite
- [ ] tag the release
"##,
    );
    fixture_commit(&mut repo, 12, r##"docs: add a task list"##);
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
        13,
        r##"docs: edit one item of a task list

Rendered view: the first item's added word is marked, and the checkboxes
render on every item. No mark anywhere, or a missing merged copy, is the
defect (TRUNK-112) — a task item is an ordinary list item to the reader."##,
    );
    fixture_scenario(
        &mut repo,
        r##"# Rendered markdown diff

Seven defects, one commit pair each. Open a commit, switch the centre pane to
the rendered view (the toggle beside the diff), and compare against the
commit's own message: each says what the rendered view should show and what
would count as wrong.

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

The rendered view has an inline (merged) mode and a split mode, and a hunk
(folded) mode and a full-file mode. The fold rows above are about hunk mode,
which is the default; check the fold rows in full-file mode too, where every
item should be present.
"##,
    );
    fixture_commit(&mut repo, 14, r##"docs: record what to look at"##);
    fixture_write(
        &mut repo,
        "README.md",
        r##"# Project

![badge](badge.png) A caption that has now changed, beside a badge that still did not.

The paragraph below is here so the file has more than one block.
"##,
    );
}
