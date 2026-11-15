import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time

from fixture import create_fixture
from processes import stop_app

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE.parent / 'diff-scroll'))
from analysis import Inconclusive, mach_ticks, validate_capture
from run import evaluate, place_window, request, save, until, visible_window, wait_ready


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


SYSTEM = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
SYSTEM.mach_absolute_time.restype = ctypes.c_uint64
TIMEBASE = Timebase()
if SYSTEM.mach_timebase_info(ctypes.byref(TIMEBASE)) != 0:
    raise RuntimeError('mach_timebase_info failed')


CLICK = r'''(target => {
  const matches = [...document.querySelectorAll('[data-testid="commit-row"]')].filter(row =>
    getComputedStyle(row).visibility !== 'hidden' && row.getClientRects().length > 0 &&
    row.querySelector('[data-testid="commit-row-summary"]')?.textContent.trim() === target.summary);
  if (matches.length !== 1) throw new Error(`expected one target row, found ${matches.length}`);
  const row = matches[0];
  let receipt;
  row.addEventListener('click', event => {
    receipt = {pageMilliseconds: performance.now(), eventTimestamp: event.timeStamp,
      isTrusted: event.isTrusted, type: event.type, summary: target.summary, oid: target.oid,
      targetHtml: event.target.outerHTML, rowBounds: row.getBoundingClientRect().toJSON()};
  }, {capture: true, once: true});
  const beforeDispatch = performance.now();
  row.click();
  const afterDispatch = performance.now();
  if (!receipt || receipt.pageMilliseconds < beforeDispatch || receipt.pageMilliseconds > afterDispatch) {
    throw new Error('click delivery was not observed inside the dispatch interval');
  }
  return {beforeDispatch, afterDispatch, receipt};
})'''


