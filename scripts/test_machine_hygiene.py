from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve().relative_to(ROOT).as_posix()


def tracked_sources():
    listed = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, check=True, capture_output=True, timeout=30).stdout
    for name in listed.decode().split('\0'):
        if name and name != SELF and not name.endswith('.md'):
            path = ROOT / name
            if path.is_file():
                yield name, path.read_bytes()


class MachineHygiene(unittest.TestCase):
    def test_no_tool_creates_a_virtual_display(self):
        users = [name for name, content in tracked_sources() if b'CGVirtualDisplay' in content]

        self.assertEqual(users, [], 'WindowServer keeps every virtual display it is shown until it restarts, with a '
                                    'backstop window and a color timer that stalls its main thread, and ColorSync, '
                                    'Spaces and the display preferences keep its identity after a reboot '
                                    '(scripts/diff-scroll/README.md)')


if __name__ == '__main__':
    unittest.main()
