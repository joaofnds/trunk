#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys

from analysis import Inconclusive, mach_ticks, validate_capture, validate_temporal_coverage, validate_workload_admission


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def summarize(values):
    if not values:
        return {'count': 0, 'min': None, 'median': None, 'p95': None, 'max': None}

    ordered = sorted(values)
    return {'count': len(values), 'min': min(values), 'median': statistics.median(values),
            'p95': ordered[math.ceil(len(ordered) * 0.95) - 1], 'max': max(values)}


def validate_input(manifest, planned, delivery, observations):
    box = manifest['box']
    info = manifest['info']
    wheels = observations['wheels']
    if len(planned) != 404 or delivery['sent'] != 404 or len(delivery['events']) != 404:
        raise Inconclusive('the trace requires all 404 planned and delivered native events')

    if len(wheels) != 400 or any(not finite(event['dy']) or event['dy'] == 0 for event in wheels):
        raise Inconclusive('the trace requires exactly 400 nonzero browser wheel receipts')

    native_ticks = mach_ticks(delivery['events'], 'machTicks')
    bounds = mach_ticks([{'start': delivery['plannedStartMachTicksLowerBound']},
                         {'start': delivery['plannedStartMachTicksUpperBound']}], 'start')
    numer, denom = delivery['timebaseNumer'], delivery['timebaseDenom']
    if not finite(numer) or not finite(denom) or numer <= 0 or denom <= 0:
        raise Inconclusive('native timebase must have positive finite numerator and denominator')

    tick_ms = numer / denom / 1e6
    x, y = box['left'] + box['width'] / 2, box['top'] + box['height'] / 2
    delays = []
    browser_index = 0
    for index, (expected, actual, ticks) in enumerate(zip(planned, delivery['events'], native_ticks)):
        gesture, step = divmod(index, 101)
        terminal = step == 100
        delta = 0 if terminal else (-12 if gesture % 2 == 0 else 12)
        phase = 4 if terminal else (1 if step == 0 else 2)
        canonical = {'atMs': gesture * 1000 + step * 8, 'x': x, 'y': y,
                     'dy': delta, 'phase': phase, 'momentum': 0}
        if expected != canonical:
            raise Inconclusive(f'planned event {index} does not match the bounded cadence trace')

        if actual['windowNumber'] != info['window'] or actual['deltaY'] != delta or actual['momentum'] != 0 or actual['phase'] != {1: 1, 2: 4, 4: 8}[phase]:
            raise Inconclusive(f'native event {index} has the wrong window, delta, or phase')

        if not finite(actual['locationX']) or not finite(actual['locationY']) or abs(actual['locationX'] - x) > 1 or abs(actual['locationY'] - (info['height'] - y)) > 1:
            raise Inconclusive(f'native event {index} missed the recorded viewport target')

        lower_delay = (ticks - bounds[1]) * tick_ms - expected['atMs']
        upper_delay = (ticks - bounds[0]) * tick_ms - expected['atMs']
        if lower_delay < -0.1 or upper_delay > 3:
            raise Inconclusive(f'native event {index} is outside its -0.1..3ms delivery tolerance: {lower_delay:g}..{upper_delay:g}ms')

        delays.append(upper_delay)
        if not terminal:
            wheel = wheels[browser_index]
            if wheel['dy'] != -delta or not all(finite(wheel[key]) for key in ['at', 'x', 'y']) or abs(wheel['x'] - x) > 1 or abs(wheel['y'] - y) > 1 or wheel.get('insideViewport') is False:
                raise Inconclusive(f'browser receipt {browser_index} missed the target or changed the native delta')
            browser_index += 1

    browser_times = [event['at'] for event in wheels]
    scrolls = observations['scrolls']
    if any(right < left for left, right in zip(browser_times, browser_times[1:])):
        raise Inconclusive('browser wheel receipt timestamps are not ordered')

    if not scrolls or any(not finite(sample['at']) or not finite(sample['top']) or not 0 <= sample['top'] <= box['max'] for sample in scrolls):
        raise Inconclusive('scroll observations are absent, invalid, or outside file content')

    if any(right['at'] < left['at'] for left, right in zip(scrolls, scrolls[1:])):
        raise Inconclusive('scroll observation timestamps are not ordered')

    endpoints = []
    for gesture in range(4):
        start = wheels[gesture * 100]['at']
        end = wheels[(gesture + 1) * 100]['at'] if gesture < 3 else math.inf
        samples = [sample['top'] for sample in scrolls if start <= sample['at'] < end]
        expected_end = box['scrollTop'] + (1200 if gesture % 2 == 0 else 0)
        if not samples or abs(samples[-1] - expected_end) > 1:
            raise Inconclusive(f'gesture {gesture + 1} did not complete its 1200px excursion or return')

        endpoints.append(samples[-1])

    positions = [box['scrollTop'], *(sample['top'] for sample in scrolls)]
    if not finite(observations['final']) or abs(max(positions) - min(positions) - 1200) > 1 or abs(observations['final'] - box['scrollTop']) > 1:
        raise Inconclusive('scroll range or final return differs from the 1200px trace')

    return {'native_events': 404, 'browser_nonzero_receipts': 400, 'native_lateness_ms': summarize(delays),
            'native_start_uncertainty_ms': (bounds[1] - bounds[0]) * tick_ms,
            'gesture_endpoints_px': endpoints, 'scroll_range_px': [min(positions), max(positions)],
            'final_scroll_top': observations['final'], 'target': {'x': x, 'y': y, 'window': info['window']}}


