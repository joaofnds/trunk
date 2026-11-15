import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import tempfile
import time

from fixture import create_fixture
from processes import stop_app

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE.parent / 'diff-scroll'))
from run import evaluate, request, save, until, wait_ready


class Usage(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in [
        'user', 'system', 'wakeups', 'interrupts', 'pageins', 'wired', 'resident',
        'footprint', 'start', 'exit', 'child_user', 'child_system', 'child_wakeups',
        'child_interrupts', 'child_pageins', 'child_elapsed', 'read_bytes', 'write_bytes']]


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
base = Timebase()
assert system.mach_timebase_info(ctypes.byref(base)) == 0


def snapshot(pids):
    result = {}
    for role, pid in pids.items():
        usage = Usage()
        if libproc.proc_pid_rusage(pid, 2, ctypes.byref(usage)):
            raise OSError(ctypes.get_errno(), f'process disappeared: {role} {pid}')
        result[role] = {name: getattr(usage, name) for name, _ in Usage._fields_ if name != 'uuid'}
    return result


def run(args, round_number):
    output = args.output / f'{round_number:02d}'
    output.mkdir()
    harness = output / 'harness'
    harness.mkdir()
    for name in ['run.py', 'select.js', 'observe.js', 'fixture.py', 'processes.py']:
        shutil.copy2(SOURCE / name, harness / name)
    shutil.copy2(SOURCE.parent / 'diff-scroll/run.py', harness / 'diff-scroll-run.py')
    with tempfile.TemporaryDirectory(prefix='trunk-interaction-', dir='/tmp') as temporary:
        directory = Path(temporary)
        repo = directory / 'repo'
        commits = create_fixture(repo, args.files, args.lines)
        data = directory / 'data'
        data.mkdir()
        save(data / 'trunk-prefs.json', {'open_tabs': [{'id': 'perf', 'repoPath': str(repo), 'repoName': 'interaction fixture'}], 'active_tab_id': 'perf', 'column_visibility': {'diff': args.graph_stats}})
        environment = {**os.environ, 'TRUNK_DRIVE_DIR': str(directory), 'TRUNK_DATA_DIR': str(data), 'DYLD_INSERT_LIBRARIES': str(args.native_probe)}
        with (output / 'app.log').open('w') as log:
            app = subprocess.Popen([str(args.binary)], env=environment, stdout=log, stderr=log)
            try:
                wait_ready(directory, app)
                until(directory, '[...document.querySelectorAll("[data-testid=commit-row-summary]")].some(x=>x.textContent.trim()==="fixture revision 2")')
                save(output / 'probe.json', evaluate(directory, (SOURCE / 'observe.js').read_text()))
                pids = request(directory, {'op': 'processes'}, native=True)
                assert pids['host'] == app.pid and all(pid > 0 for pid in pids.values())
                save(output / 'manifest.json', {'binary': str(args.binary), 'sha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
                    'files': args.files, 'lines': args.lines, 'commits': commits, 'processes': pids,
                    'graph_stats': args.graph_stats, 'native_probe_sha256': hashlib.sha256(args.native_probe.read_bytes()).hexdigest(),
                    'harness_hashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in harness.iterdir()},
                    'window': request(directory, {'op': 'info'}, native=True),
                    'drawing': request(directory, {'op': 'drawing'}),
                    'process_inventory': subprocess.check_output(['ps', '-axo', 'pid=,pcpu=,comm='], text=True),
                    'timebase': {'numer': base.numer, 'denom': base.denom}, 'load_average': os.getloadavg(),
                    'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                results = []
                for revision in [2, 1, 2, 1]:
                    expression = (harness / 'select.js').read_text().strip() + '(' + json.dumps({'summary': f'fixture revision {revision}', 'oid': commits[revision], 'files': args.files}) + ')'
                    before = snapshot(pids)
                    save(output / 'attempt.json', {'revision': revision, 'resources_before': before, 'completed_actions': len(results)})
                    try:
                        result = evaluate(directory, expression)
                    except Exception as error:
                        save(output / 'failure.json', {'revision': revision, 'error': str(error), 'resources_before': before,
                            'resources_after': snapshot(pids), 'partial': evaluate(directory, '({calls: window.interactionProbe.calls, frames: window.interactionProbe.frames, text: document.body.innerText})')})
                        request(directory, {'op': 'snapshot', 'path': str(output / 'failure.png')})
                        raise
                    after = snapshot(pids)
                    assert request(directory, {'op': 'processes'}, native=True) == pids
                    assert all(before[role]['start'] == after[role]['start'] and not after[role]['exit'] for role in pids)
                    results.append({**result, 'resources_before': before, 'resources_after': after})
                    save(output / 'results.json', results)
                request(directory, {'op': 'snapshot', 'path': str(output / 'final.png')})
                print(json.dumps({'run': round_number, 'files': args.files, 'usable_ms': [r['usable'] - r['start'] for r in results]}), flush=True)
            finally:
                stop_app(app, lambda: request(directory, {'op': 'quit'}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--native-probe', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--files', type=int, choices=[10, 100, 1000], required=True)
    parser.add_argument('--lines', type=int, default=200)
    parser.add_argument('--graph-stats', action=argparse.BooleanOptionalAction, required=True)
    parser.add_argument('--rounds', type=int, choices=range(1, 7), default=4)
    args = parser.parse_args()
    if not 1 <= args.lines <= 1000 or args.files * args.lines > 200_000:
        parser.error('--lines must be 1..1000 and files × lines must not exceed 200,000')
    args.binary = args.binary.resolve(strict=True)
    args.native_probe = args.native_probe.resolve(strict=True)
    args.output = args.output.resolve()
    args.output.mkdir(exist_ok=False)
    with Path('/tmp/trunk-native-diff-scroll.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        first_start = time.process_time_ns()
        first = snapshot({'self': os.getpid()})['self']
        first_end = time.process_time_ns()
        hashlib.sha256(bytes(8 * 1024 * 1024)).digest()
        last_start = time.process_time_ns()
        last = snapshot({'self': os.getpid()})['self']
        last_end = time.process_time_ns()
        cpu_ns = ((last['user'] + last['system']) - (first['user'] + first['system'])) * base.numer / base.denom
        bracket = [last_start - first_end, last_end - first_start]
        save(args.output / 'cpu-calibration.json', {'converted_ns': cpu_ns, 'process_time_ns_bracket': bracket})
        assert bracket[0] <= cpu_ns <= bracket[1]
        for round_number in range(1, args.rounds + 1):
            run(args, round_number)


if __name__ == '__main__':
    main()
