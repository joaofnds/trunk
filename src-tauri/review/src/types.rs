//! Review-domain vocabulary shared across the store (`reviewdb`), the doc renderer
//! (`doc`) and the command layer (`commands::review`).

use serde::{Deserialize, Serialize};
use trunk_git::error::TrunkError;

/// The thread state matrix's closed set (spec §2).
///
/// `open` is the default at creation; `addressed` is the agent's claim, reachable only
/// via `Channel::Agent`; `done`/`dismissed` are the user's resolutions. Serializes
/// lowercase, matching the shipped TS union and the store's CHECK constraint, unlike
/// `Side`/`Source` below, which carry no `rename_all` and must not gain one.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThreadState {
    Open,
    Addressed,
    Done,
    Dismissed,
}

impl ThreadState {
    /// The single place the transition matrix (spec §2) is decided. `self` is
    /// the thread's state before the change; `by` is who is asking. Returns
    /// the state the thread moves to, so callers write through on `Ok`.
    ///
    /// Legal: `Human` moves `open|addressed -> done|dismissed`, `addressed ->
    /// open` (rejecting the agent's claim), and `done|dismissed -> open`
    /// (reopen). `Agent` moves `open -> addressed` and nothing else — it is
    /// the agent's claim by definition, so no path reaches it from `Human`.
    /// Every other pair, identity transitions included, is illegal: the CLI's
    /// `open -> addressed` claim on an already-`addressed` thread must fail
    /// naming the current state, not silently no-op.
    ///
    /// # Errors
    ///
    /// Returns `illegal_transition`, naming the current state, when `by` may not
    /// make that move.
    pub fn transition(self, next: Self, by: Channel) -> Result<Self, TrunkError> {
        use Channel::{Agent, Human};
        use ThreadState::{Addressed, Dismissed, Done, Open};

        let legal = matches!(
            (by, self, next),
            (Human, Open | Addressed, Done | Dismissed)
                | (Human, Addressed | Done | Dismissed, Open)
                | (Agent, Open, Addressed)
        );

        if legal {
            Ok(next)
        } else {
            Err(TrunkError::new(
                "illegal_transition",
                format!("thread is {}", self.as_str()),
            ))
        }
    }

    /// The states `by` may legally move a thread in `self` to — `transition`'s
    /// legal set, precomputed so the wire can carry it and the frontend renders
    /// entries instead of re-deriving the matrix. Ordered resolutions first,
    /// reopen last: this order is the wire contract the UI presents verbatim.
    #[must_use]
    pub fn allowed_transitions(self, by: Channel) -> Vec<Self> {
        use ThreadState::{Addressed, Dismissed, Done, Open};

        [Done, Dismissed, Open, Addressed]
            .into_iter()
            .filter(|&next| self.transition(next, by).is_ok())
            .collect()
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Addressed => "addressed",
            Self::Done => "done",
            Self::Dismissed => "dismissed",
        }
    }
}

impl std::str::FromStr for ThreadState {
    type Err = TrunkError;

    fn from_str(raw: &str) -> Result<Self, TrunkError> {
        match raw {
            "open" => Ok(Self::Open),
            "addressed" => Ok(Self::Addressed),
            "done" => Ok(Self::Done),
            "dismissed" => Ok(Self::Dismissed),
            other => Err(TrunkError::new(
                "store",
                format!("corrupt thread row: unknown state {other:?}"),
            )),
        }
    }
}

/// Who wrote a thread or reply: a UI write records `Human`, a CLI write records
/// `Agent` — attribution by channel, not by identity (spec §2).
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Human,
    Agent,
}

impl Channel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
        }
    }
}

impl std::str::FromStr for Channel {
    type Err = TrunkError;

    fn from_str(raw: &str) -> Result<Self, TrunkError> {
        match raw {
            "human" => Ok(Self::Human),
            "agent" => Ok(Self::Agent),
            other => Err(TrunkError::new(
                "store",
                format!("corrupt row: unknown channel {other:?}"),
            )),
        }
    }
}

/// A single commit in the review session, rendered by the panel (D-05) and consumed as
/// a membership set by the graph (D-04/D-06).
///
/// Serialize-default `snake_case` matches `GraphCommit`, whose fields it copies 1:1.
#[derive(Debug, Serialize, Clone)]
pub struct SessionCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    /// True when this commit is an auto-created review snapshot (working-tree or
    /// index), not a commit the user hand-picked. The panel hides EMPTY snapshot
    /// sections (260531-l02d) while keeping empty hand-picked sections (their
    /// per-commit "Add note" affordance). Set by `list_session_commits`.
    #[serde(default)]
    pub is_snapshot: bool,
}

