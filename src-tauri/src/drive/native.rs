//! The drive route's reach into `AppKit`: the window's pixels, the alert a
//! modal loop is showing, and the app's menu bar.
//!
//! Everything here runs through the main operation queue, which `AppKit` keeps
//! draining inside a modal loop. Tauri's own main-thread dispatch goes through
//! the event loop, which a modal loop stops, so it could not reach an alert.

use std::cell::OnceCell;
use std::ffi::CStr;
use std::path::Path;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{MainThreadMarker, Message, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSButton, NSImage, NSMenu, NSTextField,
    NSView, NSWindowWillBeginSheetNotification,
};
use objc2_foundation::{
    NSDictionary, NSError, NSNotification, NSNotificationCenter, NSOperationQueue, NSString,
};
use objc2_web_kit::WKWebView;
use serde_json::{Value, json};

/// How long a request may wait on the main thread before it is answered with a
/// failure, which is the answer a probe needs when the main thread is stuck.
const MAIN_DEADLINE: Duration = Duration::from_secs(10);

/// The page's `WKWebView`, as the address tauri reports. It lives as long as the
/// main window, which the app never closes while it runs.
#[derive(Clone, Copy)]
pub struct WebViewAddress(pub usize);

fn on_main<T: Send + 'static>(
    work: impl FnOnce(MainThreadMarker) -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    let work = Mutex::new(Some(work));
    // A request answered as failed must not run later, or a press the agent was
    // told failed would click the button after all.
    let abandoned = Arc::new(AtomicBool::new(false));
    let skip = Arc::clone(&abandoned);
    let block = RcBlock::new(move || {
        if skip.load(Ordering::SeqCst) {
            return;
        }
        let Some(work) = work.lock().expect("the work lock").take() else {
            return;
        };
        let main = MainThreadMarker::new().expect("the main queue runs on the main thread");
        let _ = sender.send(work(main));
    });

    // SAFETY: the block owns everything it touches and may run on any thread
    // the queue picks, which for the main queue is the main thread.
    unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&block) };
    receiver.recv_timeout(MAIN_DEADLINE).map_err(|_| {
        abandoned.store(true, Ordering::SeqCst);
        "the main thread did not run the request".to_string()
    })
}

/// Keeps the page drawing while other windows cover the drive window, which is
/// where the drive window always sits. `WebKit` otherwise reports a covered page
/// hidden and runs no animation frame, so a transition never finishes: an
/// element entering is drawn at its first frame, one leaving stays on the page,
/// and a snapshot shows neither as the user would see it.
pub fn keep_drawing_when_covered(webview: &WKWebView) -> Result<(), String> {
    let switch = sel!(_setWindowOcclusionDetectionEnabled:);
    if !webview.respondsToSelector(switch) {
        return Err("this WebKit has no _setWindowOcclusionDetectionEnabled:".to_string());
    }

    // SAFETY: WKWebView answered that it responds to this selector, which takes
    // one BOOL and returns nothing.
    let () = unsafe { msg_send![webview, _setWindowOcclusionDetectionEnabled: false] };
    Ok(())
}

/// Writes a PNG of what the page shows to `path`, and answers its size.
pub fn snapshot(webview: WebViewAddress, path: &Path) -> Result<Value, String> {
    let (sender, receiver) = mpsc::channel();
    on_main(move |_| {
        // SAFETY: the address is the live WKWebView, read on the main thread.
        let webview: &WKWebView = unsafe { &*(webview.0 as *const WKWebView) };
        let sender = Mutex::new(Some(sender));
        let done = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let Some(sender) = sender.lock().expect("the sender lock").take() else {
                return;
            };
            // SAFETY: WebKit passes either a live image or a live error.
            let result = match unsafe { (image.as_ref(), error.as_ref()) } {
                (Some(image), _) => png(image),
                (None, Some(error)) => Err(error.localizedDescription().to_string()),
                (None, None) => Err("WebKit returned no snapshot".into()),
            };
            let _ = sender.send(result);
        });
        // SAFETY: called on the main thread with a configuration of None, which
        // asks for the whole visible page.
        unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &done) };
    })?;

    let (bytes, width, height) = receiver
        .recv_timeout(MAIN_DEADLINE)
        .map_err(|_| "WebKit did not finish the snapshot".to_string())??;
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(json!({ "path": path, "width": width, "height": height }))
}

fn png(image: &NSImage) -> Result<(Vec<u8>, isize, isize), String> {
    let tiff = image
        .TIFFRepresentation()
        .ok_or("the snapshot has no bitmap")?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("the snapshot has no bitmap")?;
    // SAFETY: an empty property dictionary is a valid PNG encoding request.
    let data = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("the snapshot did not encode as PNG")?;

    Ok((data.to_vec(), bitmap.pixelsWide(), bitmap.pixelsHigh()))
}

/// Requests waiting for a dialog, released when a window begins a sheet.
static AWAITING_SHEET: Mutex<Vec<mpsc::Sender<()>>> = Mutex::new(Vec::new());

thread_local! {
    /// The observer that releases `AWAITING_SHEET`, registered on the main
    /// thread the first time a request waits, and kept for the app's life.
    static SHEET_OBSERVER: OnceCell<Retained<ProtocolObject<dyn NSObjectProtocol>>> =
        const { OnceCell::new() };
}

/// Returns once a dialog shows: at once when one is up, or else when a window
/// next begins a sheet, which is how the dialog plugin shows its message.
fn await_dialog() -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    on_main(move |main| {
        if showing_dialog(main).is_ok() {
            let _ = sender.send(());
            return;
        }

        SHEET_OBSERVER.with(|observer| {
            observer.get_or_init(observe_sheets);
        });
        AWAITING_SHEET
            .lock()
            .expect("the sheet waiters lock")
            .push(sender);
    })?;
    receiver
        .recv_timeout(MAIN_DEADLINE)
        .map_err(|_| "no dialog showed".to_string())
}

