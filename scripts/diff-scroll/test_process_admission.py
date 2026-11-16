import json
from pathlib import Path
import tempfile
import unittest

from analysis import Inconclusive
from process_admission import classify_inventory, measurement_window


OBSERVED = '''15466   0.0 /Users/joaofnds/.local/share/mise/installs/just/1.59.0/just
16193   0.0 /Users/joaofnds/.rustup/toolchains/1.98.0-aarch64-apple-darwin/bin/cargo
18281  89.8 /Users/joaofnds/code/flightdeck/target/debug/deps/persistence-f842c378851be8ca
25280   4.3 /Users/joaofnds/code/flightdeck/target/debug/deps/persistence-f842c378851be8ca
81344   0.0 /Users/joaofnds/code/flightdeck/desktop/target/Flightdeck.app/Contents/Helpers/persister
'''
CLEAN = {'comm': '10 0.0 /Applications/Flightdeck.app/Contents/Helpers/persister\n', 'args': ''}
BUSY = {'comm': OBSERVED, 'args': ''}


class InventoryFake:
    def __init__(self, *snapshots):
        self.snapshots = iter(snapshots)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        value = next(self.snapshots)
        if isinstance(value, Exception):
            raise value

        return value


class InventoryClassification(unittest.TestCase):
    def test_rejects_the_observed_competing_tests_and_build_commands(self):
        rejected = classify_inventory(BUSY)

        self.assertEqual([process['pid'] for process in rejected], [15466, 16193, 18281, 25280])
        self.assertEqual(rejected[2]['comm'], '/Users/joaofnds/code/flightdeck/target/debug/deps/persistence-f842c378851be8ca')

    def test_accepts_the_production_persister_and_paths_with_spaces(self):
        inventory = {'comm': '10 0.0 /Applications/Flightdeck Preview.app/Contents/Helpers/persister\n', 'args': ''}

        self.assertEqual(classify_inventory(inventory), [])

    def test_ignores_commands_mentioned_by_shells_and_ordinary_node_agents(self):
        inventory = {'comm': '10 0.0 /bin/zsh\n11 0.0 /usr/local/bin/node\n',
                     'args': '10 /bin/zsh -c "echo cargo test and vitest"\n11 node /agents/worker.js cargo test\n'}

        self.assertEqual(classify_inventory(inventory), [])

    def test_recognizes_compiler_and_test_executables(self):
        for name in ['cargo-nextest', 'nextest', 'rustc', 'clang', 'clang++', 'gcc-14', 'swiftc', 'swift-frontend',
                     'xcodebuild', 'ninja', 'esbuild', 'vitest', 'jest', 'pytest']:
            with self.subTest(name=name):
                self.assertEqual(len(classify_inventory({'comm': f'10 0.0 /tools/{name}\n', 'args': ''})), 1)

    def test_recognizes_frontend_tests_run_by_interpreters(self):
        for command in ['node /repo/node_modules/vitest/vitest.mjs run', 'node --test test.js',
                        'bun test', 'bun run build', 'node /tools/npm-cli.js test', 'python3 -m pytest']:
            with self.subTest(command=command):
                executable = command.split()[0]
                rejected = classify_inventory({'comm': f'10 0.0 /tools/{executable}\n', 'args': f'10 {command}\n'})
                self.assertEqual(len(rejected), 1)

    def test_recognizes_python_test_modules_after_interpreter_options(self):
        for command in ['python3 -B -m unittest discover', 'python3 -I -X dev -W ignore -m pytest',
                        'python3 --check-hash-based-pycs always -m unittest', 'python3 -Xdev -Wignore -m pytest']:
            with self.subTest(command=command):
                rejected = classify_inventory({'comm': '10 0.0 /tools/python3\n', 'args': f'10 {command}\n'})

                self.assertEqual(len(rejected), 1)

    def test_ignores_test_words_after_python_script_or_inline_code(self):
        for command in ["python3 -B -c 'print(1)' -m pytest", 'python3 -B agent.py -m pytest',
                        'python3 -- -m unittest', 'python3 -W-m -X dev agent.py']:
            with self.subTest(command=command):
                self.assertEqual(classify_inventory({'comm': '10 0.0 /tools/python3\n', 'args': f'10 {command}\n'}), [])

    def test_refuses_the_ps_marker_for_unavailable_arguments(self):
        with self.assertRaises(Inconclusive):
            classify_inventory({'comm': '10 0.0 /tools/node\n', 'args': '10 [node]\n'})

    def test_refuses_empty_or_malformed_executable_inventories(self):
        for comm in ['', 'unparseable process\n', '10 nan /tools/node\n']:
            with self.subTest(comm=comm), self.assertRaises(Inconclusive):
                classify_inventory({'comm': comm, 'args': ''})

    def test_refuses_missing_argument_evidence_for_a_present_interpreter(self):
        with self.assertRaises(Inconclusive):
            classify_inventory({'comm': '10 0.0 /tools/node\n', 'args': ''})


