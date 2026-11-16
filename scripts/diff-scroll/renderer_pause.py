#!/usr/bin/env python3
"""Bounded renderer pause with SIGTERM cleanup. SIGKILL cannot be handled."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import ctypes
import hashlib
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import threading

from analysis import Inconclusive
import run as runtime

SOURCE = Path(__file__).resolve().parent
PAUSE_START_MS = 100
PAUSE_MS = 100
INPUT_OFFSET_MS = 125


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


class MachClock:
    def __init__(self):
        self.system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
        self.system.mach_absolute_time.restype = ctypes.c_uint64
        base = Timebase()
        if self.system.mach_timebase_info(ctypes.byref(base)) != 0:
            raise Inconclusive('mach timebase unavailable')

        self.numer, self.denom = base.numer, base.denom

    def ticks(self):
        return self.system.mach_absolute_time()

    def milliseconds(self, value):
        return round(value * 1e6 * self.denom / self.numer)

    def wait_until(self, deadline, cancel):
        seconds = max(0, (deadline - self.ticks()) * self.numer / self.denom / 1e9)

        return not cancel.wait(seconds)


class ProcessSignals:
    def send(self, pid, action):
        os.kill(pid, action)

    def state(self, pid):
        return subprocess.check_output(['ps', '-p', str(pid), '-o', 'state='],
                                       text=True, timeout=0.05).strip()


def validate_target(pids, info):
    host, web = pids['host'], pids['web']
    if type(host) is not int or type(web) is not int or host <= 0 or web <= 0 or host != info['pid'] or web == host or web == os.getpid():
        raise Inconclusive('pause requires the test host and its distinct positive WebContent pid')

    return web


def pause_renderer(pid, *, origin, clock, processes, cancel, timing):
    if not clock.wait_until(origin + clock.milliseconds(PAUSE_START_MS), cancel):
        timing['cancelled_before_stop'] = True
        return

    timing['stop_before_ticks'] = str(clock.ticks())
    try:
        processes.send(pid, signal.SIGSTOP)
        stopped = clock.ticks()
        timing['stop_after_ticks'] = str(stopped)
        timing['observed_state'] = processes.state(pid)
        if 'T' not in timing['observed_state']:
            raise Inconclusive('WebContent did not report a stopped state')

        timing['cancelled_during_pause'] = not clock.wait_until(stopped + clock.milliseconds(PAUSE_MS), cancel)
    finally:
        timing['resume_before_ticks'] = str(clock.ticks())
        processes.send(pid, signal.SIGCONT)
        timing['resume_after_ticks'] = str(clock.ticks())
        timing['resumed_state'] = processes.state(pid)


def validate_pause(timing, delivery, *, expected_events, window):
    if delivery.get('sent') != len(expected_events) or len(delivery.get('events', [])) != len(expected_events):
        raise Inconclusive('native injector did not deliver the complete offset trace')

    if any(event['windowNumber'] != window for event in delivery['events']):
        raise Inconclusive('native input was delivered to another window')

    first = int(delivery['events'][0]['machTicks'])
    if not int(timing['stop_after_ticks']) < first < int(timing['resume_before_ticks']):
        raise Inconclusive('the first native input did not occur inside the observed renderer pause')

    if 'T' in timing['resumed_state']:
        raise Inconclusive('WebContent still reported a stopped state after SIGCONT')


def deliver_with_pause(directory, output, info, events, *, clock, processes, driver=runtime,
                       executor_factory=ThreadPoolExecutor):
    pids = driver.request(directory, {'op': 'processes'}, native=True)
    timing = {'processes': pids, 'planned_pause_ms': PAUSE_MS, 'planned_pause_start_ms': PAUSE_START_MS,
              'planned_input_offset_ms': INPUT_OFFSET_MS,
              'timebase': {'numer': clock.numer, 'denom': clock.denom}}
    runtime.save(output / 'pause.json', timing)
    cancel = threading.Event()
    try:
        pid = validate_target(pids, info)
        offset_events = [{**event, 'atMs': event['atMs'] + INPUT_OFFSET_MS} for event in events]
        runtime.save(output / 'input.json', offset_events)
        origin = clock.ticks()
        timing['origin_ticks'] = str(origin)
        with executor_factory(max_workers=1) as executor:
            task = executor.submit(pause_renderer, pid, origin=origin, clock=clock,
                                   processes=processes, cancel=cancel, timing=timing)
            try:
                delivery = driver.request(directory, {'op': 'sequence', 'events': offset_events}, native=True)
                runtime.save(output / 'native-input.json', delivery)
                task.result(timeout=1)
            finally:
                cancel.set()

        validate_pause(timing, delivery, expected_events=offset_events, window=info['window'])
        if driver.request(directory, {'op': 'processes'}, native=True) != pids:
            raise Inconclusive('native process identities changed during the pause experiment')
    except BaseException as error:
        timing['error'] = str(error)
        raise
    finally:
        runtime.save(output / 'pause.json', timing)


def preserve_harness(output):
    harness = output / 'pause-harness'
    harness.mkdir()
    hashes = {}
    for name in ['renderer_pause.py', 'run.py', 'analysis.py', 'fixture.py', 'observe.js', 'process_admission.py',
                 'native-probe.m', 'native-capture.swift']:
        destination = harness / name
        shutil.copy2(SOURCE / name, destination)
        hashes[name] = hashlib.sha256(destination.read_bytes()).hexdigest()

    runtime.save(output / 'pause-harness.json', {'source_sha256': hashes,
                 'compiled_helpers_sha256': {name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                                             for name in ['native-probe.dylib', 'native-capture']},
                 'pause_ms': PAUSE_MS, 'pause_start_ms': PAUSE_START_MS, 'input_offset_ms': INPUT_OFFSET_MS})


@contextmanager
def complete_capture(recorder, output):
    failure = None
    try:
        yield
    except BaseException as error:
        failure = error
        raise
    finally:
        try:
            remaining = recorder.communicate(timeout=20)[0]
            (output / 'capture.stdout.log').write_text(remaining)
            if recorder.returncode != 0:
                raise Inconclusive(f'recorder exited {recorder.returncode}; see capture.stderr.log')
        except BaseException as error:
            if isinstance(error, subprocess.TimeoutExpired):
                partial = error.output or b''
                (output / 'capture.stdout.log').write_text(partial.decode() if isinstance(partial, bytes) else partial)

            if failure is None:
                raise

            runtime.save(output / 'capture-finalization-error.json', {'error': str(error)})


def capture_pause(directory, output, info, events):
    preserve_harness(output)
    clock, processes = MachClock(), ProcessSignals()
    with (output / 'capture.stderr.log').open('w') as errors:
        recorder = subprocess.Popen([str(output / 'native-capture'), str(info['window']), str(output / 'capture.mov'), '5'],
                                    stdout=subprocess.PIPE, stderr=errors, text=True)
        try:
            with complete_capture(recorder, output):
                ready, _, _ = select.select([recorder.stdout], [], [], 15)
                if not ready or not recorder.stdout.readline().startswith('READY '):
                    raise Inconclusive('recorder did not announce readiness; see capture.stderr.log')

                deliver_with_pause(directory, output, info, events, clock=clock, processes=processes)
        finally:
            if recorder.poll() is None:
                recorder.terminate()
                try:
                    recorder.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    recorder.kill()
                    recorder.wait(timeout=5)


def main(*, runner=runtime):
    original_capture = runner.capture
    original_sigterm = signal.getsignal(signal.SIGTERM)

    def terminate(signum, frame):
        raise SystemExit(128 + signum)

    try:
        signal.signal(signal.SIGTERM, terminate)
        runner.capture = capture_pause
        return runner.main()
    finally:
        runner.capture = original_capture
        signal.signal(signal.SIGTERM, original_sigterm)


if __name__ == '__main__':
    sys.exit(main())