READY = r'''(target => {
  const detail = document.querySelector('[data-testid="commit-detail"]');
  if (!detail || detail.querySelector('[title="Copy SHA"]')?.textContent.trim() !== target.oid.slice(0, 7) ||
      detail.querySelector('.summary')?.textContent.trim() !== target.summary) return false;
  for (let node = detail; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || node.inert || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  }
  const rows = [...detail.querySelectorAll('[data-testid="staging-file"]')];
  if (rows.length !== target.files || !rows.every((row, index) =>
      row.textContent.includes('file-' + String(index).padStart(4, '0') + '.ts'))) return false;
  const selected = [...document.querySelectorAll('[data-testid="commit-row"][aria-selected="true"]')]
    .filter(row => getComputedStyle(row).visibility !== 'hidden');
  if (selected.length !== 1 || selected[0].querySelector('[data-testid="commit-row-summary"]')?.textContent.trim() !== target.summary) return false;
  if (!detail.textContent.includes(target.files + ' files changed') || rows[0].getBoundingClientRect().height <= 0) return false;
  return {pageMilliseconds: performance.now(), selectedSummary: target.summary,
    shortOid: detail.querySelector('[title="Copy SHA"]').textContent.trim(),
    detailSummary: detail.querySelector('.summary').textContent.trim(), fileCount: rows.length,
    detailBounds: detail.getBoundingClientRect().toJSON(),
    headerBounds: detail.querySelector('[title="Copy SHA"]').getBoundingClientRect().toJSON()};
})'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def timed_evaluate(directory, expression):
    lower = SYSTEM.mach_absolute_time()
    result = evaluate(directory, expression)
    upper = SYSTEM.mach_absolute_time()
    return {'machLower': str(lower), 'machUpper': str(upper), 'result': result}


def record_selections(directory, output, args, commits, window):
    events = []
    recorder = None
    with (output / 'capture.stderr.log').open('w') as errors:
        try:
            recorder = subprocess.Popen(
                [str(args.recorder), str(window['window']), str(output / 'capture.mov'), '5'],
                stdout=subprocess.PIPE, stderr=errors, text=True)
            readable, _, _ = select.select([recorder.stdout], [], [], 15)
            first_line = recorder.stdout.readline() if readable else ''
            if not first_line.startswith('READY first-frame '):
                raise Inconclusive('recorder did not announce its first encoded frame')

            origin = time.monotonic()
            save(output / 'recorder-ready.json', {'line': first_line.strip(), 'hostMonotonic': origin,
                                                'machTicks': str(SYSTEM.mach_absolute_time())})
            for revision, offset in [(2, 0.3), (1, 1.7), (2, 3.1)]:
                remaining = origin + offset - time.monotonic()
                if remaining > 0:
                    time.sleep(remaining)

                target = {'summary': f'fixture revision {revision}', 'oid': commits[revision], 'files': args.files}
                actual_start = time.monotonic()
                delivery = timed_evaluate(directory, CLICK + '(' + json.dumps(target) + ')')
                event = {'target': target, 'plannedOffsetSeconds': offset,
                         'actualRequestOffsetSeconds': actual_start - origin, 'delivery': delivery}
                events.append(event)
                save(output / 'inputs.json', events)
                readiness = READY + '(' + json.dumps(target) + ')'
                event['domComplete'] = timed_evaluate(directory,
                    'window.__trunkDrive.until(' + json.dumps(readiness) + ')')
                save(output / 'inputs.json', events)

            stdout, _ = recorder.communicate(timeout=15)
            (output / 'capture.stdout.log').write_text(first_line + stdout)
            if recorder.returncode != 0:
                raise Inconclusive(f'recorder exited {recorder.returncode}')
        finally:
            if recorder is not None and recorder.poll() is None:
                try:
                    stdout, _ = recorder.communicate(timeout=10)
                    (output / 'capture.remaining.stdout.log').write_text(stdout)
                except subprocess.TimeoutExpired:
                    recorder.terminate()
                    recorder.wait(timeout=5)

    return events


def decode_and_validate(output, events):
    frames = output / 'frames'
    frames.mkdir()
    subprocess.run(['ffmpeg', '-v', 'error', '-threads', '1', '-i', str(output / 'capture.mov'),
                    '-fps_mode', 'passthrough', '-threads', '1', str(frames / 'frame-%04d.png')],
                   check=True, timeout=45)
    timestamps = json.loads(subprocess.check_output(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'frame=best_effort_timestamp_time', '-of', 'json', str(output / 'capture.mov')], timeout=30))['frames']
    capture = json.loads((output / 'capture.mov.json').read_text())
    images = sorted(frames.glob('frame-*.png'))
    validate_capture(capture, [len(images), len(timestamps)])
    ticks = mach_ticks(capture['samples'], 'displayMachTicks')
    if ticks[0] > int(events[0]['delivery']['machLower']) or ticks[-1] < int(events[-1]['delivery']['machUpper']):
        raise Inconclusive('encoded frames do not bracket all click-dispatch intervals')

    entries = []
    for index, (sample, timestamp, image) in enumerate(zip(capture['samples'], timestamps, images)):
        if sample['frame'] != index + 1 or abs(sample['seconds'] - float(timestamp['best_effort_timestamp_time'])) > 0.002:
            raise Inconclusive('decoded frame order or timestamps differ from recorder metadata')
        entries.append({**sample, 'image': str(image.relative_to(output)), 'imageSha256': digest(image)})
    save(output / 'frames.json', entries)

    scale = TIMEBASE.numer / TIMEBASE.denom / 1e6
    review = []
    for event in events:
        lower, upper = (int(event['delivery'][key]) for key in ['machLower', 'machUpper'])
        candidates = [entry for entry in entries
                      if lower - 100 / scale <= int(entry['displayMachTicks']) <= upper + 800 / scale]
        review.append({'target': event['target'], 'deliveryMachLower': str(lower), 'deliveryMachUpper': str(upper),
                       'deliveryBracketMs': (upper - lower) * scale,
                       'candidateFrames': [entry['frame'] for entry in candidates],
                       'lastFrameBeforeVisibleSelection': None, 'firstFrameWithVisibleSelection': None,
                       'lastFrameBeforeCorrectDetail': None, 'firstFrameWithCorrectDetail': None,
                       'blankOrMismatchedFrames': None, 'reviewedBy': None})
    save(output / 'review.json', {
        'complete': False, 'observations': review,
        'instructions': 'Inspect actual decoded images, including neighboring frames. Confirm highlighted row, short OID, summary and file list separately. Null fields mean unreviewed, never absence. Review all frames in each selected interval before claiming no observed blank or mismatch. Frame gaps limit coverage.',
        'latencyBounds': 'Only after independent frame classification: with last incorrect/old frame L and first correct frame U, input bracket [a,b], a conservative first-visible latency interval is [max(0,L-b), U-a], converted with the manifest timebase. Retain actual gaps and absent-bound cases. These are observational bounds, not display-frame-drop counts.'})
    save(output / 'capture-validation.json', {
        'captureValid': True, 'visualReviewComplete': False, 'encodedFrames': len(entries),
        'inputsObserved': len(events), 'firstDisplayMachTicks': str(ticks[0]), 'lastDisplayMachTicks': str(ticks[-1]),
        'maximumEncodedFrameGapMs': max((right - left) * scale for left, right in zip(ticks, ticks[1:])),
        'limitations': 'Recorded complete frames bracket input dispatch; idle statuses are not encoded images. This does not establish continuous presentation coverage or zero dropped display frames.'})


def run(args):
    output = args.output
    harness = output / 'harness'
    harness.mkdir()
    for source in [Path(__file__), SOURCE / 'fixture.py', SOURCE / 'processes.py']:
        shutil.copy2(source, harness / source.name)
    for name in ['run.py', 'analysis.py']:
        shutil.copy2(SOURCE.parent / 'diff-scroll' / name, harness / ('diff-scroll-' + name))
    manifest = {'label': args.label, 'binary': str(args.binary), 'binarySha256': digest(args.binary),
                'nativeProbe': str(args.native_probe), 'nativeProbeSha256': digest(args.native_probe),
                'recorder': str(args.recorder), 'recorderSha256': digest(args.recorder),
                'files': args.files, 'lines': 200, 'graphStats': args.graph_stats,
                'harnessHashes': {path.name: digest(path) for path in harness.iterdir()},
                'timebase': {'numer': TIMEBASE.numer, 'denom': TIMEBASE.denom},
                'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'inputMethod': 'Synthetic DOM click through the production row handler. A capture-phase listener records actual delivery in the page clock; host Mach timestamps bracket the same synchronous evaluation. This is not native pointer or physical-device input latency.',
                'presentation': 'ScreenCaptureKit window recording on a requested 1280x800 60 Hz virtual display. No rAF-derived frame count or automatic OCR classification.',
                'resourceMeasurements': 'None: recording and image decoding are separate from resource trials.'}
    save(output / 'manifest.json', manifest)
    with tempfile.TemporaryDirectory(prefix='trunk-selection-capture-', dir='/tmp') as temporary:
        directory = Path(temporary)
        repo = directory / 'repo'
        commits = create_fixture(repo, args.files, 200)
        manifest['commits'] = commits
        manifest['fixtureHashes'] = {path.name: digest(path) for path in sorted(repo.glob('*.ts'))}
        data = directory / 'data'
        data.mkdir()
        save(data / 'trunk-prefs.json', {'open_tabs': [{'id': 'capture', 'repoPath': str(repo), 'repoName': 'selection capture'}],
             'active_tab_id': 'capture', 'fetch_interval_ms': 0, 'column_visibility': {'diff': args.graph_stats}})
        environment = {**os.environ, 'TRUNK_DRIVE_DIR': str(directory), 'TRUNK_DATA_DIR': str(data),
                       'DYLD_INSERT_LIBRARIES': str(args.native_probe)}
        with (output / 'app.log').open('w') as log:
            app = subprocess.Popen([str(args.binary)], env=environment, stdout=log, stderr=log)
            try:
                wait_ready(directory, app)
                until(directory, '[...document.querySelectorAll("[data-testid=commit-row-summary]")].some(e=>e.textContent.trim()==="fixture revision 2")')
                graph = evaluate(directory, 'window.__TAURI_INTERNALS__.invoke("get_commit_graph", ' +
                                 json.dumps({'path': str(repo), 'offset': 0}) + ')')
                for revision, oid in enumerate(commits):
                    matches = [commit for commit in graph['commits'] if commit['summary'] == f'fixture revision {revision}']
                    if len(matches) != 1 or matches[0]['oid'] != oid:
                        raise Inconclusive('graph row summary does not uniquely identify expected fixture OID')

                manifest['virtualDisplay'] = request(directory, {'op': 'virtual-display'}, native=True)
                manifest['placement'] = place_window(directory)
                window = visible_window(directory)
                if window['pid'] != app.pid:
                    raise Inconclusive('capture window belongs to another process')
                manifest['window'] = window
                manifest['drawing'] = request(directory, {'op': 'drawing'})
                manifest['processInventory'] = subprocess.check_output(['ps', '-axo', 'pid=,pcpu=,comm='], text=True)
                save(output / 'manifest.json', manifest)
                events = record_selections(directory, output, args, commits, window)
                target = {'summary': 'fixture revision 2', 'oid': commits[2], 'files': args.files}
                final = evaluate(directory, READY + '(' + json.dumps(target) + ')')
                if not final:
                    raise Inconclusive('final selected row and detail identity do not agree')
                save(output / 'final-dom.json', final)
                request(directory, {'op': 'snapshot', 'path': str(output / 'final.png')})
            finally:
                stop_app(app, lambda: request(directory, {'op': 'quit'}))

    decode_and_validate(output, events)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--native-probe', type=Path, required=True)
    parser.add_argument('--recorder', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--files', type=int, choices=[10, 100, 1000], default=100)
    parser.add_argument('--graph-stats', action=argparse.BooleanOptionalAction, required=True)
    args = parser.parse_args()
    for name in ['binary', 'native_probe', 'recorder']:
        setattr(args, name, getattr(args, name).resolve(strict=True))
    args.output = args.output.resolve()
    args.output.mkdir(exist_ok=False)
    try:
        with Path('/tmp/trunk-native-diff-scroll.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            run(args)
    except Exception as error:
        save(args.output / 'failure.json', {'captureValid': False, 'error': str(error)})
        raise


if __name__ == '__main__':
    main()
