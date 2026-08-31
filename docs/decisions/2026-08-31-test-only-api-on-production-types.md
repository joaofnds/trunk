# Decision: how a test waits on async production code

Status: **decided** — expose the affordance the test needs on the production
type, gated behind a non-default `test-util` cargo feature.
Date: 2026-08-31

## TL;DR

An async subsystem needs a way for tests to ask "are you done yet?" without a
wall-clock deadline. Put that affordance on the production type and gate it
behind the `test-util` cargo feature, so it compiles for the test suites and is
absent from the shipped library.

Do not use `#[cfg(test)]`: the suites in `src-tauri/tests/` are separate crates
that compile this one as an ordinary dependency, so `cfg(test)` is false while
they build. Do not redesign the production mechanism to make it observable when
a gate would do.

## The problem this solves

Tests that wait on a duration fail under load and pass for the wrong reason.
Two rounds of this in `reviewdb` (TRUNK-57 for the poll, TRUNK-59 for the event
feed) each ended the same way: the fix is a way for the test to observe what
the subsystem *did*, rather than to guess how long it takes.

That observation point has to live somewhere. The options, and why the third
wins:

| Option | Cost |
|---|---|
| `#[cfg(test)]` on the method | Does not work. Integration suites are separate crates; the cfg is false when they compile the library. |
| Redesign so the state is observable through the normal API | Real work, and it warps the production design around a test's needs. For TRUNK-59 this meant a second unix socket and redoing the barrier's ordering proof. |
| **Non-default cargo feature** | A `#[cfg(feature = "test-util")]` per item, plus a dev-dependency on ourselves. Nothing ships. |

## Prior art

Both of the languages this project touches solved it the same way, and neither
chose "redesign until it is observable".

**Tokio** puts `time::pause` and `time::advance` — real code that only tests
call — behind a non-default `test-util` feature. Availability is stated as
"available on crate features `test-util` and `time` only"; without them the
functions do not exist.

**Go** draws the line one level higher. `testing/synctest` (experimental in
1.24, stable in 1.25) exports `synctest.Wait`, which blocks until every other
goroutine in the bubble is *durably blocked*. That is the same job as a
barrier: wait for the system to be quiet rather than for a clock. Go puts it in
the test framework rather than on the type under test, which is available to
them because the runtime owns the scheduler. We do not own ours, so the
affordance lives on the type and the feature draws the line instead.

The common rule: **the line is drawn at what ships, not at what exists.** Test
code existing in the source tree is fine; test code existing in the binary is
not.

## How it is wired here

`src-tauri/Cargo.toml`:

```toml
[features]
test-util = []

[dev-dependencies]
trunk = { path = ".", features = ["test-util"] }
```

The dev-dependency on ourselves is the documented cargo mechanism for enabling
a crate's own feature for its test targets. With it in place, `just check` needs
no extra flags — `cargo test` picks the feature up through the dev-dependency
graph.

Gate the fields and channels too, not only the methods, or the default build
warns about members nothing reads.

## Verifying a gate, and the trap in it

**Check the shipped library, not a dev target.** Examples and benches are dev
targets and *do* receive the unified feature, so a probe in `examples/` will
happily call a gated method. That says nothing about what ships.

The check that means something:

```
cargo build --lib --release
nm target/release/libtrunk_lib.rlib | grep -oE "11StoreEvents[0-9]+(sync|baseline|try_recv)"
```

Empty output, while `StoreEvents4recv` is present, is the proof.

**There is no flag that builds the suites with the feature off.** The self
dev-dependency is unconditional, so `--no-default-features` does not reach it —
`test-util` is not a *default* feature, it is enabled through a dependency
edge. `cargo build --tests --no-default-features` succeeds, and it succeeds
whether or not the gate works, so it proves nothing. To see the feature-off
compile error, remove the dev-dependency line temporarily; nothing else does
it.

Two probes were run during TRUNK-59 that each looked like proof and were not.
An `examples/` probe called a gated method successfully, suggesting the gate
did nothing; acting on it would have reverted a change that works. And the
`--no-default-features` build above was written into the first version of this
document as a reverse check, on the strength of an earlier run that had the
dev-dependency removed at the time. The general shape: a build that succeeds is
weak evidence about a gate, because it succeeds for many reasons. Inspect the
artifact.

## What this does not license

A gate is not a reason to add an affordance the tests do not need. Three
methods went behind this feature; a fourth (`recv_timeout`) had no callers left
once the tests stopped waiting on deadlines, and was deleted rather than gated.
