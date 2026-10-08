//! Winding a review store back to an older schema, so a test can watch the
//! migration ladder carry real rows forward.

use rusqlite::Connection;

/// The undo of each schema step from v11 up, newest first. A step added to the
/// ladder adds its undo here, and every wind-back below it follows.
const UNDO: &[(u32, &str)] = &[
    (13, "ALTER TABLE threads DROP COLUMN whole_file;"),
    (
        12,
        "ALTER TABLE threads DROP COLUMN pending;
         ALTER TABLE replies DROP COLUMN pending;
         ALTER TABLE reviews ADD COLUMN published INTEGER NOT NULL DEFAULT 1;",
    ),
    (11, "ALTER TABLE reviews DROP COLUMN archived;"),
];

/// Undo every schema step after `version`, down to v10 at the lowest. The
/// steps below v11 and the `user_version` pragma are the caller's.
///
/// # Panics
///
/// Panics when an undo statement fails, which means the store was not at the
/// current schema.
pub fn undo_steps_after(conn: &Connection, version: u32) {
    for (step, sql) in UNDO {
        if *step > version {
            conn.execute_batch(sql).unwrap();
        }
    }
}
