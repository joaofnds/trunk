from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve().relative_to(ROOT).as_posix()

DISPLAY_CONFIGURATION = 'macOS keeps the arrangement and modes a tool gives a display after the tool exits'
COLORSYNC = 'ColorSync keeps every device registered with it, and the profiles it was given, across reboots'
SYSTEM_SETTING = 'a system setting a tool changes stays changed after the tool exits'
GLOBAL_GIT = 'git configuration outside the repository changes git for every repository the user has'

LASTING_STATE = {
    'CGVirtualDisplay': 'WindowServer keeps every virtual display it is shown until it restarts, with a backstop window '
                        'and a color timer that stalls its main thread, and ColorSync, Spaces and the display '
                        'preferences keep its identity after a reboot (scripts/diff-scroll/README.md)',
    'CGBeginDisplayConfiguration': DISPLAY_CONFIGURATION,
    'CGConfigureDisplay': DISPLAY_CONFIGURATION,
    'CGDisplaySetDisplayMode': DISPLAY_CONFIGURATION,
    'ColorSyncRegisterDevice': COLORSYNC,
    'ColorSyncDeviceSetCustomProfiles': COLORSYNC,
    'lsregister': 'LaunchServices keeps a registration after its bundle is gone',
    'hdiutil attach': 'a disk image stays mounted after the tool exits, and LaunchServices records every app on it',
    'launchctl': 'a launch agent a tool loads outlives the tool and starts again at every login',
    'tccutil': 'tccutil withdraws privacy permissions the user granted, and only the user can grant them again',
    'defaults write': 'a preference a tool writes stays in the user\'s preferences after the tool exits',
    'defaults delete': 'a preference a tool deletes is gone from the user\'s preferences for good',
    'pmset': SYSTEM_SETTING,
    'systemsetup': SYSTEM_SETTING,
    'networksetup': SYSTEM_SETTING,
    'killall': 'killall stops every process with the name, the installed Trunk the user is running included',
    'config --global': GLOBAL_GIT,
    'config --system': GLOBAL_GIT,
}


def tracked_sources():
    listed = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, check=True, capture_output=True, timeout=30).stdout
    for name in listed.decode().split('\0'):
        if name and name != SELF and not name.endswith('.md'):
            path = ROOT / name
            if path.is_file():
                yield name, path.read_bytes()


class MachineHygiene(unittest.TestCase):
    def test_no_tool_leaves_machine_state_that_outlives_it(self):
        sources = list(tracked_sources())
        for call, consequence in LASTING_STATE.items():
            with self.subTest(call):
                users = [name for name, content in sources if call.encode() in content]

                self.assertEqual(users, [], consequence)


if __name__ == '__main__':
    unittest.main()