def default_crops(manifest):
    box = manifest['box']
    x = round(box['left']) + (150 if manifest['mode'] == 'graph' else 70)
    y = round(box['top']) + 68
    width = 126 if manifest['mode'] == 'graph' else 204
    height = min(550, math.floor(box['height']) - 100)

    return [{'name': 'text', 'x': x, 'y': y, 'width': width, 'height': height},
            {'name': 'text-inset', 'x': x + 30, 'y': y + 60, 'width': width - 30, 'height': height - 60}]


def validate_crops(crops, box):
    if len(crops) < 2 or len(crops) > 4 or len({crop['name'] for crop in crops}) != len(crops):
        raise Inconclusive('provide two to four distinctly named pixel crops')

    for crop in crops:
        if any(type(crop[key]) is not int for key in ['x', 'y', 'width', 'height']):
            raise Inconclusive('crop geometry must use integer capture pixels')

        if crop['width'] <= 0 or crop['height'] <= 0 or crop['width'] * crop['height'] > 150000:
            raise Inconclusive('each crop must contain 1..150000 pixels')

        if crop['x'] < box['left'] or crop['y'] < box['top'] or crop['x'] + crop['width'] > box['left'] + box['width'] or crop['y'] + crop['height'] > box['top'] + box['height']:
            raise Inconclusive('pixel crop is outside the recorded viewport')


def decode_pixels(movie, crop):
    expression = f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']},format=gray"
    result = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', str(movie),
                             '-vf', expression, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'],
                            check=True, capture_output=True, timeout=45)
    stride = crop['width'] * crop['height']
    if len(result.stdout) % stride:
        raise Inconclusive('pixel decoder returned a partial crop frame')

    data = memoryview(result.stdout)
    return [data[index:index + stride] for index in range(0, len(data), stride)]


def assess_pixels(times, frames, gesture_starts):
    if len(times) != len(frames) or len(frames) < 2 or any(not finite(value) for value in times):
        raise Inconclusive('pixel frames and finite capture times must have matching nonempty counts')

    if any(right <= left for left, right in zip(times, times[1:])):
        raise Inconclusive('capture display timestamps must strictly increase')

    if not frames[0] or any(len(frame) != len(frames[0]) for frame in frames):
        raise Inconclusive('decoded pixel frames must have consistent nonzero dimensions')

    differences = [sum(abs(left - right) for left, right in zip(previous, current)) / len(current)
                   for previous, current in zip(frames, frames[1:])]
    motion_groups = []
    idle = []
    idle_counts = []
    for start in gesture_starts:
        indices = [index for index, timestamp in enumerate(times[1:])
                   if times[index] >= start + 100 and timestamp <= start + 700]
        idle_indices = [index for index, timestamp in enumerate(times[1:])
                        if times[index] >= start + 850 and timestamp <= start + 950]
        if not indices:
            raise Inconclusive('capture has no comparisons in a gesture motion window')

        motion_groups.append(indices)
        idle.extend(differences[index] for index in idle_indices)
        idle_counts.append(len(idle_indices))

    if not idle:
        raise Inconclusive('capture has no idle comparisons for noise assessment')

    motion = [differences[index] for indices in motion_groups for index in indices]
    thresholds = {}
    for threshold in [1, 3, 5]:
        intervals = []
        unchanged_spans = []
        for indices in motion_groups:
            changes = [times[index + 1] for index in indices if differences[index] > threshold]
            intervals.extend(right - left for left, right in zip(changes, changes[1:]))
            span = 0
            for index in indices:
                if differences[index] <= threshold:
                    span += times[index + 1] - times[index]
                else:
                    unchanged_spans.append(span)
                    span = 0
            unchanged_spans.append(span)

        thresholds[str(threshold)] = {'changed_comparisons': sum(value > threshold for value in motion),
                                      'unchanged_comparisons': sum(value <= threshold for value in motion),
                                      'observed_change_intervals_ms': summarize(intervals),
                                      'longest_observed_unchanged_span_ms': max(unchanged_spans),
                                      'change_intervals_ms': intervals}

    return {'capture_frames': len(frames), 'motion_comparisons': len(motion),
            'idle_comparisons_by_gesture': idle_counts,
            'mean_absolute_gray_difference': summarize(motion), 'idle_gray_difference': summarize(idle),
            'capture_gaps_ms': summarize([right - left for left, right in zip(times, times[1:])]),
            'motion_capture_gaps_ms': summarize([times[index + 1] - times[index] for indices in motion_groups for index in indices]),
            'thresholds': thresholds}


