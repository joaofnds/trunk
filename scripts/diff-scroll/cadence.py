#!/usr/bin/env python3
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from analysis import Inconclusive
from fixture import create_fixture
from process_admission import inventory_snapshot, measurement_window
import run as runtime

SOURCE = Path(__file__).resolve().parent
INTERACTION = SOURCE.parent / 'interaction-performance'


def load_module(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)

    return module


@contextmanager
def module_bindings(modules):
    previous = {name: sys.modules.get(name) for name in modules}
    search_path = list(sys.path)
    sys.modules.update(modules)
    try:
        yield
    finally:
        sys.path[:] = search_path
        for name, module in previous.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def load_resource_runtime():
    fixture = load_module('cadence_resource_fixture', INTERACTION / 'fixture.py')
    processes = load_module('cadence_processes', INTERACTION / 'processes.py')
    with module_bindings({'fixture': fixture, 'processes': processes, 'run': runtime}):
        return load_module('cadence_resource_runtime', INTERACTION / 'run.py')


def sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def trace(box):
    x = box['left'] + box['width'] / 2
    y = box['top'] + box['height'] / 2
    events = []
    for gesture in range(4):
        for step in range(100):
            events.append({'atMs': gesture * 1000 + step * 8, 'x': x, 'y': y,
                           'dy': -12 if gesture % 2 == 0 else 12,
                           'phase': 1 if step == 0 else 2, 'momentum': 0})
        events.append({**events[-1], 'atMs': gesture * 1000 + 800, 'dy': 0, 'phase': 4})

    return events


def freeze_harness(output):
    paths = [SOURCE / name for name in ['cadence.py', 'cadence_analysis.py', 'run.py', 'analysis.py',
                                       'fixture.py', 'process_admission.py', 'geometry.js', 'native-probe.m', 'native-capture.swift']]
    paths.extend(INTERACTION / name for name in ['run.py', 'fixture.py', 'processes.py'])
    hashes = {}
    for source in paths:
        relative = source.relative_to(SOURCE.parent)
        destination = output / 'harness' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        hashes[str(relative)] = sha256(destination)

    return hashes


def calibrate_cpu(usage):
    first_start = time.process_time_ns()
    first = usage.snapshot({'self': os.getpid()})['self']
    first_end = time.process_time_ns()
    hashlib.sha256(bytes(8 * 1024 * 1024)).digest()
    last_start = time.process_time_ns()
    last = usage.snapshot({'self': os.getpid()})['self']
    last_end = time.process_time_ns()
    converted = ((last['user'] + last['system']) - (first['user'] + first['system'])) * usage.base.numer / usage.base.denom
    bracket = [last_start - first_end, last_end - first_start]
    result = {'converted_ns': converted, 'process_time_ns_bracket': bracket,
              'bytes_hashed': 8 * 1024 * 1024, 'before': first, 'after': last,
              'timebase': {'numer': usage.base.numer, 'denom': usage.base.denom}}
    if not bracket[0] <= converted <= bracket[1]:
        raise Inconclusive(f'CPU conversion is outside the process_time bracket: {result}')

    return result


def prepare_viewport(directory, mode, *, driver=runtime):
    if mode == 'diff':
        driver.evaluate(directory, '([...document.querySelectorAll("[data-testid=commit-row-summary]")].find(x=>x.textContent.trim()==="native scroll fixture").click(),true)')
        driver.until(directory, '(()=>{const f=[...document.querySelectorAll("[data-testid=commit-detail] [data-testid=staging-file]")].find(x=>x.textContent.includes("scroll.ts"));if(!f)return false;f.click();return true})()')
        driver.until(directory, 'document.querySelector(".exact-virtual-rows .diff-line-add")')

    selector = '.exact-virtual-viewport' if mode == 'diff' else '.virtual-list-viewport'
    start = 12000 if mode == 'diff' else 1200
    box = driver.evaluate(directory, f'''(async()=>{{
        const v=document.querySelector({json.dumps(selector)});
        v.scrollTop={start};v.dispatchEvent(new Event('scroll'));
        await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
        window.probeScrolls=[];window.probeWheel=[];
        v.addEventListener('scroll',()=>probeScrolls.push({{at:performance.now(),top:v.scrollTop}}));
        v.addEventListener('wheel',e=>probeWheel.push({{at:performance.now(),x:e.clientX,y:e.clientY,
            dy:e.deltaY,insideViewport:e.composedPath().includes(v)}}));
        return {{...v.getBoundingClientRect().toJSON(),scrollTop:v.scrollTop,
            max:v.scrollHeight-v.clientHeight,cssTimeline:CSS.supports('animation-timeline','scroll()')}};
    }})()''')
    if box['scrollTop'] != start or box['max'] < start + 1200:
        raise Inconclusive('fixture does not provide the complete 1200px excursion')

    return selector, box


def resource_run(directory, output, events, usage, *, driver=runtime, clock=time.monotonic_ns, snapshot=inventory_snapshot):
    with measurement_window(output, snapshot=snapshot):
        return collect_resources(directory, output, events, usage, driver=driver, clock=clock)