// ── Review session schema (Phase 65 keystone) ────────────────────────────────
// Persisted to disk and read back, so every type derives Deserialize (unlike the
// write-only DTOs in `trunk_git::types`, and like its `DiffStatus`). Enums serialize as
// PascalCase strings with NO rename_all (like `trunk_git::types::RefType`). Struct fields
// stay snake_case.
// The Anchor NEVER carries hunk_index/line_index/context_lines/ignore_whitespace
// (D-01): it stores source coordinates only, never diff-array positions.

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum Source {
    Diff,
    FullFile,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum Side {
    Old,
    New,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Anchor {
    pub commit_oid: String,
    pub file_path: String,
    pub source: Source,
    pub side: Side,
    pub start_line: u32,
    pub end_line: u32,
}

/// Where a current-file thread is anchored: the block of the working-tree file
/// the user selected, and which occurrence of it they picked.
///
/// There is no commit oid. That is the point of the content pin: a current-file
/// comment writes nothing into the repository, so it cannot name a commit and
/// must find its lines by searching the file.
///
/// `ordinal` is a display hint only, deciding which occurrence to render
/// against. Staleness is block presence alone, so keying it on the ordinal
/// would mark a thread stale when an EARLIER twin is deleted, which the
/// ratified rule forbids.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct ContentPin {
    pub file_path: String,
    pub block: String,
    pub ordinal: u32,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Comment {
    // Stable id generated on write (D-03); edit/delete target by id, never by
    // list position. `#[serde(default)]` makes a v1 file lacking `id` deserialize
    // to "" (the migration-shape-A sentinel backfilled at load time) instead of
    // failing from_value.
    #[serde(default)]
    pub id: String,
    pub text: String,
    pub anchor: Option<Anchor>,
    pub cached_excerpt: Option<String>,
    // Commit-level comment target (D-01, written in Plan 02). A missing field
    // maps to None automatically for Option, so no #[serde(default)] is needed.
    pub commit_oid: Option<String>,
    // A current-file comment's target: the file's content rather than a commit.
    #[serde(default)]
    pub content_pin: Option<ContentPin>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATES: [ThreadState; 4] = [
        ThreadState::Open,
        ThreadState::Addressed,
        ThreadState::Done,
        ThreadState::Dismissed,
    ];

    /// All 16 (from, to) pairs × 2 channels: the 8 the spec's matrix legalizes,
    /// and `illegal_transition` for the other 24 — identity transitions included.
    #[test]
    fn the_transition_matrix_is_exact() {
        use Channel::*;
        use ThreadState::*;

        let legal: &[(Channel, ThreadState, ThreadState)] = &[
            (Human, Open, Done),
            (Human, Open, Dismissed),
            (Human, Addressed, Done),
            (Human, Addressed, Dismissed),
            (Human, Addressed, Open),
            (Human, Done, Open),
            (Human, Dismissed, Open),
            (Agent, Open, Addressed),
        ];

        let mut checked = 0;
        for &channel in &[Human, Agent] {
            for &from in &STATES {
                for &to in &STATES {
                    let result = from.transition(to, channel);
                    let expect_legal = legal.contains(&(channel, from, to));
                    assert_eq!(
                        result.is_ok(),
                        expect_legal,
                        "{channel:?} {from:?} -> {to:?}: expected legal={expect_legal}, got {result:?}",
                    );
                    match result {
                        Ok(state) => assert_eq!(state, to, "Ok must carry the state moved to"),
                        Err(err) => assert_eq!(err.code, "illegal_transition"),
                    }
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 32, "4 states x 4 states x 2 channels");
    }

    #[test]
    fn a_second_addressed_claim_names_the_current_state() {
        let err = ThreadState::Addressed
            .transition(ThreadState::Addressed, Channel::Agent)
            .unwrap_err();

        assert_eq!(err.code, "illegal_transition");
        assert!(
            err.message.contains("addressed"),
            "the error must name the CURRENT state, got {:?}",
            err.message,
        );
    }

    /// `allowed_transitions` is `transition`'s legal set and nothing else, for
    /// every state and channel — the two can never disagree.
    #[test]
    fn allowed_transitions_agree_with_the_matrix() {
        for &channel in &[Channel::Human, Channel::Agent] {
            for &from in &STATES {
                let allowed = from.allowed_transitions(channel);
                for &to in &STATES {
                    assert_eq!(
                        allowed.contains(&to),
                        from.transition(to, channel).is_ok(),
                        "{channel:?} {from:?} -> {to:?}",
                    );
                }
            }
        }
    }

    /// The order is the wire contract: the UI renders it verbatim, so
    /// resolutions come before reopen.
    #[test]
    fn allowed_transitions_order_resolutions_before_reopen() {
        assert_eq!(
            ThreadState::Addressed.allowed_transitions(Channel::Human),
            vec![ThreadState::Done, ThreadState::Dismissed, ThreadState::Open],
        );
    }
}
