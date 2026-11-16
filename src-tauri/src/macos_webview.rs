use objc2::rc::Retained;
use objc2::runtime::{AnyClass, NSObjectProtocol};
use objc2::{ClassType, MainThreadMarker, msg_send, sel};
use objc2_foundation::{NSArray, NSObject, NSString, NSUUID, ns_string};
use objc2_web_kit::{WKPreferences, WKWebViewConfiguration, WKWebsiteDataStore};
use tauri::utils::config::WindowConfig;

pub fn configure_main_window(
    builder: tauri::Builder<tauri::Wry>,
    mut context: tauri::Context<tauri::Wry>,
) -> (tauri::Builder<tauri::Wry>, tauri::Context<tauri::Wry>) {
    let windows = defer_startup_windows(&mut context.config_mut().app.windows);
    if windows.is_empty() {
        return (builder, context);
    }

    let builder = builder.setup(move |app| {
        let main = MainThreadMarker::new().expect("Tauri creates windows on the main thread");

        for window in &windows {
            let mut builder = tauri::WebviewWindowBuilder::from_config(app, window)?;

            if window.label == "main" {
                builder = builder.with_webview_configuration(native_configuration(main, window));
            }

            builder.build()?;
        }

        crate::setup_app(app)
    });

    (builder, context)
}

fn defer_startup_windows(windows: &mut [WindowConfig]) -> Vec<WindowConfig> {
    if !windows
        .iter()
        .any(|window| window.label == "main" && window.create)
    {
        return Vec::new();
    }

    let mut deferred = Vec::new();
    for window in windows.iter_mut().filter(|window| window.create) {
        deferred.push(window.clone());
        window.create = false;
    }

    deferred
}

fn native_configuration(
    main: MainThreadMarker,
    window: &WindowConfig,
) -> Retained<WKWebViewConfiguration> {
    // SAFETY: the marker confines WebKit objects to the main thread. Wry skips
    // data-store selection when given a configuration, so it must be set here.
    let configuration = unsafe {
        let configuration = WKWebViewConfiguration::new(main);

        if window.incognito {
            configuration.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(main));
        } else if let Some(identifier) = window.data_store_identifier
            && WKWebsiteDataStore::class()
                .class_method(sel!(dataStoreForIdentifier:))
                .is_some()
        {
            let identifier = NSUUID::from_bytes(identifier);
            configuration.setWebsiteDataStore(&WKWebsiteDataStore::dataStoreForIdentifier(
                &identifier,
                main,
            ));
        }

        configuration
    };

    // SAFETY: this retained configuration is live on the main thread. Its
    // preferences must be changed before WKWebView copies them at creation.
    let preferences = unsafe { configuration.preferences() };

    prefer_display_refresh_rate(&preferences);

    configuration
}

fn prefer_display_refresh_rate(preferences: &WKPreferences) {
    if !preferences.respondsToSelector(sel!(_setEnabled:forFeature:)) {
        return;
    }

    let Some(features) = available_features(WKPreferences::class()) else {
        return;
    };

    for feature in &features {
        if !feature.respondsToSelector(sel!(key)) {
            continue;
        }

        // SAFETY: WebKit's feature key selector returns an NSString. The object
        // remains retained by the feature array while both messages are sent.
        let key: Option<Retained<NSString>> = unsafe { msg_send![&feature, key] };
        if key.as_deref() == Some(ns_string!("PreferPageRenderingUpdatesNear60FPSEnabled")) {
            // SAFETY: the guarded preferences selector accepts BOOL and one of
            // the feature objects returned by the same WebKit class.
            let () = unsafe { msg_send![preferences, _setEnabled: false, forFeature: &*feature] };
            return;
        }
    }
}

fn available_features(preferences_class: &AnyClass) -> Option<Retained<NSArray<NSObject>>> {
    preferences_class.class_method(sel!(_features))?;

    // SAFETY: WebKit's checked class selector returns an NSArray of NSObject
    // subclasses. Classes without the selector return before sending a message.
    unsafe { msg_send![preferences_class, _features] }
}

#[cfg(test)]
mod tests {
    use super::{available_features, defer_startup_windows};
    use objc2::ClassType;
    use objc2_foundation::NSObject;
    use tauri::utils::config::WindowConfig;

    #[test]
    fn preserves_main_before_secondary_in_the_creation_order() {
        let mut windows = vec![
            WindowConfig::default(),
            WindowConfig {
                label: "secondary".into(),
                ..WindowConfig::default()
            },
        ];

        let deferred = defer_startup_windows(&mut windows);
        let order: Vec<_> = windows
            .iter()
            .filter(|window| window.create)
            .chain(deferred.iter())
            .map(|window| window.label.as_str())
            .collect();

        assert_eq!(order, ["main", "secondary"]);
    }

    #[test]
    fn preserves_the_main_window_configuration_for_manual_creation() {
        let main = WindowConfig {
            title: "Configured window".into(),
            width: 913.0,
            height: 617.0,
            visible: false,
            focus: false,
            incognito: true,
            accept_first_mouse: true,
            data_store_identifier: Some([7; 16]),
            ..WindowConfig::default()
        };
        let before = WindowConfig {
            label: "before".into(),
            ..WindowConfig::default()
        };
        let disabled = WindowConfig {
            label: "disabled".into(),
            create: false,
            ..WindowConfig::default()
        };
        let after = WindowConfig {
            label: "secondary".into(),
            ..WindowConfig::default()
        };
        let mut windows = vec![
            before.clone(),
            main.clone(),
            disabled.clone(),
            after.clone(),
        ];

        let deferred = defer_startup_windows(&mut windows);

        assert_eq!(deferred, [before.clone(), main.clone(), after.clone()]);
        assert_eq!(
            windows,
            [
                WindowConfig {
                    create: false,
                    ..before
                },
                WindowConfig {
                    create: false,
                    ..main
                },
                disabled,
                WindowConfig {
                    create: false,
                    ..after
                },
            ]
        );
    }

    #[test]
    fn leaves_an_explicitly_disabled_main_window_uncreated() {
        let mut windows = vec![
            WindowConfig {
                create: false,
                ..WindowConfig::default()
            },
            WindowConfig {
                label: "secondary".into(),
                ..WindowConfig::default()
            },
        ];
        let original = windows.clone();

        let deferred = defer_startup_windows(&mut windows);

        assert_eq!(deferred, Vec::<WindowConfig>::new());
        assert_eq!(windows, original);
    }

    #[test]
    fn leaves_other_windows_on_their_existing_creation_path() {
        let mut windows = vec![WindowConfig {
            label: "secondary".into(),
            ..WindowConfig::default()
        }];
        let original = windows.clone();

        let deferred = defer_startup_windows(&mut windows);

        assert_eq!(deferred, Vec::<WindowConfig>::new());
        assert_eq!(windows, original);
    }

    #[test]
    fn uses_the_fallback_when_the_feature_selector_is_absent() {
        assert!(available_features(NSObject::class()).is_none());
    }
}
