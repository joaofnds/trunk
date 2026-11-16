from concurrent.futures import Future
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import unittest

from analysis import Inconclusive
from renderer_pause import capture_pause, complete_capture, deliver_with_pause, main, pause_renderer, preserve_harness, validate_pause, validate_target


class DrivenClock:
    numer = 1
    denom = 1

    def __init__(self):
        self.now = 1000000

    def ticks(self):
        return self.now

    def milliseconds(self, value):
        return value * 1000000

    def wait_until(self, deadline, cancel):
        if cancel.is_set():
            return False

        self.now = deadline
        return True


class ProcessFake:
    def __init__(self, *, fail_state=False):
        self.stopped = False
        self.signals = []
        self.fail_state = fail_state

    def send(self, pid, action):
        self.signals.append((pid, action))
        self.stopped = action == signal.SIGSTOP

    def state(self, pid):
        if self.stopped and self.fail_state:
            raise OSError('state read failed')

        return 'T' if self.stopped else 'S'


class PauseLifecycle(unittest.TestCase):
    def test_resumes_after_exactly_one_hundred_driven_milliseconds(self):
        clock, processes, timing = DrivenClock(), ProcessFake(), {}

        pause_renderer(8, origin=clock.ticks(), clock=clock, processes=processes,
                       cancel=threading.Event(), timing=timing)

        self.assertFalse(processes.stopped)
        self.assertEqual(processes.signals, [(8, signal.SIGSTOP), (8, signal.SIGCONT)])
        self.assertEqual(int(timing['resume_before_ticks']) - int(timing['stop_after_ticks']), 100000000)
        self.assertEqual((timing['observed_state'], timing['resumed_state']), ('T', 'S'))

    def test_resumes_when_state_observation_fails(self):
        clock, processes, timing = DrivenClock(), ProcessFake(fail_state=True), {}

        with self.assertRaises(OSError):
            pause_renderer(8, origin=clock.ticks(), clock=clock, processes=processes,
                           cancel=threading.Event(), timing=timing)

        self.assertFalse(processes.stopped)
        self.assertEqual(timing['resumed_state'], 'S')

    def test_does_not_stop_after_capture_cancellation(self):
        clock, processes, timing = DrivenClock(), ProcessFake(), {}
        cancel = threading.Event()
        cancel.set()

        pause_renderer(8, origin=clock.ticks(), clock=clock, processes=processes, cancel=cancel, timing=timing)

        self.assertEqual(processes.signals, [])
        self.assertTrue(timing['cancelled_before_stop'])

    def test_refuses_a_different_host_before_signalling(self):
        with self.assertRaises(Inconclusive):
            validate_target({'host': 9, 'web': 8}, {'pid': 7})

    def test_refuses_the_host_as_the_renderer(self):
        with self.assertRaises(Inconclusive):
            validate_target({'host': 7, 'web': 7}, {'pid': 7})

    def test_refuses_a_nonpositive_renderer_pid(self):
        with self.assertRaises(Inconclusive):
            validate_target({'host': 7, 'web': 0}, {'pid': 7})


class PauseAdmission(unittest.TestCase):
    def test_accepts_input_delivered_inside_the_observed_pause(self):
        timing = {'stop_after_ticks': '100', 'resume_before_ticks': '200', 'resumed_state': 'S'}
        delivery = {'sent': 1, 'events': [{'machTicks': '125', 'windowNumber': 7}]}

        validate_pause(timing, delivery, expected_events=[{'atMs': 125}], window=7)

    def test_refuses_input_after_renderer_resumption(self):
        timing = {'stop_after_ticks': '100', 'resume_before_ticks': '200', 'resumed_state': 'S'}
        delivery = {'sent': 1, 'events': [{'machTicks': '201', 'windowNumber': 7}]}

        with self.assertRaises(Inconclusive):
            validate_pause(timing, delivery, expected_events=[{'atMs': 125}], window=7)

    def test_refuses_partial_native_delivery(self):
        timing = {'stop_after_ticks': '100', 'resume_before_ticks': '200', 'resumed_state': 'S'}
        delivery = {'sent': 0, 'events': []}

        with self.assertRaises(Inconclusive):
            validate_pause(timing, delivery, expected_events=[{'atMs': 125}], window=7)


