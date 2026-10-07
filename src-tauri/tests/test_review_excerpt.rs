//! A thread's saved excerpt arrives with syntax spans per line, so the card
//! colours its code as the diff does.

mod common;

use common::context::TestContext;
use trunk_review::types::{Anchor, Side, Source};

fn anchor_in(file_path: &str) -> Anchor {
    Anchor {
        commit_oid: "0".repeat(40),
        file_path: file_path.to_string(),
        source: Source::Diff,
        side: Side::New,
        start_line: 1,
        end_line: 2,
    }
}

#[test]
fn colours_each_excerpt_line_past_its_gutter() {
    let ctx = TestContext::new_empty();
    let driver = ctx.review();
    driver
        .add_thread(
            "a comment",
            anchor_in("src/main.rs"),
            "+let x = 1;\n fn y() {}",
        )
        .expect("add_thread should write the thread");

    let threads = driver.list_threads().expect("list_threads should succeed");
    drop(driver);
    let spans = &threads[0].excerpt_spans;

    assert_eq!(spans.len(), 2);
    let keyword = spans[0]
        .iter()
        .find(|s| s.start == 0)
        .expect("the first line's code starts at offset 0, past the gutter");
    assert_eq!(keyword.end, 3, "`let` is its own span");
    assert!(
        !keyword.syntax_class.is_empty(),
        "`let` takes a syntax class"
    );
    assert_eq!(
        spans[1].last().map(|s| s.end),
        Some(9),
        "`fn y() {{}}` is nine bytes"
    );
}

#[test]
fn leaves_an_excerpt_uncoloured_when_its_language_is_unknown() {
    let ctx = TestContext::new_empty();
    let driver = ctx.review();
    driver
        .add_thread("a comment", anchor_in("notes.unknownext"), "+plain words")
        .expect("add_thread should write the thread");

    let threads = driver.list_threads().expect("list_threads should succeed");
    drop(driver);

    assert!(
        threads[0].excerpt_spans[0]
            .iter()
            .all(|s| s.syntax_class.is_empty()),
        "{:?}",
        threads[0].excerpt_spans
    );
}