class MeasurementAdmission(unittest.TestCase):
    def test_refuses_entry_and_preserves_the_full_inventory(self):
        inventory = InventoryFake(BUSY)
        entered = []
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                with measurement_window(output, snapshot=inventory):
                    entered.append(True)
            evidence = json.loads((output / 'process-admission.json').read_text())

        self.assertEqual(entered, [])
        self.assertEqual(evidence['entry']['inventory'], {'comm': OBSERVED})
        self.assertEqual(evidence['entry']['verdict'], 'rejected')
        self.assertIn('reason', evidence['entry'])
        self.assertEqual(inventory.calls, 1)

    def test_refuses_exit_without_deleting_measurement_evidence(self):
        inventory = InventoryFake(CLEAN, BUSY)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                with measurement_window(output, snapshot=inventory):
                    (output / 'capture.mov').write_bytes(b'finished capture')
            evidence = json.loads((output / 'process-admission.json').read_text())
            movie = (output / 'capture.mov').read_bytes()

        self.assertEqual(movie, b'finished capture')
        self.assertEqual(evidence['entry']['verdict'], 'admitted')
        self.assertEqual(evidence['exit']['inventory'], {'comm': OBSERVED})
        self.assertEqual(evidence['exit']['verdict'], 'rejected')

    def test_records_exit_even_when_the_measurement_fails(self):
        failure = OSError('input failed')
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(OSError) as caught:
                with measurement_window(output, snapshot=InventoryFake(CLEAN, BUSY)):
                    raise failure
            evidence = json.loads((output / 'process-admission.json').read_text())

        self.assertIs(caught.exception, failure)
        self.assertEqual(evidence['exit']['verdict'], 'rejected')

    def test_fails_closed_and_records_inventory_collection_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                with measurement_window(output, snapshot=InventoryFake(OSError('ps unavailable'))):
                    self.fail('measurement was admitted')
            evidence = json.loads((output / 'process-admission.json').read_text())

        self.assertEqual(evidence['entry']['verdict'], 'rejected')
        self.assertIn('ps unavailable', evidence['entry']['reason'])

    def test_refuses_a_partial_inventory_returned_after_collection_failure(self):
        inventory = {'comm': CLEAN['comm'], 'collection_error': 'ps args failed'}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                with measurement_window(output, snapshot=InventoryFake(inventory)):
                    self.fail('partial inventory was admitted')
            evidence = json.loads((output / 'process-admission.json').read_text())

        self.assertEqual(evidence['entry']['inventory'], inventory)
        self.assertEqual(evidence['entry']['verdict'], 'rejected')

    def test_reports_exit_evidence_failure_without_replacing_the_measurement_error(self):
        failure = OSError('input failed')
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'run'
            output.mkdir()
            preserved = Path(temporary) / 'preserved'

            with self.assertRaises(OSError) as caught:
                with measurement_window(output, snapshot=InventoryFake(CLEAN, CLEAN)):
                    output.rename(preserved)
                    output.write_text('output directory became unavailable')
                    raise failure
            evidence = json.loads((preserved / 'process-admission.json').read_text())

        self.assertIs(caught.exception, failure)
        self.assertIn('NotADirectoryError', '\n'.join(caught.exception.__notes__))
        self.assertEqual(evidence['entry']['verdict'], 'admitted')

    def test_retains_only_normalized_workload_evidence_from_arguments(self):
        inventory = {'comm': '10 0.0 /tools/bun\n11 0.0 /tools/node\n',
                     'args': '10 bun test --token private-test-token\n11 node /agent.js --token private-agent-token\n'}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                with measurement_window(output, snapshot=InventoryFake(inventory)):
                    self.fail('measurement was admitted')
            raw = (output / 'process-admission.json').read_text()
            evidence = json.loads(raw)

        self.assertEqual(evidence['entry']['competing'][0]['reason'], 'interpreter workload: bun test')
        self.assertNotIn('private-test-token', raw)
        self.assertNotIn('private-agent-token', raw)
        self.assertNotIn('args', evidence['entry']['inventory'])


if __name__ == '__main__':
    unittest.main()
