from pathlib import Path
import subprocess
import tomllib
import unittest

ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve().relative_to(ROOT).as_posix()

DISPLAY_CONFIGURATION = 'macOS keeps the arrangement and modes a tool gives a display after the tool exits'
COLORSYNC = 'ColorSync keeps every device registered with it, and the profiles it was given, across reboots'
SYSTEM_SETTING = 'a system setting a tool changes stays changed after the tool exits'
GLOBAL_GIT = 'git configuration outside the repository changes git for every repository the user has'
DEBUG_INFO = ('on macOS rustc keeps a build\'s object files for their debug info, under new names at every build, '
              'and deletes none, so the target grows without bound')

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


def debug_settings(profiles):
    settings = {}
    for name, profile in profiles.items():
        overrides = {f'{name}.package.{package}': table for package, table in profile.get('package', {}).items()}
        overrides[f'{name}.build-override'] = profile.get('build-override', {})
        for table_name, table in [(name, profile), *overrides.items()]:
            if 'debug' in table:
                settings[table_name] = table['debug']

    return settings


class MachineHygiene(unittest.TestCase):
    def test_no_tool_leaves_machine_state_that_outlives_it(self):
        sources = list(tracked_sources())
        for call, consequence in LASTING_STATE.items():
            with self.subTest(call):
                users = [name for name, content in sources if call.encode() in content]

                self.assertEqual(users, [], consequence)

    def test_no_build_makes_debug_info(self):
        profiles = tomllib.loads((ROOT / 'src-tauri' / 'Cargo.toml').read_text()).get('profile', {})

        settings = debug_settings(profiles)

        self.assertIs(settings.get('dev'), False, DEBUG_INFO)
        self.assertEqual({name: value for name, value in settings.items() if value is not False}, {}, DEBUG_INFO)

    def test_debug_settings_reads_overrides_and_every_profile(self):
        profiles = {'dev': {'debug': False, 'debug-assertions': True, 'package': {'git': {'debug': True}}},
                    'test': {'debug': 1, 'build-override': {'debug': 'line-tables-only'}}}

        settings = debug_settings(profiles)

        self.assertEqual(settings, {'dev': False, 'dev.package.git': True, 'test': 1,
                                    'test.build-override': 'line-tables-only'})


if __name__ == '__main__':
    unittest.main()
