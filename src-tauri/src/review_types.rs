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
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadState::Open => "open",
            ThreadState::Addressed => "addressed",
            ThreadState::Done => "done",
            ThreadState::Dismissed => "dismissed",
        }
    }
}

impl std::str::FromStr for ThreadState {
    type Err = TrunkError;

    fn from_str(raw: &str) -> Result<Self, TrunkError> {
        match raw {
            "open" => Ok(ThreadState::Open),
            "addressed" => Ok(ThreadState::Addressed),
            "done" => Ok(ThreadState::Done),
            "dismissed" => Ok(ThreadState::Dismissed),
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
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Human => "human",
            Channel::Agent => "agent",
        }
    }
}

impl std::str::FromStr for Channel {
    type Err = TrunkError;

    fn from_str(raw: &str) -> Result<Self, TrunkError> {
        match raw {
            "human" => Ok(Channel::Human),
            "agent" => Ok(Channel::Agent),
            other => Err(TrunkError::new(
                "store",
                format!("corrupt row: unknown channel {other:?}"),
            )),
        }
    }
}
