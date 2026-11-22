//! The native View menu owns the choice shown by all file labels.
use crate::activity::{Activity, ActivityState};
use crate::commands::{
    prefs::{PrefsState, prefs_get_inner, prefs_set_inner},
    resolve_data_dir,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{
    App, AppHandle, Emitter, Manager, Runtime, State,
    menu::{CheckMenuItem, CheckMenuItemBuilder, Submenu, SubmenuBuilder},
};
use trunk_git::error::TrunkError;

const KEY: &str = "file_label_style";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Style {
    #[default]
    FilenameFirst,
    FullPath,
}

impl Style {
    fn load(dir: &Path, prefs: &PrefsState) -> Result<Self, TrunkError> {
        Ok(prefs_get_inner(dir, prefs, KEY)?
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default())
    }

    fn save(self, dir: &Path, prefs: &PrefsState) -> Result<(), TrunkError> {
        prefs_set_inner(dir, prefs, KEY.into(), serde_json::json!(self))
    }
}

struct Save {
    style: Style,
    revision: u64,
    _lease: Activity,
}

#[derive(Default)]
struct Selection {
    current: Style,
    revision: u64,
    writing: bool,
    pending: Option<Save>,
}

impl Selection {
    // The active writer takes the latest pending choice when its current write ends.
    fn choose(&mut self, style: Style, lease: Activity) -> Option<Save> {
        self.current = style;
        self.revision += 1;
        let save = Save {
            style,
            revision: self.revision,
            _lease: lease,
        };
        if self.writing {
            self.pending = Some(save);
            None
        } else {
            self.writing = true;
            Some(save)
        }
    }

    const fn next_save(&mut self) -> Option<Save> {
        let next = self.pending.take();
        self.writing = next.is_some();
        next
    }

    const fn restore_if_current(&mut self, revision: u64, saved: Style) -> bool {
        if self.revision != revision {
            return false;
        }
        self.current = saved;
        true
    }
}

#[derive(Default)]
pub struct FileLabels(Mutex<Selection>);

#[tauri::command]
pub fn get_file_label_style(
    _activity: crate::activity::Activity,
    labels: State<'_, FileLabels>,
) -> Style {
    labels.0.lock().unwrap().current
}

#[derive(Clone, Copy)]
enum Restore {
    Startup,
    FailedSave(u64),
}

struct Choices<R: Runtime> {
    filename: CheckMenuItem<R>,
    path: CheckMenuItem<R>,
}

impl<R: Runtime> Choices<R> {
    fn mark(&self, style: Style) {
        if let Err(error) = self
            .filename
            .set_checked(style == Style::FilenameFirst)
            .and_then(|()| self.path.set_checked(style == Style::FullPath))
        {
            eprintln!("could not mark the selected file label style: {error}");
        }
    }

    fn publish(&self, app: &AppHandle<R>, style: Style) {
        self.mark(style);
        if let Err(error) = app.emit("file-label-style-changed", style) {
            eprintln!("could not publish file label style: {error}");
        }
    }

    fn restore(self: &Arc<Self>, app: &AppHandle<R>, saved: Style, cause: Restore) {
        let choices = self.clone();
        let notifier = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let revision = match cause {
                Restore::Startup => 0,
                Restore::FailedSave(revision) => revision,
            };
            let applied = notifier
                .state::<FileLabels>()
                .0
                .lock()
                .unwrap()
                .restore_if_current(revision, saved);
            if applied {
                choices.publish(&notifier, saved);
                if matches!(cause, Restore::FailedSave(_))
                    && let Err(error) = notifier.emit("file-label-style-save-failed", ())
                {
                    eprintln!("could not publish file label save failure: {error}");
                }
            }
        }) {
            eprintln!("could not schedule file label restore: {error}");
        }
    }
}

fn saved_style<R: Runtime>(app: &AppHandle<R>) -> Style {
    resolve_data_dir(app)
        .and_then(|dir| Style::load(&dir, &app.state::<PrefsState>()).map_err(|e| e.to_json()))
        .unwrap_or_else(|error| {
            eprintln!("could not load file label style: {error}");
            Style::default()
        })
}