def collect_resources(directory, output, events, usage, *, driver, clock):
    attempt = {'tail_ms': 200, 'timebase': {'numer': usage.base.numer, 'denom': usage.base.denom}}
    stage = 'processes-before'
    try:
        pids = driver.request(directory, {'op': 'processes'}, native=True)
        attempt['processes_before'] = pids
        stage = 'snapshot-before'
        before_start = clock()
        attempt['before'] = usage.snapshot(pids)
        attempt['before_snapshot_monotonic_ns'] = [before_start, clock()]
        runtime.save(output / 'resource-attempt.json', attempt)

        stage = 'input'
        delivery = driver.request(directory, {'op': 'sequence', 'events': events}, native=True)
        runtime.save(output / 'native-input.json', delivery)
        stage = 'tail'
        driver.evaluate(directory, 'new Promise(resolve=>setTimeout(()=>resolve(true),200))')
        stage = 'snapshot-after'
        after_start = clock()
        attempt['after'] = usage.snapshot(pids)
        attempt['after_snapshot_monotonic_ns'] = [after_start, clock()]
        stage = 'processes-after'
        attempt['processes_after'] = driver.request(directory, {'op': 'processes'}, native=True)
        runtime.save(output / 'resources.json', attempt)
    except Exception as error:
        attempt.update({'failure_stage': stage, 'error': str(error)})
        runtime.save(output / 'resource-attempt.json', attempt)
        raise


