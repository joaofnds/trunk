// Prints one line for each application that becomes active, until killed:
// `<seconds since epoch> <pid> <name>`. The drive route's launch-focus check
// runs it across a whole drive session (scripts/drive/smoke.ts and native.ts, just drive-smoke and drive-native).
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)
print("\(Date().timeIntervalSince1970) start \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "none")")

NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
) { note in
    let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    print("\(Date().timeIntervalSince1970) \(app?.processIdentifier ?? -1) \(app?.localizedName ?? "unknown")")
}

RunLoop.main.run()