class ImmediateExecutor:
    def __init__(self, *, max_workers):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *error):
        return False

    def submit(self, operation, *args, **kwargs):
        future = Future()
        try:
            future.set_result(operation(*args, **kwargs))
        except BaseException as error:
            future.set_exception(error)

        return future


class InputDriverFake:
    def __init__(self, *, fail_input=False, partial=False):
        self.fail_input = fail_input
        self.partial = partial

    def request(self, directory, body, native=False):
        if body['op'] == 'processes':
            return {'host': 7, 'web': 8}

        if self.fail_input:
            raise OSError('input socket failed')

        if self.partial:
            return {'sent': 0, 'events': []}

        return {'sent': len(body['events']), 'events': [{'machTicks': '126000000', 'windowNumber': 70}]}


class PauseArtifacts(unittest.TestCase):
    def test_saves_offset_events_and_actual_pause_evidence(self):
        clock, processes = DrivenClock(), ProcessFake()
        events = [{'atMs': 0, 'dy': -12}]
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            deliver_with_pause(output, output, {'pid': 7, 'window': 70}, events,
                               clock=clock, processes=processes, driver=InputDriverFake(), executor_factory=ImmediateExecutor)
            planned = json.loads((output / 'input.json').read_text())
            timing = json.loads((output / 'pause.json').read_text())

        self.assertEqual(events, [{'atMs': 0, 'dy': -12}])
        self.assertEqual(planned, [{'atMs': 125, 'dy': -12}])
        self.assertEqual(timing['observed_state'], 'T')
        self.assertEqual(timing['resumed_state'], 'S')

    def test_preserves_evidence_and_resumes_after_input_failure(self):
        clock, processes = DrivenClock(), ProcessFake()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(OSError):
                deliver_with_pause(output, output, {'pid': 7, 'window': 70}, [{'atMs': 0}],
                                   clock=clock, processes=processes, driver=InputDriverFake(fail_input=True),
                                   executor_factory=ImmediateExecutor)
            timing = json.loads((output / 'pause.json').read_text())

        self.assertFalse(processes.stopped)
        self.assertIn('error', timing)
        self.assertEqual(timing['resumed_state'], 'S')

    def test_preserves_partial_delivery_before_rejecting_the_attempt(self):
        clock, processes = DrivenClock(), ProcessFake()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                deliver_with_pause(output, output, {'pid': 7, 'window': 70}, [{'atMs': 0}],
                                   clock=clock, processes=processes, driver=InputDriverFake(partial=True),
                                   executor_factory=ImmediateExecutor)
            delivery = json.loads((output / 'native-input.json').read_text())
            timing = json.loads((output / 'pause.json').read_text())

        self.assertEqual(delivery, {'sent': 0, 'events': []})
        self.assertIn('error', timing)
        self.assertFalse(processes.stopped)

    def test_preserves_input_and_resumes_when_worker_fails_before_pause_wait(self):
        clock, processes = DrivenClock(), ProcessFake(fail_state=True)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(OSError):
                deliver_with_pause(output, output, {'pid': 7, 'window': 70}, [{'atMs': 0}],
                                   clock=clock, processes=processes, driver=InputDriverFake(),
                                   executor_factory=ImmediateExecutor)
            delivery = json.loads((output / 'native-input.json').read_text())
            timing = json.loads((output / 'pause.json').read_text())

        self.assertEqual(delivery['sent'], 1)
        self.assertFalse(processes.stopped)
        self.assertEqual(processes.signals, [(8, signal.SIGSTOP), (8, signal.SIGCONT)])
        self.assertEqual(timing['resumed_state'], 'S')
        self.assertIn('error', timing)