pub fn submenu<R: Runtime>(app: &App<R>) -> tauri::Result<Submenu<R>> {
    let choices = Arc::new(Choices {
        filename: CheckMenuItemBuilder::with_id("file-label-filename-first", "Filename First")
            .checked(true)
            .build(app)?,
        path: CheckMenuItemBuilder::with_id("file-label-full-path", "Full Path")
            .checked(false)
            .build(app)?,
    });
    let menu = SubmenuBuilder::new(app, "File Labels")
        .item(&choices.filename)
        .item(&choices.path)
        .build()?;

    // Update recovery can freeze preference access to preserve a damaged store.
    if let Ok(lease) = Activity::for_app(app.handle()) {
        let reader = app.handle().clone();
        let choices = choices.clone();
        lease.spawn_blocking(move || {
            choices.restore(&reader, saved_style(&reader), Restore::Startup);
        });
    }
    app.on_menu_event(move |app, event| {
        let requested = if event.id() == choices.filename.id() {
            Style::FilenameFirst
        } else if event.id() == choices.path.id() {
            Style::FullPath
        } else {
            return;
        };
        let labels = app.state::<FileLabels>();
        let Ok(lease) = app.state::<ActivityState>().acquire_preference_save() else {
            // Undo the native item's automatic toggle when a quit or update has frozen changes.
            let current = labels.0.lock().unwrap().current;
            choices.mark(current);
            return;
        };
        let first = labels.0.lock().unwrap().choose(requested, lease);
        choices.publish(app, requested);
        if let Some(first) = first {
            let app = app.clone();
            let choices = choices.clone();
            tauri::async_runtime::spawn_blocking(move || write_choices(&app, &choices, first));
        }
    });
    Ok(menu)
}

fn write_choices<R: Runtime>(app: &AppHandle<R>, choices: &Arc<Choices<R>>, mut save: Save) {
    let labels = app.state::<FileLabels>();
    loop {
        let result = resolve_data_dir(app).and_then(|dir| {
            save.style
                .save(&dir, &app.state::<PrefsState>())
                .map_err(|e| e.to_json())
        });
        let revision = save.revision;
        let rollback = result.err().map(|error| {
            eprintln!("could not save file label style: {error}");
            saved_style(app)
        });
        drop(save);
        if let Some(saved) = rollback {
            choices.restore(app, saved, Restore::FailedSave(revision));
        }
        let Some(next) = labels.0.lock().unwrap().next_save() else {
            return;
        };
        save = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_path_round_trips_through_the_preferences_file() {
        let dir = tempfile::tempdir().unwrap();
        Style::FullPath
            .save(dir.path(), &PrefsState::default())
            .unwrap();

        let reopened = PrefsState::default();
        assert_eq!(
            prefs_get_inner(dir.path(), &reopened, "file_label_style").unwrap(),
            Some("full-path".into())
        );
        assert_eq!(Style::load(dir.path(), &reopened).unwrap(), Style::FullPath);
    }

    #[test]
    fn only_the_latest_choice_waits_behind_an_active_save() {
        let gate = ActivityState::default();
        let lease = || gate.acquire_preference_save().unwrap();
        let mut labels = Selection::default();

        let active = labels.choose(Style::FullPath, lease()).unwrap();
        assert!(labels.choose(Style::FullPath, lease()).is_none());
        assert!(labels.choose(Style::FilenameFirst, lease()).is_none());

        assert!(!labels.restore_if_current(active.revision, Style::FullPath));
        assert_eq!(labels.current, Style::FilenameFirst);
        let latest = labels.next_save().unwrap();
        assert_eq!(latest.style, Style::FilenameFirst);
        assert!(labels.restore_if_current(latest.revision, Style::FullPath));
        assert_eq!(labels.current, Style::FullPath);
        assert!(labels.next_save().is_none());
    }
}