def run(args, harness_hashes, *, host=subprocess, driver=runtime, snapshot=inventory_snapshot):
    output = args.output
    geometry_result = None
    stop_app = load_module('cadence_processes', INTERACTION / 'processes.py').stop_app
    usage = load_resource_runtime() if args.resources else None
    if usage:
        runtime.save(output / 'cpu-calibration.json', calibrate_cpu(usage))

    binaries = {'binary': args.binary, 'native_probe': args.native_probe}
    if args.recorder:
        binaries['recorder'] = args.recorder
        (output / 'native-capture').symlink_to(args.recorder)

    manifest = {'schema': 1, 'mode': args.mode, 'resource_run': args.resources, 'geometry_run': args.geometry,
                'process_admission_required': not args.geometry,
                'display_kind': args.display, 'refresh_rate_argument': args.refresh_rate,
                'requested_refresh_rate': args.refresh_rate if args.display == 'virtual' else None,
                'source_revision_supplied': args.source_revision,
                'files': {role: {'path': str(path), 'sha256': sha256(path)} for role, path in binaries.items()},
                'harness_hashes': harness_hashes, 'lines': 1500, 'history': 400,
                'capture_seconds': 5 if args.recorder else None, 'resource_tail_ms': 200 if args.resources else None,
                'platform': host.check_output(['sw_vers'], text=True, timeout=5).strip(),
                'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'load_average': os.getloadavg()}
    if args.geometry:
        manifest['geometry_script'] = {'path': 'harness/diff-scroll/geometry.js',
                                       'sha256': harness_hashes['diff-scroll/geometry.js']}

    runtime.save(output / 'manifest.json', manifest)
    with tempfile.TemporaryDirectory(prefix='trunk-cadence-', dir='/tmp') as temporary:
        directory = Path(temporary)
        repository = directory / 'repo'
        manifest['oid'] = create_fixture(repository, 1500, history=400)
        manifest['fixture_files'] = {str(path.relative_to(repository)): sha256(path)
                                     for path in sorted(repository.rglob('*')) if path.is_file()}
        data = directory / 'data'
        data.mkdir()
        preferences = {'open_tabs': [{'id': 'cadence', 'repoPath': str(repository), 'repoName': 'cadence fixture'}],
                       'active_tab_id': 'cadence', 'fetch_interval_ms': 0, 'column_visibility': {'diff': False}}
        runtime.save(data / 'trunk-prefs.json', preferences)
        manifest['preferences'] = preferences
        environment = {**os.environ, 'TRUNK_DRIVE_DIR': str(directory), 'TRUNK_DATA_DIR': str(data),
                       'DYLD_INSERT_LIBRARIES': str(args.native_probe)}
        with (output / 'app.log').open('w') as log:
            app = host.Popen([str(args.binary)], env=environment, stdout=log, stderr=log)
            try:
                driver.wait_ready(directory, app)
                driver.until(directory, '[...document.querySelectorAll("[data-testid=commit-row-summary]")].some(x=>x.textContent.trim()==="native scroll fixture")')
                manifest['display'], manifest['info'] = runtime.prepare_display(directory, kind=args.display, refresh_rate=args.refresh_rate, driver=driver)
                selector, manifest['box'] = prepare_viewport(directory, args.mode, driver=driver)
                from cadence_analysis import default_crops
                manifest['crops'] = default_crops(manifest)
                manifest['native_configuration'] = driver.request(directory, {'op': 'configuration-contract'}, native=True)
                manifest['processes'] = driver.request(directory, {'op': 'processes'}, native=True)
                if manifest['processes']['host'] != app.pid or any(pid <= 0 for pid in manifest['processes'].values()):
                    raise Inconclusive('native probe reported invalid process identifiers')

                manifest['process_inventory'] = host.check_output(['ps', '-axo', 'pid=,pcpu=,comm='], text=True, timeout=5)
                runtime.save(output / 'manifest.json', manifest)
                if args.geometry:
                    expression = (SOURCE / 'geometry.js').read_text().strip().removesuffix(';')
                    geometry_result = driver.evaluate(directory, expression)
                    runtime.save(output / 'geometry.json', geometry_result)
                    if not isinstance(geometry_result, dict) or geometry_result.get('verdict') not in {'pass', 'fail'}:
                        raise Inconclusive('geometry probe did not return a pass or fail verdict')
                else:
                    events = trace(manifest['box'])
                    runtime.save(output / 'input.json', events)
                    if args.resources:
                        resource_run(directory, output, events, usage, driver=driver, snapshot=snapshot)
                    else:
                        runtime.capture_with_admission(directory, output, manifest['info'], events,
                                                       capture_operation=driver.capture, snapshot=snapshot)

                    observations = driver.evaluate(directory, f'({{scrolls:probeScrolls,wheels:probeWheel,final:document.querySelector({json.dumps(selector)}).scrollTop}})')
                    runtime.save(output / 'observations.json', observations)
            finally:
                stop_app(app, lambda: driver.request(directory, {'op': 'quit'}))

    for role, path in binaries.items():
        if sha256(path) != manifest['files'][role]['sha256']:
            raise Inconclusive(f'{role} changed during the run')

    return geometry_result


def parser():
    arguments = argparse.ArgumentParser(description='Replay one bounded native cadence trace; failed trials are retained and never rerun.')
    arguments.add_argument('--binary', type=Path, required=True)
    arguments.add_argument('--native-probe', type=Path, required=True)
    arguments.add_argument('--source-revision', default='unspecified', help='recorded as supplied, not inferred from the checkout')
    arguments.add_argument('--output', type=Path, required=True, help='exclusive new artifact directory')
    arguments.add_argument('--mode', choices=['graph', 'diff'], required=True)
    arguments.add_argument('--display', choices=['main', 'virtual'], default='main',
                           help='virtual creates a private display, whose WindowServer state outlives the run')
    arguments.add_argument('--refresh-rate', type=int, choices=[60, 120], required=True,
                           help='requested virtual display rate; recorded but not applied in main mode')
    measurement = arguments.add_mutually_exclusive_group(required=True)
    measurement.add_argument('--recorder', type=Path, help='existing native-capture executable')
    measurement.add_argument('--resources', action='store_true', help='CPU/memory/I/O window without a recorder')
    measurement.add_argument('--geometry', action='store_true', help='diff geometry and hit-testing without a cadence trace')

    return arguments


def parse_args(argv=None):
    arguments = parser()
    args = arguments.parse_args(argv)
    if args.geometry and args.mode != 'diff':
        arguments.error('--geometry requires --mode diff')

    return args


@contextmanager
def frozen_harness(output):
    source = output / 'harness' / 'diff-scroll'
    analysis = load_module('cadence_frozen_analysis', source / 'analysis.py')
    fixture = load_module('cadence_frozen_fixture', source / 'fixture.py')
    with module_bindings({'analysis': analysis, 'fixture': fixture}):
        admission = load_module('cadence_frozen_admission', source / 'process_admission.py')
        with module_bindings({'process_admission': admission}):
            frozen_analysis = load_module('cadence_frozen_cadence_analysis', source / 'cadence_analysis.py')
            frozen_runtime = load_module('cadence_frozen_runtime', source / 'run.py')
            with module_bindings({'run': frozen_runtime, 'cadence_analysis': frozen_analysis}):
                yield load_module('cadence_frozen', source / 'cadence.py'), frozen_analysis


def main():
    args = parse_args()
    owns_output = False
    try:
        args.binary = args.binary.resolve(strict=True)
        args.native_probe = args.native_probe.resolve(strict=True)
        if args.recorder:
            args.recorder = args.recorder.resolve(strict=True)
        args.output = args.output.resolve()
        with Path('/tmp/trunk-native-diff-scroll.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            args.output.mkdir(parents=True, exist_ok=False)
            owns_output = True
            hashes = freeze_harness(args.output)
            with frozen_harness(args.output) as (frozen, frozen_analysis):
                result = frozen.run(args, hashes)

            if not args.geometry:
                result = frozen_analysis.analyze(args.output, resources=args.resources)
            runtime.save(args.output / 'result.json', result)
        print(json.dumps(result, indent=2))
        return 1 if result['verdict'] == 'fail' else 0
    except Exception as error:
        result = {'verdict': 'inconclusive', 'reason': str(error), 'error_notes': getattr(error, '__notes__', []), 'rerun': False}
        if owns_output:
            runtime.save(args.output / 'result.json', result)
        print(json.dumps(result), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