fn observe_sheets() -> Retained<ProtocolObject<dyn NSObjectProtocol>> {
    let release = RcBlock::new(|_: NonNull<NSNotification>| {
        for waiting in AWAITING_SHEET
            .lock()
            .expect("the sheet waiters lock")
            .drain(..)
        {
            let _ = waiting.send(());
        }
    });
    // SAFETY: the name is AppKit's own constant, no object filters it, and the
    // block runs on the main queue, where it touches only the waiters' lock.
    unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowWillBeginSheetNotification),
            None,
            Some(&NSOperationQueue::mainQueue()),
            &release,
        )
    }
}

/// The texts and button titles of the dialog the app is showing, or of the
/// one it shows next, waiting up to the main thread's deadline for it.
pub fn alert() -> Result<Value, String> {
    await_dialog()?;
    on_main(|main| {
        let content = showing_dialog(main)?;

        let mut texts = Vec::new();
        let mut buttons = Vec::new();
        for view in descendants(&content) {
            if let Some(button) = view.downcast_ref::<NSButton>() {
                buttons.push(button.title().to_string());
            } else if let Some(field) = view.downcast_ref::<NSTextField>() {
                texts.push(field.stringValue().to_string());
            }
        }
        Ok(json!({ "texts": texts, "buttons": buttons }))
    })?
}

/// Presses the showing dialog's button titled `title`.
pub fn press(title: String) -> Result<Value, String> {
    on_main(move |main| {
        let content = showing_dialog(main)?;

        let button = descendants(&content)
            .into_iter()
            .find_map(|view| {
                view.downcast_ref::<NSButton>()
                    .filter(|button| button.title().to_string() == title)
                    .map(Message::retain)
            })
            .ok_or_else(|| format!("no button titled {title}"))?;
        // SAFETY: a click with no sender is what a key equivalent sends.
        unsafe { button.performClick(None) };
        Ok(Value::Null)
    })?
}

/// Chooses the menu bar item `path` names, one title per level from the bar
/// down, through the action its `NSMenuItem` sends, so the item does what a
/// click on it does without the menu being drawn.
pub fn choose_menu_bar(path: Vec<String>) -> Result<Value, String> {
    on_main(move |main| {
        let (title, parents) = path
            .split_last()
            .ok_or("name the menu bar item to choose")?;
        let mut menu = NSApplication::sharedApplication(main)
            .mainMenu()
            .ok_or("the app has no menu bar")?;
        for parent in parents {
            menu = submenu(&menu, parent)?;
        }

        // Validation sets each item's enabled state, as opening the menu would.
        menu.update();
        let index = menu.indexOfItemWithTitle(&NSString::from_str(title));
        // AppKit raises, and the app aborts, on an index outside the menu.
        let item = (index >= 0)
            .then(|| menu.itemAtIndex(index))
            .flatten()
            .ok_or_else(|| format!("no menu bar item titled {title}"))?;
        if !item.isEnabled() {
            return Err(format!("the menu bar item titled {title} is disabled"));
        }
        if item.hasSubmenu() {
            return Err(format!(
                "{title} opens a submenu; name one of its items too"
            ));
        }
        if let Some(action) = item
            .action()
            .filter(|action| ON_SCREEN.contains(&action.name()))
        {
            return Err(format!(
                "{title} acts on the screen ({}), which the drive route never does",
                action.name().to_string_lossy()
            ));
        }

        menu.performActionForItemAtIndex(index);
        Ok(Value::Null)
    })?
}

/// The actions of the standard menu items (muda-0.20.0
/// `platform_impl/macos/mod.rs`, `PredefinedMenuItemType`) that draw a window,
/// move one, or show or hide other apps, on the operator's screen.
const ON_SCREEN: [&CStr; 10] = [
    c"customShowAboutPanel:",
    c"toggleFullScreen:",
    c"performMiniaturize:",
    c"performZoom:",
    c"arrangeInFront:",
    c"hide:",
    c"hideOtherApplications:",
    c"unhideAllApplications:",
    c"orderFrontCharacterPalette:",
    c"startDictation:",
];

fn submenu(menu: &NSMenu, title: &str) -> Result<Retained<NSMenu>, String> {
    menu.update();
    let item = menu
        .itemWithTitle(&NSString::from_str(title))
        .ok_or_else(|| format!("no menu bar item titled {title}"))?;
    if !item.isEnabled() {
        return Err(format!("the menu bar item titled {title} is disabled"));
    }

    item.submenu()
        .ok_or_else(|| format!("{title} has no submenu"))
}

/// The content of the dialog on screen: the window a modal loop runs, or else
/// a sheet attached to one of the app's windows, which is how the dialog
/// plugin's asynchronous message dialog shows without a modal loop.
fn showing_dialog(main: MainThreadMarker) -> Result<Retained<NSView>, String> {
    let app = NSApplication::sharedApplication(main);
    let window = app
        .modalWindow()
        .or_else(|| {
            app.windows()
                .iter()
                .find_map(|window| window.attachedSheet())
        })
        .ok_or("no dialog is showing")?;

    window
        .contentView()
        .ok_or_else(|| "the dialog is empty".into())
}

fn descendants(root: &NSView) -> Vec<Retained<NSView>> {
    let mut found = Vec::new();
    let mut pending = vec![root.retain()];
    while let Some(view) = pending.pop() {
        pending.extend(view.subviews().iter());
        found.push(view);
    }
    found
}
