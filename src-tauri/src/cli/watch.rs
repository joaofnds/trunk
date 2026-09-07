//! The `watch` verb: blocks on the store's doorbell (`reviewdb::events`) and
//! streams changes to published reviews through the caller's sink.

use crate::error::TrunkError;
use crate::reviewdb;
use std::io::Write;

/// Block on the store's doorbell and stream changes to published reviews.
///
/// Plain mode writes one review id per changed review; `--json` writes one
/// self-contained NDJSON event per change with its full data, so a harness
/// never refetches or rediffs. Both modes read off the same entity diff.
/// Composing reviews never enter the snapshot, so their edits wake the
/// process and write nothing. Output is unbounded, unlike the other verbs.
///
/// # Errors
///
/// Returns `store_newer` when a newer Trunk has migrated the store, and
/// whatever reading a snapshot off the store returns.
#[cfg(unix)]
pub fn watch(
    store: &reviewdb::Store,
    canonical: &std::path::Path,
    json: bool,
    out: &mut dyn Write,
) -> Result<(), TrunkError> {
    // Subscribe before the baseline: a commit before the baseline is already
    // inside it, one after leaves a queued ring — no ordering loses a change.
    let events = reviewdb::events::subscribe(store.data_dir())?;
    let mut seen = published_snapshot(store, canonical)?;

    // The readiness line: a harness (and the tests) must know the doorbell
    // is bound before mutating, or the change precedes the watch.
    writeln!(out, "# watching {}", canonical.display()).ok();
    out.flush().ok();

    while let Some(event) = events.recv() {
        match event {
            reviewdb::events::StoreEvent::Refused => {
                return Err(TrunkError::new(
                    "store_newer",
                    "the store was migrated by a newer Trunk — restart this watch with that binary",
                ));
            }
            reviewdb::events::StoreEvent::Changed { .. } => {
                let current = published_snapshot(store, canonical)?;
                let changes = diff_snapshots(&seen, &current);

                if json {
                    for change in &changes {
                        writeln!(
                            out,
                            "{}",
                            serde_json::to_string(change)
                                .map_err(|e| TrunkError::new("json", e.to_string()))?
                        )
                        .ok();
                    }
                } else {
                    let mut reviews_changed: Vec<&str> =
                        changes.iter().map(WatchChange::review).collect();
                    reviews_changed.dedup();
                    for id in reviews_changed {
                        writeln!(out, "{id}").ok();
                    }
                }
                out.flush().ok();
                seen = current;
            }
        }
    }

    Ok(())
}

/// # Errors
///
/// Always returns `unsupported`: `watch` is unix-only today.
#[cfg(not(unix))]
pub fn watch(
    _store: &reviewdb::Store,
    _canonical: &std::path::Path,
    _json: bool,
    _out: &mut dyn Write,
) -> Result<(), TrunkError> {
    Err(TrunkError::new(
        "unsupported",
        "watch is not supported on this platform yet",
    ))
}

#[cfg(unix)]
mod watch_feed {
    //! The watch verb's view of the store and its wire events. The snapshot
    //! holds everything the events may need to say, so a diff is
    //! self-contained; `BTreeMap` keys make event order deterministic.
    //! Post-publish, threads and replies are permanent (spec §2), so the only
    //! disappearance is a whole review's deletion.

    use crate::git::types::Anchor;
    use crate::review_types::{Channel, ThreadState};
    use crate::reviewdb::reviews::ReviewState;
    use serde::Serialize;
    use std::collections::BTreeMap;

    pub type Snapshot = BTreeMap<String, ReviewSnap>;

    pub struct ReviewSnap {
        pub title: String,
        pub state: ReviewState,
        pub threads: BTreeMap<String, ThreadSnap>,
    }

    pub struct ThreadSnap {
        pub state: ThreadState,
        pub stale: bool,
        pub text: String,
        pub anchor: Option<Anchor>,
        pub commit_oid: Option<String>,
        pub replies: BTreeMap<String, ReplySnap>,
    }

    pub struct ReplySnap {
        pub channel: Channel,
        pub text: String,
    }

    /// One NDJSON line of `watch --json`. Additive evolution only: fields
    /// and variants may appear, existing ones keep their meaning.
    #[derive(Serialize)]
    #[serde(tag = "event", rename_all = "snake_case")]
    pub enum WatchChange {
        ReviewPublished {
            review: String,
            title: String,
            state: ReviewState,
        },
        ReviewRetitled {
            review: String,
            title: String,
        },
        ReviewStateChanged {
            review: String,
            from: ReviewState,
            to: ReviewState,
        },
        ReviewDeleted {
            review: String,
        },
        ThreadAdded {
            review: String,
            thread: String,
            state: ThreadState,
            text: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            anchor: Option<Anchor>,
            #[serde(skip_serializing_if = "Option::is_none")]
            commit_oid: Option<String>,
        },
        ThreadEdited {
            review: String,
            thread: String,
            text: String,
        },
        ThreadStateChanged {
            review: String,
            thread: String,
            from: ThreadState,
            to: ThreadState,
        },
        ThreadStaleChanged {
            review: String,
            thread: String,
            stale: bool,
        },
        ReplyAdded {
            review: String,
            thread: String,
            reply: String,
            channel: Channel,
            text: String,
        },
        ReplyEdited {
            review: String,
            thread: String,
            reply: String,
            text: String,
        },
    }

