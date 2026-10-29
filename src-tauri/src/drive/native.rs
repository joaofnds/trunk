//! The drive route's reach into `AppKit`: the window's pixels and the alert a
//! modal loop is showing.
//!
//! Everything here runs through the main operation queue, which `AppKit` keeps
//! draining inside a modal loop. Tauri's own main-thread dispatch goes through
//! the event loop, which a modal loop stops, so it could not reach an alert.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, Message};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSButton, NSImage, NSTextField, NSView,
};
use objc2_foundation::{NSDictionary, NSError, NSOperationQueue};
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

/// The texts and button titles of the dialog the app is showing.
pub fn alert() -> Result<Value, String> {
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
