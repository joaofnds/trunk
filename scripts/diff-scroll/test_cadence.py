from contextlib import redirect_stderr
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import zlib

from analysis import Inconclusive
from cadence import freeze_harness, frozen_harness, load_resource_runtime, parse_args, parser, prepare_display, prepare_viewport, resource_run, run, sha256, trace
from fixture import create_fixture
from native_runner_test_support import HostFake, NativeDriverFake, trial_arguments
from test_process_admission import BUSY, CLEAN, InventoryFake


def commit_chain(repository, head):
    commits = []
    while head:
        raw = zlib.decompress((repository / '.git/objects' / head[:2] / head[2:]).read_bytes())
        content = raw.split(b'\0', 1)[1].decode()
        commits.append(content)
        parents = [line.removeprefix('parent ') for line in content.splitlines() if line.startswith('parent ')]
        head = parents[0] if parents else None

    return commits


class CadenceFixture(unittest.TestCase):
    def test_preserves_the_original_two_commit_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary) / 'repo'
            head = create_fixture(repository, 3)
            commits = commit_chain(repository, head)

        self.assertEqual(len(commits), 2)
        self.assertTrue(commits[-1].endswith('\nempty fixture\n'))

    def test_adds_the_requested_bounded_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary) / 'repo'
            head = create_fixture(repository, 3, history=400)
            commits = commit_chain(repository, head)

        self.assertEqual(len(commits), 401)
        self.assertTrue(commits[-1].endswith('\nhistory row 0000\n'))

    def test_refuses_an_unbounded_history_before_creating_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary) / 'repo'
            with self.assertRaises(ValueError):
                create_fixture(repository, 3, history=401)

            self.assertFalse(repository.exists())


