//! Review-domain vocabulary shared across the store (`reviewdb`), the doc
//! renderer (`git::review`) and the command layer (`commands::review`). None
//! of those three owns these types, so they live here instead of inside any
//! one of them — `git::types` is git2→DTO conversion only (its own header),
//! and these enums carry no git meaning.

use crate::error::TrunkError;
use serde::{Deserialize, Serialize};

/// The thread state matrix's closed set (spec §2). `open` is the default at
/// creation; `addressed` is the agent's claim, reachable only via `Channel::Agent`;
/// `done`/`dismissed` are the user's resolutions. Serializes lowercase, matching
/// the shipped TS union and the store's CHECK constraint — unlike
/// `git::types::Side`/`Source`, which carry no `rename_all` and must not gain one.
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