    impl WatchChange {
        pub fn review(&self) -> &str {
            match self {
                Self::ReviewPublished { review, .. }
                | Self::ReviewRetitled { review, .. }
                | Self::ReviewStateChanged { review, .. }
                | Self::ReviewDeleted { review }
                | Self::ThreadAdded { review, .. }
                | Self::ThreadEdited { review, .. }
                | Self::ThreadStateChanged { review, .. }
                | Self::ThreadStaleChanged { review, .. }
                | Self::ReplyAdded { review, .. }
                | Self::ReplyEdited { review, .. } => review,
            }
        }
    }
}

#[cfg(unix)]
use watch_feed::{ReplySnap, ReviewSnap, Snapshot, ThreadSnap, WatchChange};

/// Everything the events may need to say about this repo's published
/// reviews. Composing reviews are excluded, which is the no-leak rule again.
#[cfg(unix)]
fn published_snapshot(
    store: &reviewdb::Store,
    canonical: &std::path::Path,
) -> Result<Snapshot, TrunkError> {
    store.read(|conn| {
        let mut snapshot = Snapshot::new();
        for review in crate::reviewdb::reviews::list(conn, canonical)? {
            if !review.published {
                continue;
            }

            let mut threads = std::collections::BTreeMap::new();
            for (thread, replies) in crate::reviewdb::threads::list_with_replies(conn, &review.id)?
            {
                threads.insert(
                    thread.id,
                    ThreadSnap {
                        state: thread.state,
                        stale: thread.stale,
                        text: thread.text,
                        anchor: thread.anchor,
                        commit_oid: thread.commit_oid,
                        replies: replies
                            .into_iter()
                            .map(|r| {
                                (
                                    r.id,
                                    ReplySnap {
                                        channel: r.channel,
                                        text: r.text,
                                    },
                                )
                            })
                            .collect(),
                    },
                );
            }

            snapshot.insert(
                review.id,
                ReviewSnap {
                    title: review.title,
                    state: review.state,
                    threads,
                },
            );
        }
        Ok(snapshot)
    })
}

/// Entity-level diff, ordered by review id, then threads, then replies. A
/// freshly published review unrolls into its full content — the watcher gets
/// everything without a fetch.
#[cfg(unix)]
fn diff_snapshots(old: &Snapshot, new: &Snapshot) -> Vec<WatchChange> {
    let mut changes = Vec::new();

    for (id, review) in new {
        match old.get(id) {
            None => {
                changes.push(WatchChange::ReviewPublished {
                    review: id.clone(),
                    title: review.title.clone(),
                    state: review.state,
                });
                for (thread_id, thread) in &review.threads {
                    push_thread_added(&mut changes, id, thread_id, thread);
                }
            }
            Some(before) => {
                if review.title != before.title {
                    changes.push(WatchChange::ReviewRetitled {
                        review: id.clone(),
                        title: review.title.clone(),
                    });
                }
                if review.state != before.state {
                    changes.push(WatchChange::ReviewStateChanged {
                        review: id.clone(),
                        from: before.state,
                        to: review.state,
                    });
                }
                for (thread_id, thread) in &review.threads {
                    match before.threads.get(thread_id) {
                        None => push_thread_added(&mut changes, id, thread_id, thread),
                        Some(t) => diff_thread(&mut changes, id, thread_id, t, thread),
                    }
                }
            }
        }
    }

    for id in old.keys() {
        if !new.contains_key(id) {
            changes.push(WatchChange::ReviewDeleted { review: id.clone() });
        }
    }

    changes
}

#[cfg(unix)]
fn push_thread_added(
    changes: &mut Vec<WatchChange>,
    review: &str,
    thread_id: &str,
    thread: &ThreadSnap,
) {
    changes.push(WatchChange::ThreadAdded {
        review: review.to_string(),
        thread: thread_id.to_string(),
        state: thread.state,
        text: thread.text.clone(),
        anchor: thread.anchor.clone(),
        commit_oid: thread.commit_oid.clone(),
    });
    for (reply_id, reply) in &thread.replies {
        changes.push(WatchChange::ReplyAdded {
            review: review.to_string(),
            thread: thread_id.to_string(),
            reply: reply_id.clone(),
            channel: reply.channel,
            text: reply.text.clone(),
        });
    }
}

#[cfg(unix)]
fn diff_thread(
    changes: &mut Vec<WatchChange>,
    review: &str,
    thread_id: &str,
    before: &ThreadSnap,
    after: &ThreadSnap,
) {
    if after.text != before.text {
        changes.push(WatchChange::ThreadEdited {
            review: review.to_string(),
            thread: thread_id.to_string(),
            text: after.text.clone(),
        });
    }
    if after.state != before.state {
        changes.push(WatchChange::ThreadStateChanged {
            review: review.to_string(),
            thread: thread_id.to_string(),
            from: before.state,
            to: after.state,
        });
    }
    if after.stale != before.stale {
        changes.push(WatchChange::ThreadStaleChanged {
            review: review.to_string(),
            thread: thread_id.to_string(),
            stale: after.stale,
        });
    }

    for (reply_id, reply) in &after.replies {
        match before.replies.get(reply_id) {
            None => changes.push(WatchChange::ReplyAdded {
                review: review.to_string(),
                thread: thread_id.to_string(),
                reply: reply_id.clone(),
                channel: reply.channel,
                text: reply.text.clone(),
            }),
            Some(r) if r.text != reply.text => changes.push(WatchChange::ReplyEdited {
                review: review.to_string(),
                thread: thread_id.to_string(),
                reply: reply_id.clone(),
                text: reply.text.clone(),
            }),
            Some(_) => {}
        }
    }
}