class CadenceRunner(unittest.TestCase):
    def test_production_loader_uses_the_frozen_guard_instead_of_the_live_guard(self):
        host, driver = HostFake(), NativeDriverFake()
        with tempfile.TemporaryDirectory() as temporary:
            args = trial_arguments(Path(temporary))
            hashes = freeze_harness(args.output)
            guard_path = args.output / 'harness/diff-scroll/process_admission.py'
            self.assertEqual(hashes['diff-scroll/process_admission.py'], sha256(guard_path))
            guard_path.write_text(guard_path.read_text() + '''
def classify_inventory(inventory):
    return [{'pid': 99, 'comm': '/frozen-only-workload', 'reason': 'frozen guard'}]
''')
            hashes['diff-scroll/process_admission.py'] = sha256(guard_path)

            with frozen_harness(args.output) as (frozen, analysis):
                with self.assertRaises((Inconclusive, frozen.runtime.Inconclusive)):
                    frozen.run(args, hashes, host=host, driver=driver, snapshot=InventoryFake(CLEAN))

            self.assertEqual(driver.recorder_starts, 0)
            evidence = json.loads((args.output / 'process-admission.json').read_text())
            self.assertEqual(evidence['entry']['competing'][0]['comm'], '/frozen-only-workload')
            self.assertEqual(host.app.returncode, 0)

    def test_cadence_entry_rejects_busy_inventory_before_starting_the_recorder(self):
        host, driver = HostFake(), NativeDriverFake()
        with tempfile.TemporaryDirectory() as temporary:
            args = trial_arguments(Path(temporary))

            with self.assertRaises(Inconclusive):
                run(args, {}, host=host, driver=driver, snapshot=InventoryFake(BUSY))

            self.assertEqual(driver.recorder_starts, 0)
            evidence = json.loads((args.output / 'process-admission.json').read_text())
            self.assertEqual(evidence['entry']['verdict'], 'rejected')
            self.assertTrue(json.loads((args.output / 'manifest.json').read_text())['process_admission_required'])
            self.assertEqual(host.app.returncode, 0)

    def test_defaults_to_a_virtual_display(self):
        arguments = parse_args(['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                                '--mode', 'diff', '--refresh-rate', '60', '--resources'])

        self.assertEqual(arguments.display, 'virtual')

    def test_accepts_an_explicit_main_display(self):
        arguments = parse_args(['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                                '--mode', 'diff', '--refresh-rate', '60', '--display', 'main', '--resources'])

        self.assertEqual(arguments.display, 'main')

    def test_keeps_four_1200_pixel_gestures_inside_3800_milliseconds(self):
        events = trace({'left': 100, 'top': 50, 'width': 400, 'height': 300})

        self.assertEqual(len(events), 404)
        self.assertEqual(events[-1]['atMs'], 3800)
        self.assertEqual(sum(event['dy'] for event in events), 0)
        self.assertEqual(sum(abs(event['dy']) for event in events), 4800)
        self.assertEqual(events[100], {'atMs': 800, 'x': 300, 'y': 200, 'dy': 0, 'phase': 4, 'momentum': 0})

    def test_requires_an_explicit_resource_or_capture_mode(self):
        arguments = parser().parse_args(['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                                         '--mode', 'diff', '--refresh-rate', '60', '--resources'])

        self.assertTrue(arguments.resources)
        self.assertIsNone(arguments.recorder)

    def test_rejects_a_run_without_a_measurement_mode(self):
        arguments = ['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                     '--mode', 'diff', '--refresh-rate', '60']

        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            parser().parse_args(arguments)

        self.assertEqual(error.exception.code, 2)

    def test_rejects_capture_and_resources_in_the_same_run(self):
        arguments = ['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                     '--mode', 'diff', '--refresh-rate', '60', '--resources', '--recorder', '/capture']

        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            parser().parse_args(arguments)

        self.assertEqual(error.exception.code, 2)

    def test_resource_import_keeps_the_diff_runner_module(self):
        import run
        original_path = list(sys.path)

        resource = load_resource_runtime()

        self.assertIs(sys.modules['run'], run)
        self.assertEqual(sys.path, original_path)
        self.assertEqual(Path(resource.create_fixture.__code__.co_filename).parent.name, 'interaction-performance')
        self.assertTrue(callable(resource.snapshot))

    def test_accepts_geometry_for_the_diff_viewport(self):
        arguments = parse_args(['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                                '--mode', 'diff', '--refresh-rate', '120', '--geometry'])

        self.assertTrue(arguments.geometry)
        self.assertFalse(arguments.resources)
        self.assertIsNone(arguments.recorder)

    def test_rejects_geometry_for_the_graph_viewport(self):
        arguments = ['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                     '--mode', 'graph', '--refresh-rate', '120', '--geometry']

        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            parse_args(arguments)

        self.assertEqual(error.exception.code, 2)

    def test_rejects_geometry_with_a_recorder(self):
        arguments = ['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                     '--mode', 'diff', '--refresh-rate', '120', '--geometry', '--recorder', '/capture']

        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            parse_args(arguments)

        self.assertEqual(error.exception.code, 2)

    def test_rejects_geometry_with_resource_measurement(self):
        arguments = ['--binary', '/app', '--native-probe', '/probe', '--output', '/out',
                     '--mode', 'diff', '--refresh-rate', '120', '--geometry', '--resources']

        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            parse_args(arguments)

        self.assertEqual(error.exception.code, 2)


class NativeDriverStub:
    def __init__(self, failure=''):
        self.failure = failure

    def request(self, directory, body, native=False):
        if body['op'] == self.failure:
            raise OSError('native probe failed')

        if body['op'] == 'processes':
            return {'host': 7, 'web': 8, 'gpu': 9}

        return {'sent': 404, 'events': [{'machTicks': '100'}]}

    def evaluate(self, directory, expression):
        if self.failure == 'tail':
            raise OSError('browser stopped during tail')

        return True


class DisplayDriverFake:
    def __init__(self, observed_display=1, visible=True):
        self.observed_display = observed_display
        self.visible = visible
        self.virtual_displays = []

    def request(self, directory, body, native=False):
        if body['op'] == 'virtual-display':
            self.virtual_displays.append(body['refreshRate'])
            return {'displayID': 100, 'applied': True, 'requestedRefreshRate': body['refreshRate'], 'actualRefreshRate': 0}

        return {'displayID': 1, 'mainDisplay': True, 'builtIn': True, 'maximumFramesPerSecond': 120}

    def place_window(self, directory):
        self.observed_display = 100

    def visible_window(self, directory):
        return {'displayID': self.observed_display, 'visible': self.visible,
                'occlusion': 2 if self.visible else 0, 'window': 7, 'maximumFramesPerSecond': 120}


class DisplayPlacement(unittest.TestCase):
    def test_keeps_the_requested_virtual_display_rate(self):
        driver = DisplayDriverFake()

        display, window = prepare_display(Path('/unused'), kind='virtual', refresh_rate=60, driver=driver)

        self.assertEqual(display, {'displayID': 100, 'applied': True, 'requestedRefreshRate': 60, 'actualRefreshRate': 0})
        self.assertEqual(window['displayID'], 100)
        self.assertEqual(driver.virtual_displays, [60])

    def test_records_the_main_maximum_without_requesting_a_display_rate(self):
        driver = DisplayDriverFake()

        display, window = prepare_display(Path('/unused'), kind='main', refresh_rate=60, driver=driver)

        self.assertEqual(display, {'displayID': 1, 'mainDisplay': True, 'builtIn': True, 'maximumFramesPerSecond': 120})
        self.assertEqual(window['displayID'], 1)
        self.assertEqual(driver.virtual_displays, [])

    def test_rejects_a_window_that_is_visible_on_another_display(self):
        driver = DisplayDriverFake(observed_display=2)

        with self.assertRaises(Inconclusive):
            prepare_display(Path('/unused'), kind='main', refresh_rate=60, driver=driver)

    def test_rejects_a_hidden_main_window(self):
        driver = DisplayDriverFake(visible=False)

        with self.assertRaises(Inconclusive):
            prepare_display(Path('/unused'), kind='main', refresh_rate=60, driver=driver)


class ViewportScriptSpy:
    def evaluate(self, directory, expression):
        self.expression = expression

        return {'scrollTop': 1200, 'max': 5000}


class ViewportObserver(unittest.TestCase):
    def test_leaves_no_animation_work_after_two_setup_frames(self):
        driver = ViewportScriptSpy()
        prepare_viewport(Path('/unused'), 'graph', driver=driver)
        program = r'''
            import vm from 'node:vm';
            const frames = [];
            const listeners = {};
            const viewport = {
                scrollTop: 0, scrollHeight: 5300, clientHeight: 300,
                dispatchEvent() {},
                addEventListener(name, listener) { listeners[name] = listener; },
                getBoundingClientRect() { return { toJSON: () => ({ left: 100, top: 50, width: 400, height: 300 }) }; }
            };
            const page = {
                document: { querySelector: () => viewport },
                Event: class {}, performance: { now: () => 42 }, CSS: { supports: () => true },
                requestAnimationFrame: callback => frames.push(callback)
            };
            page.window = page;
            const prepared = vm.runInNewContext(SCRIPT, page);
            frames.shift()(16);
            await Promise.resolve();
            frames.shift()(32);
            await prepared;
            viewport.scrollTop = 1212;
            listeners.scroll();
            listeners.wheel({ clientX: 300, clientY: 200, deltaY: 12, composedPath: () => [viewport] });
            console.log(JSON.stringify({
                pendingFrames: frames.length, scrolls: page.probeScrolls, wheels: page.probeWheel
            }));
        '''.replace('SCRIPT', json.dumps(driver.expression))

        result = subprocess.run(['mise', 'exec', '--', 'bun', '-e', program],
                                check=True, text=True, capture_output=True, timeout=10)

        self.assertEqual(json.loads(result.stdout), {
            'pendingFrames': 0, 'scrolls': [{'at': 42, 'top': 1212}],
            'wheels': [{'at': 42, 'x': 300, 'y': 200, 'dy': 12, 'insideViewport': True}]
        })


class UsageStub:
    base = SimpleNamespace(numer=1, denom=1)

    def snapshot(self, processes):
        return {role: {'start': 10, 'exit': 0, 'user': 20, 'system': 30} for role in processes}


class ResourceEvidence(unittest.TestCase):
    def test_refuses_competing_work_before_collecting_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                resource_run(output, output, [], UsageStub(), driver=NativeDriverStub(), snapshot=InventoryFake(BUSY))
            evidence = json.loads((output / 'process-admission.json').read_text())
            collected = (output / 'resource-attempt.json').exists()

        self.assertEqual(evidence['entry']['verdict'], 'rejected')
        self.assertFalse(collected)

    def test_refuses_competing_work_after_resources_and_retains_both_snapshots(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                resource_run(output, output, [], UsageStub(), driver=NativeDriverStub(), snapshot=InventoryFake(CLEAN, BUSY))
            evidence = json.loads((output / 'process-admission.json').read_text())
            resources = json.loads((output / 'resources.json').read_text())

        self.assertEqual(evidence['exit']['verdict'], 'rejected')
        self.assertEqual(resources['before']['host']['user'], 20)
        self.assertEqual(resources['after']['host']['user'], 20)
        self.assertLessEqual(evidence['entry']['finished_monotonic_ns'], resources['before_snapshot_monotonic_ns'][0])
        self.assertGreaterEqual(evidence['exit']['started_monotonic_ns'], resources['after_snapshot_monotonic_ns'][1])

    def test_preserves_initial_resources_when_injection_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(OSError):
                resource_run(output, output, [], UsageStub(), driver=NativeDriverStub('sequence'), snapshot=InventoryFake(CLEAN, CLEAN))
            attempt = json.loads((output / 'resource-attempt.json').read_text())

        self.assertEqual(attempt['before']['host']['user'], 20)
        self.assertEqual(attempt['failure_stage'], 'input')

    def test_preserves_delivery_when_the_tail_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(OSError):
                resource_run(output, output, [], UsageStub(), driver=NativeDriverStub('tail'), snapshot=InventoryFake(CLEAN, CLEAN))
            delivery = json.loads((output / 'native-input.json').read_text())
            attempt = json.loads((output / 'resource-attempt.json').read_text())

        self.assertEqual(delivery, {'sent': 404, 'events': [{'machTicks': '100'}]})
        self.assertEqual(attempt['failure_stage'], 'tail')

    def test_records_both_bounds_of_each_resource_snapshot(self):
        timestamps = iter([100, 200, 4000, 5000])
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            resource_run(output, output, [], UsageStub(), driver=NativeDriverStub(), clock=lambda: next(timestamps),
                         snapshot=InventoryFake(CLEAN, CLEAN))
            resources = json.loads((output / 'resources.json').read_text())

        self.assertEqual(resources['before_snapshot_monotonic_ns'], [100, 200])
        self.assertEqual(resources['after_snapshot_monotonic_ns'], [4000, 5000])


if __name__ == '__main__':
    unittest.main()
