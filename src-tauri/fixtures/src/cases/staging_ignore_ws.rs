//! Case 03: staging must act on the hunks the view shows, not the ones it hid
//! (TRUNK-73). One repository per gesture, each with a whitespace-only change ahead of
//! two real edits. Transcribed from cases/03-staging-ignore-ws/build.sh.

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
    name: "03-staging-ignore-ws",
    summary: "Six repos proving staging acts on the hunks the view actually shows (TRUNK-73).",
    repos: &[
        "7a-stage-hunk-ignore-ws",
        "7b-stage-lines-ignore-ws",
        "7c-unstage-hunk-ignore-ws",
        "7d-unstage-lines-ignore-ws",
        "7e-discard-hunk-ignore-ws",
        "7f-no-regression-plain",
    ],
    build,
};

fn day(n: i64) -> Signature {
    FIXTURE.at(BASE_SECS + n * DAY_SECS)
}

/// The committed file: forty plain numbered lines.
fn base() -> String {
    (1..=40).map(|i| format!("line {i}\n")).collect()
}

/// The working-tree edit: trailing spaces on line 2, real edits on 21 and 39.
fn edits() -> String {
    (1..=40)
        .map(|i| match i {
            2 => "line 2   \n".to_owned(),
            21 => "REAL line 21\n".to_owned(),
            39 => "REAL line 39\n".to_owned(),
            _ => format!("line {i}\n"),
        })
        .collect()
}

/// `build_case <dir> <scenario-body> [stage_all]`.
fn build_case(out: &Path, name: &str, body: &str, stage_all: bool) {
    let mut repo = Repo::init(&out.join(name), "main", FIXTURE);
    repo.config("commit.gpgsign", "false");
    repo.write("notes.txt", &base());
    repo.add(&["notes.txt"]);
    repo.commit(day(0), "add notes.txt");
    repo.write("notes.txt", &edits());
    repo.write("SCENARIO.md", &format!("{body}\n"));
    repo.add(&["SCENARIO.md"]);
    repo.commit(day(1), "add scenario notes");
    if stage_all {
        repo.add(&["notes.txt"]);
    }
}

fn build(out: &Path) {
    build_case(
        out,
        "7a-stage-hunk-ignore-ws",
        "# 7a — Stage Hunk under ignore-whitespace

Open notes.txt in UNSTAGED. Turn ON 'Ignore whitespace'.

1. The Stage Hunk buttons must be CLICKABLE. Before this fix they were greyed
   out, tooltip 'Staging is disabled while whitespace changes are ignored'.
2. You should see TWO hunks. Stage the FIRST one (it holds 'REAL line 21').
3. The staged diff must show REAL line 21.

FAIL if the staged side shows the line 2 change instead: that is the old bug,
staging a line the view deliberately hid.",
        false,
    );

    build_case(
        out,
        "7b-stage-lines-ignore-ws",
        "# 7b — Stage Lines under ignore-whitespace

Open notes.txt in UNSTAGED. Turn ON 'Ignore whitespace'.

Select the '+ REAL line 21' line inside the first hunk (drag from the line-number
gutter) and press Stage Lines.

The staged diff must show REAL line 21 and nothing about line 2.",
        false,
    );

    build_case(
        out,
        "7c-unstage-hunk-ignore-ws",
        "# 7c — Unstage Hunk under ignore-whitespace

notes.txt is ALREADY STAGED here. Open it in the STAGED list and turn ON
'Ignore whitespace'.

You should see TWO hunks. Unstage the FIRST one.

REAL line 21 must move back to unstaged, and the line 2 whitespace change must
stay staged.",
        true,
    );

    build_case(
        out,
        "7d-unstage-lines-ignore-ws",
        "# 7d — Unstage Lines under ignore-whitespace

notes.txt is ALREADY STAGED here. Open it in the STAGED list and turn ON
'Ignore whitespace'.

Select the '+ REAL line 21' line in the first hunk and press Unstage Lines.

Only that line comes back to unstaged.",
        true,
    );

    build_case(
        out,
        "7e-discard-hunk-ignore-ws",
        "# 7e — Discard Hunk under ignore-whitespace (DESTRUCTIVE)

Open notes.txt in UNSTAGED. Turn ON 'Ignore whitespace'.

Discard the FIRST hunk and confirm the dialog.

Line 21 must go back to 'line 21'. The trailing spaces on line 2 must SURVIVE,
because the view never showed that change. Check with:

    git -C . diff | cat -A | grep 'line 2'

This case is destructive, which is why it has its own repo.",
        false,
    );

    build_case(
        out,
        "7f-no-regression-plain",
        "# 7f — No regression with ignore-whitespace OFF

Open notes.txt in UNSTAGED. Leave 'Ignore whitespace' OFF.

You should see THREE hunks now, the first being the line 2 whitespace change.
Stage each one individually and confirm each stages exactly what it displays.

This is the path that already worked; it must still work.",
        false,
    );
}
