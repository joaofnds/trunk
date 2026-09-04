//! Centers the macOS traffic-light buttons in Trunk's top bar.
//!
//! Tauri/wry honor the configured inset only at window creation; `AppKit` then
//! relayouts the buttons back to the default top position on window-state
//! restore, resize, or appearance change, and Tauri 2.10 exposes no runtime
//! setter. So we grow the title-bar container ourselves so the buttons drop to
//! the bar's vertical center.
//!
//! Resize is special: `AppKit` resets the buttons on every step of a live resize,
//! and Tauri's `Resized` event arrives a frame too late to correct it without a
//! visible flash. So we observe `NSWindowDidResizeNotification` directly and
//! re-inset inside `AppKit`'s own resize pass (see `observe_resize`).
//!
//! The bar is `--topbar-h` (44px) of webview CSS, so its on-screen height scales
//! with the webview zoom; the frontend reports the zoom via `set_zoom`.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowDidResizeNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter};

/// `--topbar-h` in CSS px; the on-screen bar is this tall times the webview zoom.
const BAR_HEIGHT: f64 = 44.0;
/// Logical x inset of the close button from the window's left edge.
const INSET_X: f64 = 19.0;

/// Current webview zoom, as f64 bits. A plain atomic (not Tauri-managed state)
/// so the resize observer's Objective-C block can read it without capturing.
static ZOOM_BITS: AtomicU64 = AtomicU64::new(1.0f64.to_bits());

/// Report the current webview zoom factor (called from the frontend on change).
pub fn set_zoom(zoom: f64) {
    ZOOM_BITS.store(zoom.to_bits(), Ordering::Relaxed);
}

fn bar_height() -> f64 {
    BAR_HEIGHT * f64::from_bits(ZOOM_BITS.load(Ordering::Relaxed))
}

/// `ns_window` is the pointer from Tauri's `WebviewWindow`/`Window::ns_window()`.
pub fn reposition(ns_window: *mut c_void) {
    let ptr = ns_window.cast::<NSWindow>();
    if ptr.is_null() {
        return;
    }

    // SAFETY: `ptr` is a live NSWindow owned by Tauri for the window's lifetime, and
    // every caller runs on the main thread. `retain` takes a +1 that `Retained`'s Drop
    // balances, leaving Tauri's own reference intact (no over-release).
    let Some(window) = (unsafe { Retained::retain(ptr) }) else {
        return;
    };

    inset(&window, bar_height());
}

/// Re-apply the inset inside `AppKit`'s resize pass so the buttons never flash to
/// their default position during a live resize. Registered once; the observer
/// lives for the process lifetime.
pub fn observe_resize() {
    let block = RcBlock::new(|notification: NonNull<NSNotification>| {
        // SAFETY: AppKit hands us a valid notification on the main thread; its
        // `object` is the NSWindow that resized.
        let notification = unsafe { notification.as_ref() };
        if let Some(window) = notification.object() {
            reposition(&raw const *window as *mut c_void);
        }
    });

    // SAFETY: main-thread registration on the default center; the block captures
    // nothing. The observer token is leaked deliberately — it must outlive every
    // resize and is never removed.
    let token = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidResizeNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(token);
}

fn inset(window: &NSWindow, bar_height: f64) {
    let (Some(close), Some(miniaturize), Some(zoom)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else {
        return;
    };

    // SAFETY: main-thread only; the close button is a live subview of AppKit's
    // title-bar container, reached via the same two superview hops tao uses.
    let Some(title_bar) = (unsafe { close.superview().and_then(|v| v.superview()) }) else {
        return;
    };

    // The buttons keep their default offset within the container, so growing the
    // (top-anchored) container lowers them. To center a button of height `h` in a
    // `bar_height`-tall bar, the container must be `(bar_height + h)/2 + offset`,
    // where `offset` is the button's measured baseline within the container.
    let close_rect = close.frame();
    let button_offset = close_rect.origin.y;
    let mut title_bar_rect = title_bar.frame();
    title_bar_rect.size.height = f64::midpoint(bar_height, close_rect.size.height) + button_offset;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_rect.size.height;
    title_bar.setFrame(title_bar_rect);

    let space_between = miniaturize.frame().origin.x - close_rect.origin.x;
    for (i, button) in [close, miniaturize, zoom].into_iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = (i as f64).mul_add(space_between, INSET_X);
        button.setFrameOrigin(origin);
    }
}
