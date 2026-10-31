//! The drive instance's socket files: the socket an agent's commands reach the
//! running app on, and the `listening` file that says it accepts connections.
//! They hold no `AppKit`, so the suite runs their tests without the drive build.

use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

const SOCKET: &str = "drive.sock";
/// Created once the socket accepts connections. A socket's own creation raises
/// no file event the launcher's watcher sees, and a renamed file does.
const LISTENING: &str = "listening";

/// Binds the instance's socket in `dir`. A quit or crashed instance leaves its
/// socket file behind, which would refuse a relaunch into the same directory,
/// so a file nobody answers on is removed first. It also leaves its `listening`
/// announcement, which would tell a launcher the new instance is ready before
/// it binds, so that goes too. One a live instance answers on is refused, since
/// two instances would share a directory.
pub fn bind(dir: &Path) -> Result<UnixListener, String> {
    let path = &dir.join(SOCKET);
    if UnixStream::connect(path).is_ok() {
        return Err(format!(
            "another instance is listening on {}",
            path.display()
        ));
    }

    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove the leftover drive socket: {e}")),
    }
    match std::fs::remove_file(dir.join(LISTENING)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("withdraw the leftover announcement: {e}")),
    }

    UnixListener::bind(path).map_err(|e| format!("bind the drive socket: {e}"))
}

pub fn announce_listening(dir: &Path) -> Result<(), String> {
    let staged = dir.join(format!("{LISTENING}.tmp"));
    std::fs::write(&staged, std::process::id().to_string())
        .and_then(|()| std::fs::rename(&staged, dir.join(LISTENING)))
        .map_err(|e| format!("announce the drive socket: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_over_the_socket_a_quit_instance_left_behind() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(SOCKET);
        drop(UnixListener::bind(&path).unwrap());

        let listener = bind(dir.path());

        assert!(listener.is_ok(), "got {:?}", listener.err());
    }

    #[test]
    fn withdraws_the_announcement_a_quit_instance_left_behind() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(LISTENING), "1").unwrap();

        let listener = bind(dir.path());

        assert!(listener.is_ok(), "got {:?}", listener.err());
        assert!(!dir.path().join(LISTENING).exists());
    }

    #[test]
    fn refuses_a_socket_a_live_instance_answers_on() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(SOCKET);
        let _live = UnixListener::bind(&path).unwrap();

        assert!(bind(dir.path()).is_err());
    }
}
