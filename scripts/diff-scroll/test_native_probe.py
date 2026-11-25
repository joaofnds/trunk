from pathlib import Path
import re
import unittest

SOURCE = (Path(__file__).parent / 'native-probe.m').read_text()


class VirtualDisplayIdentity(unittest.TestCase):
    def test_registers_every_run_under_one_literal_serial_number(self):
        assigned = re.findall(r'\.serialNum\s*=\s*([^;]+);', SOURCE)

        self.assertEqual(len(assigned), 1, 'the probe sets the virtual display serial in exactly one place')
        name = assigned[0].strip()
        self.assertRegex(name, r'^[A-Za-z_]\w*$',
                         'macOS keeps every display identity it has seen, so a serial computed per run '
                         '(from the pid, the clock or a random source) leaks one display per run')
        self.assertRegex(SOURCE, rf'static const unsigned int {name} = (?:0x[0-9A-Fa-f]+|\d+);')


if __name__ == '__main__':
    unittest.main()