class RecorderFake:
    def __init__(self, output, *, exit_code=0, timeout=False):
        self.output = output
        self.exit_code = exit_code
        self.timeout = timeout
        self.returncode = None

    def communicate(self, *, timeout):
        if self.timeout:
            raise subprocess.TimeoutExpired('recorder', timeout, output=b'partial capture output')

        (self.output / 'capture.mov').write_bytes(b'finalized movie')
        (self.output / 'capture.json').write_text('{"frames": 300}')
        self.returncode = self.exit_code
        return ('capture complete', None)


class CaptureFinalization(unittest.TestCase):
    def test_finishes_movie_and_saves_stdout_before_reraising_input_failure(self):
        failure = OSError('input socket failed')
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            recorder = RecorderFake(output)

            with self.assertRaises(OSError) as caught:
                with complete_capture(recorder, output):
                    raise failure

            self.assertIs(caught.exception, failure)
            self.assertEqual((output / 'capture.mov').read_bytes(), b'finalized movie')
            self.assertEqual(json.loads((output / 'capture.json').read_text()), {'frames': 300})
            self.assertEqual((output / 'capture.stdout.log').read_text(), 'capture complete')

    def test_retains_input_failure_when_recorder_also_fails(self):
        failure = OSError('input socket failed')
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            recorder = RecorderFake(output, exit_code=1)

            with self.assertRaises(OSError) as caught:
                with complete_capture(recorder, output):
                    raise failure

            self.assertIs(caught.exception, failure)
            self.assertEqual((output / 'capture.stdout.log').read_text(), 'capture complete')
            self.assertIn('error', json.loads((output / 'capture-finalization-error.json').read_text()))

    def test_preserves_partial_stdout_when_finalization_times_out(self):
        failure = OSError('input socket failed')
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            recorder = RecorderFake(output, timeout=True)

            with self.assertRaises(OSError) as caught:
                with complete_capture(recorder, output):
                    raise failure

            self.assertIs(caught.exception, failure)
            self.assertEqual((output / 'capture.stdout.log').read_text(), 'partial capture output')


class RunnerFake:
    def __init__(self, *, fail=False, terminate=False):
        self.capture = object()
        self.fail = fail
        self.terminate = terminate
        self.cleaned_up = False

    def main(self):
        self.observed_capture = self.capture
        try:
            if self.terminate:
                signal.raise_signal(signal.SIGTERM)

            if self.fail:
                raise OSError('capture failed')

            return 2
        finally:
            self.cleaned_up = True


class PauseLauncher(unittest.TestCase):
    def test_freezes_the_process_admission_dependency_with_the_pause_harness(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            (output / 'native-probe.dylib').write_bytes(b'probe')
            (output / 'native-capture').write_bytes(b'capture')

            preserve_harness(output)
            provenance = json.loads((output / 'pause-harness.json').read_text())

            self.assertIn('process_admission.py', provenance['source_sha256'])
            self.assertTrue((output / 'pause-harness/process_admission.py').is_file())

    def test_preserves_the_existing_runner_verdict_and_restores_capture(self):
        runner = RunnerFake()
        original = runner.capture

        result = main(runner=runner)

        self.assertEqual(result, 2)
        self.assertIs(runner.observed_capture, capture_pause)
        self.assertIs(runner.capture, original)

    def test_restores_the_existing_capture_after_an_exception(self):
        runner = RunnerFake(fail=True)
        original = runner.capture

        with self.assertRaises(OSError):
            main(runner=runner)

        self.assertIs(runner.capture, original)

    def test_sigterm_unwinds_runner_cleanup_and_restores_the_previous_handler(self):
        runner = RunnerFake(terminate=True)
        original_capture = runner.capture
        original_handler = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, original_handler)
        previous_signals = []
        previous_handler = lambda number, frame: previous_signals.append(number)
        signal.signal(signal.SIGTERM, previous_handler)

        with self.assertRaises(SystemExit) as caught:
            main(runner=runner)

        self.assertEqual(caught.exception.code, 128 + signal.SIGTERM)
        self.assertTrue(runner.cleaned_up)
        self.assertIs(runner.capture, original_capture)
        self.assertIs(signal.getsignal(signal.SIGTERM), previous_handler)
        self.assertEqual(previous_signals, [])


if __name__ == '__main__':
    unittest.main()