def assess_recording(capture, delivery, decoded):
    validate_capture(capture, [len(frames) for frames in decoded.values()])
    validate_temporal_coverage(capture, delivery)
    tick_ms = delivery['timebaseNumer'] / delivery['timebaseDenom'] / 1e6
    origin = int(delivery['events'][0]['machTicks'])
    times = [(ticks - origin) * tick_ms for ticks in mach_ticks(capture['samples'], 'displayMachTicks')]
    starts = [(int(delivery['events'][gesture * 101]['machTicks']) - origin) * tick_ms for gesture in range(4)]

    return {name: assess_pixels(times, frames, starts) for name, frames in decoded.items()}


def validate_resources(resources, manifest):
    before, after = resources['before'], resources['after']
    pids = resources['processes_before']
    if not pids or pids != resources['processes_after'] or set(before) != set(pids) or set(after) != set(pids):
        raise Inconclusive('resource process identifiers changed or snapshots are incomplete')

    if pids != manifest['processes'] or pids.get('host') != manifest['info']['pid']:
        raise Inconclusive('resource snapshots do not belong to the recorded native run')

    if any(type(pid) is not int or pid <= 0 for pid in [*pids.values(), *manifest['processes'].values(), manifest['info']['pid']]):
        raise Inconclusive('resource process identifiers must be positive integers')

    first_bracket = resources['before_snapshot_monotonic_ns']
    last_bracket = resources['after_snapshot_monotonic_ns']
    if len(first_bracket) != 2 or len(last_bracket) != 2 or any(type(value) is not int or value <= 0 for value in [*first_bracket, *last_bracket]):
        raise Inconclusive('snapshot timestamp brackets must contain two positive integer nanoseconds')

    if not first_bracket[0] <= first_bracket[1] < last_bracket[0] <= last_bracket[1]:
        raise Inconclusive('resource snapshot brackets must be ordered and separated')

    for role in pids:
        if any(type(value) is not int or value < 0 for sample in [before[role], after[role]] for value in sample.values()):
            raise Inconclusive(f'{role} resource counters, memory and identities must be nonnegative integers')

        if before[role]['start'] <= 0 or before[role]['start'] != after[role]['start'] or before[role]['exit'] or after[role]['exit']:
            raise Inconclusive(f'{role} process exited or its start identity changed')

    numer, denom = resources['timebase']['numer'], resources['timebase']['denom']
    if type(numer) is not int or type(denom) is not int or numer <= 0 or denom <= 0:
        raise Inconclusive('resource timebase must have positive integer values')

    scale = numer / denom
    results = {}
    for role in pids:
        first, last = before[role], after[role]
        counters = {key: last[key] - first[key] for key in ['user', 'system', 'read_bytes', 'write_bytes', 'pageins', 'wakeups', 'interrupts']}
        if any(value < 0 for value in counters.values()):
            raise Inconclusive(f'{role} resource counters decreased')

        cpu_ms = (counters['user'] + counters['system']) * scale / 1e6
        results[role] = {'pid': pids[role], 'start_identity': first['start'], 'raw_counter_deltas': counters,
                         'cpu_ms': cpu_ms,
                         'resident_before_bytes': first['resident'], 'resident_after_bytes': last['resident'],
                         'footprint_before_bytes': first['footprint'], 'footprint_after_bytes': last['footprint'],
                         'footprint_change_bytes': last['footprint'] - first['footprint']}

    interval = [(last_bracket[0] - first_bracket[1]) / 1e9, (last_bracket[1] - first_bracket[0]) / 1e9]
    return {'observation_interval_seconds_bounds': interval, 'processes': results,
            'memory_scope': 'endpoint resident size and physical footprint, not peak memory'}


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def analyze(directory, *, manifest_path=None, box_path=None, crops_path=None, resources=False):
    directory = Path(directory)
    manifest_path = Path(manifest_path) if manifest_path else directory / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    workload = validate_workload_admission(directory, manifest)
    files = [manifest_path, directory / 'input.json', directory / 'native-input.json', directory / 'observations.json']
    if box_path:
        box_path = Path(box_path)
        manifest['box'] = json.loads(box_path.read_text())
        files.append(box_path)

    planned, delivery, observations = [json.loads(path.read_text()) for path in files[1:4]]
    result = {'verdict': 'valid', 'mode': manifest['mode'], 'rerun': False,
              'workload_admission': workload,
              'input': validate_input(manifest, planned, delivery, observations)}
    if workload['verdict'] == 'admitted':
        files.append(directory / 'process-admission.json')
    if resources:
        resource_path = directory / 'resources.json'
        calibration_path = directory / 'cpu-calibration.json'
        usage = json.loads(resource_path.read_text())
        calibration = json.loads(calibration_path.read_text())
        lower, upper = calibration['process_time_ns_bracket']
        if not lower <= calibration['converted_ns'] <= upper or calibration['timebase'] != usage['timebase']:
            raise Inconclusive('resource CPU calibration failed or used a different timebase')

        result['resources'] = validate_resources(usage, manifest)
        files.extend([resource_path, calibration_path])
    else:
        crops = manifest.get('crops', default_crops(manifest))
        if crops_path:
            crops_path = Path(crops_path)
            crops = json.loads(crops_path.read_text())
            files.append(crops_path)

        validate_crops(crops, manifest['box'])
        capture_path = directory / 'capture.mov.json'
        movie = directory / 'capture.mov'
        capture = json.loads(capture_path.read_text())
        validate_capture(capture, [])
        validate_temporal_coverage(capture, delivery)
        decoded = {crop['name']: decode_pixels(movie, crop) for crop in crops}
        result['pixels'] = assess_recording(capture, delivery, decoded)
        result['crops'] = crops
        result['scope'] = 'Recorded pixel differences at capture timestamps; capture gaps and unchanged spans do not measure physical display FPS.'
        result['requested_refresh_rate'] = manifest.get('requested_refresh_rate', manifest['display'].get('requestedRefreshRate'))
        result['reported_display_mode_refresh_rate'] = manifest['display'].get('actualRefreshRate')
        files.extend([capture_path, movie])

    result['provenance'] = {'input_files_sha256': {str(path.resolve()): file_hash(path) for path in files},
                            'analysis_sha256': file_hash(Path(__file__)),
                            'capture_validation_sha256': file_hash(Path(__file__).with_name('analysis.py')),
                            'manifest_override': bool(manifest_path != directory / 'manifest.json'),
                            'box_override': bool(box_path), 'crops_override': bool(crops_path)}

    return result


def main():
    parser = argparse.ArgumentParser(description='Analyze preserved cadence evidence without modifying its source records.')
    parser.add_argument('directory', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='exclusive new JSON file')
    parser.add_argument('--manifest', type=Path, help='explicit metadata for an existing prototype recording')
    parser.add_argument('--box', type=Path, help='explicit recorded viewport JSON')
    parser.add_argument('--crops', type=Path, help='explicit list of recorded pixel crop rectangles')
    parser.add_argument('--resources', action='store_true')
    args = parser.parse_args()
    with args.output.open('x') as destination:
        try:
            result = analyze(args.directory, manifest_path=args.manifest, box_path=args.box,
                             crops_path=args.crops, resources=args.resources)
            status = 0
        except (Inconclusive, KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError) as error:
            result = {'verdict': 'inconclusive', 'reason': str(error), 'rerun': False}
            status = 2
        destination.write(json.dumps(result, indent=2) + '\n')

    print(json.dumps(result, indent=2))
    return status


if __name__ == '__main__':
    sys.exit(main())
