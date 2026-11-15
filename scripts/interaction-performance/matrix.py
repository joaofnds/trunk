import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from fixture import create_fixture
from processes import stop_app

SOURCE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('interaction_runtime', SOURCE / 'run.py')
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def marker(index, label):
    return f'export const matrix_marker_{label}_{index} = "matrix marker {label} file {index}";'


def modify_file(repo, index):
    path = repo / f'file-{index:04d}.ts'
    original = path.read_text().splitlines()
    changed = original[:5] + [marker(index, 'a'), marker(index, 'a2')] + original[5:105] + [marker(index, 'b')] + original[105:]
    path.write_text('\n'.join(changed) + '\n')
    return [marker(index, label) for label in ['a', 'a2', 'b']]


def flows(repo, second, commits):
    paths = ['file-0000.ts', 'file-0001.ts']
    dirty = {'staged': [], 'unstaged': paths}
    partial = {'staged': [paths[0]], 'unstaged': paths}
    staged = {'staged': paths, 'unstaged': []}
    first_staged = {'staged': [paths[0]], 'unstaged': [paths[1]]}
    all_markers = [marker(0, label) for label in ['a', 'a2', 'b']]
    yield {'op': 'select-commit', 'summary': 'fixture revision 2', 'oid': commits[2], 'fileCount': 10}
    for index in [0, 1, 0]:
        yield {'op': 'commit-file', 'oid': commits[2], 'path': paths[index], 'content': f'file {index} revision 1 line 0'}
    yield {'op': 'rapid-files', 'oid': commits[2], 'sequence': [paths[1], paths[0], paths[1], paths[0]],
           'spacingMs': 20, 'path': paths[0], 'content': 'file 0 revision 1 line 0'}
    yield {'op': 'close-diff', 'requirePager': True}
    yield {'op': 'history-key', 'key': 'j', 'oid': commits[1]}
    yield {'op': 'history-key', 'key': 'k', 'oid': commits[2]}
    yield {'op': 'search-open-native'}
    yield {'op': 'search', 'query': 'fixture revision 1', 'oid': commits[1]}
    yield {'op': 'rapid-search', 'sequence': ['fixture revision 2', 'fixture revision 1', 'fixture revision 2'],
           'spacingMs': 20, 'query': 'fixture revision 2', 'oid': commits[2]}
    yield {'op': 'close-search'}
    yield {'op': 'close-detail', 'expectedStatus': dirty}
    yield {'op': 'working-file', 'kind': 'unstaged', 'path': paths[0], 'content': marker(0, 'a')}
    yield {'op': 'stage-line', 'path': paths[0], 'marker': marker(0, 'a'), 'button': 'Stage Lines (1)',
           'command': 'stage_lines', 'expectedStatus': partial,
           'expectedMarkers': {'staged': [marker(0, 'a')], 'unstaged': [marker(0, 'a2'), marker(0, 'b')]}}
    yield {'op': 'working-file', 'kind': 'staged', 'path': paths[0], 'content': marker(0, 'a')}
    yield {'op': 'unstage-line', 'path': paths[0], 'marker': marker(0, 'a'), 'button': 'Unstage Lines (1)',
           'command': 'unstage_lines', 'expectedStatus': dirty,
           'expectedMarkers': {'staged': [], 'unstaged': all_markers}}
    yield {'op': 'working-file', 'kind': 'unstaged', 'path': paths[0], 'content': marker(0, 'a')}
    yield {'op': 'stage-hunk', 'path': paths[0], 'button': 'Stage Hunk', 'command': 'stage_hunk',
           'expectedStatus': partial,
           'expectedMarkers': {'staged': [marker(0, 'a'), marker(0, 'a2')], 'unstaged': [marker(0, 'b')]}}
    yield {'op': 'working-file', 'kind': 'staged', 'path': paths[0], 'content': marker(0, 'a')}
    yield {'op': 'unstage-hunk', 'path': paths[0], 'button': 'Unstage Hunk', 'command': 'unstage_hunk',
           'expectedStatus': dirty, 'expectedMarkers': {'staged': [], 'unstaged': all_markers}}
    yield {'op': 'stage-file', 'kind': 'unstaged', 'path': paths[0], 'button': 'Stage file',
           'command': 'stage_file', 'expectedStatus': first_staged,
           'expectedMarkers': {'staged': all_markers, 'unstaged': []}}
    yield {'op': 'unstage-file', 'kind': 'staged', 'path': paths[0], 'button': 'Unstage file',
           'command': 'unstage_file', 'expectedStatus': dirty,
           'expectedMarkers': {'staged': [], 'unstaged': all_markers}}
    yield {'op': 'stage-all', 'button': 'Stage all changes', 'command': 'stage_all', 'expectedStatus': staged}
    yield {'op': 'unstage-all', 'button': 'Unstage all', 'command': 'unstage_all', 'expectedStatus': dirty}
    yield {'op': 'stage-all', 'button': 'Stage all changes', 'command': 'stage_all', 'expectedStatus': staged}
    yield {'op': 'commit', 'subject': 'interaction matrix commit', 'parent': commits[2], 'changedFiles': paths,
           'committedMarkers': {path: [marker(index, label) for label in ['a', 'a2', 'b']] for index, path in enumerate(paths)}}
    for tab, path, expected in [('second', second, {'staged': [], 'unstaged': ['file-0009.ts']}),
                                ('perf', repo, {'staged': [], 'unstaged': []}),
                                ('second', second, {'staged': [], 'unstaged': ['file-0009.ts']}),
                                ('perf', repo, {'staged': [], 'unstaged': []})]:
        yield {'op': 'repo-tab', 'tab': tab, 'repo': str(path), 'expectedStatus': expected}
    yield {'op': 'review-view', 'open': True}
    yield {'op': 'finder-open', 'fileCount': 10}
    yield {'op': 'finder-search', 'path': 'file-0003.ts'}
    yield {'op': 'finder-pick', 'path': 'file-0003.ts', 'content': 'file 3 revision 2 line 0'}
    yield {'op': 'close-diff', 'returnTo': 'review'}
    yield {'op': 'review-view', 'open': False}
    files = [f'file-{index:04d}.ts' for index in range(10)]
    yield {'op': 'select-commit', 'summary': 'fixture revision 2', 'oid': commits[2], 'fileCount': 10}
    yield {'op': 'rapid-history', 'sequence': ['j', 'j'], 'summary': 'fixture revision 0',
           'oid': commits[0], 'files': files}
    yield {'op': 'rapid-history', 'sequence': ['k', 'k'], 'summary': 'fixture revision 2',
           'oid': commits[2], 'files': files}
    yield {'op': 'close-detail', 'expectedStatus': {'staged': [], 'unstaged': []}}
    added = {'group/a.txt': 'directory member a\n', 'group/b.txt': 'directory member b\n',
             'group-neighbor/c.txt': 'outside selected directory\n'}
    directory_dirty = {'staged': [], 'unstaged': list(added)}
    directory_staged = {'staged': ['group/a.txt', 'group/b.txt'], 'unstaged': ['group-neighbor/c.txt']}
    tree_dirty = {'staged': [], 'unstaged': [{'name': 'group', 'count': 2}, {'name': 'group-neighbor', 'count': 1}]}
    tree_staged = {'staged': [{'name': 'group', 'count': 2}], 'unstaged': [{'name': 'group-neighbor', 'count': 1}]}
    yield {'op': 'tree-view', 'open': True, 'prepareFiles': added, 'treeStatus': tree_dirty,
           'expectedStatus': directory_dirty, 'expectedAddedFiles': added}
    yield {'op': 'stage-directory', 'kind': 'unstaged', 'directory': 'group', 'button': 'Stage directory',
           'command': 'stage_files', 'treeStatus': tree_staged, 'expectedStatus': directory_staged, 'expectedAddedFiles': added}
    yield {'op': 'unstage-directory', 'kind': 'staged', 'directory': 'group', 'button': 'Unstage directory',
           'command': 'unstage_files', 'treeStatus': tree_dirty, 'expectedStatus': directory_dirty, 'expectedAddedFiles': added}
    yield {'op': 'tree-view', 'open': False, 'expectedStatus': directory_dirty, 'expectedAddedFiles': added}
    failure_status = {'staged': ['group/a.txt'], 'unstaged': ['group/b.txt', 'group-neighbor/c.txt']}
    yield {'op': 'stage-file', 'kind': 'unstaged', 'path': 'group/a.txt', 'button': 'Stage file',
           'command': 'stage_file', 'expectedStatus': failure_status, 'expectedAddedFiles': added}
    yield {'op': 'commit-failure', 'subject': 'interaction matrix rejected commit',
           'expectedStatus': failure_status, 'expectedAddedFiles': added,
           'hookMessage': 'interaction matrix refuses this fixture commit'}
    for pane, key in [('left', 'Meta+j'), ('right', 'Meta+k')]:
        for opened in [False, True]:
            yield {'op': 'pane-toggle', 'pane': pane, 'key': key, 'open': opened,
                   'draft': 'interaction matrix rejected commit'}
    for _ in range(2):
        yield {'op': 'ref-navigate', 'ref': 'main', 'summary': 'interaction matrix commit',
               'files': ['file-0000.ts', 'file-0001.ts']}


def git_read(repo, *arguments):
    return subprocess.check_output(['git', '-C', str(repo), *arguments], env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})


def blob_oid(content):
    raw = content.encode()
    return hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest()


def exact_git_state(repo, state, spec, result):
    if spec.get('expectedStatus'):
        staged = spec['expectedStatus']['staged']
        state['index'] = {**state['head']}
        for path in staged:
            state['index'][path] = state['worktree'][path]
        if spec.get('expectedMarkers'):
            path = spec['path']
            wanted = spec['expectedMarkers']['staged']
            state['index'][path] = ''.join(line for line in state['worktree'][path].splitlines(keepends=True)
                                         if 'matrix_marker_' not in line or line.strip() in wanted)
    if spec['op'] == 'commit':
        state['head'] = {**state['index']}
        state['oid'] = result['oracle']['head']['oid']

    actual_head = git_read(repo, 'rev-parse', 'HEAD').decode().strip()
    if actual_head != state['oid']:
        raise RuntimeError(f'independent Git HEAD mismatch: {actual_head} != {state["oid"]}')

    if spec['op'] == 'commit':
        headers, message = git_read(repo, 'cat-file', 'commit', 'HEAD').decode().split('\n\n', 1)
        parents = [line.removeprefix('parent ') for line in headers.splitlines() if line.startswith('parent ')]
        if parents != [spec['parent']] or message.strip() != spec['subject']:
            raise RuntimeError('independent Git commit parent/message mismatch')

    index = {}
    for entry in git_read(repo, 'ls-files', '--stage', '-z').split(b'\0'):
        if entry:
            metadata, path = entry.split(b'\t', 1)
            mode, oid, stage = metadata.decode().split()
            if mode != '100644' or stage != '0':
                raise RuntimeError(f'unexpected index mode/stage: {entry!r}')
            index[path.decode()] = oid
    head = {}
    for entry in git_read(repo, 'ls-tree', '-r', '-z', 'HEAD').split(b'\0'):
        if entry:
            metadata, path = entry.split(b'\t', 1)
            mode, kind, oid = metadata.decode().split()
            if mode != '100644' or kind != 'blob':
                raise RuntimeError(f'unexpected HEAD entry: {entry!r}')
            head[path.decode()] = oid
    expected_index = {path: blob_oid(content) for path, content in state['index'].items()}
    expected_head = {path: blob_oid(content) for path, content in state['head'].items()}
    if index != expected_index or head != expected_head:
        raise RuntimeError(f'independent Git contents mismatch: {json.dumps({"index": index, "expectedIndex": expected_index, "head": head, "expectedHead": expected_head})}')
    actual_paths = {str(path.relative_to(repo)) for path in repo.rglob('*') if path.is_file() and '.git' not in path.relative_to(repo).parts}
    if actual_paths != set(state['worktree']):
        raise RuntimeError(f'working-tree path set changed: {sorted(actual_paths)}')
    for path, content in state['worktree'].items():
        if (repo / path).read_bytes() != content.encode():
            raise RuntimeError(f'working-tree content changed: {path}')
    return {'head': actual_head, 'head_blobs': head, 'index_blobs': index,
            'worktree_sha256': {path: hashlib.sha256(content.encode()).hexdigest() for path, content in state['worktree'].items()},
            'interval': 'after resource snapshot; read-only independent Git processes and full working-tree bytes'}


def rejected_commit(directory, spec):
    expression = f'window.interactionFlows.run({json.dumps(spec)})'
    runtime.evaluate(directory, f'(()=>{{window.interactionFlowPending={expression}.then(value=>({{ok:true,value}}),error=>({{ok:false,error:String(error)}}));return true}})()')
    before_alert = time.monotonic()
    dialog = runtime.request(directory, {'op': 'alert'})
    after_alert = time.monotonic()
    if not any(spec['hookMessage'] in text for text in dialog['texts']) or dialog['buttons'] != ['OK']:
        raise RuntimeError(f'unexpected commit rejection dialog: {dialog}')
    runtime.request(directory, {'op': 'press', 'button': 'OK'})
    reply = runtime.evaluate(directory, 'window.interactionFlowPending')
    if not reply['ok']:
        raise RuntimeError(reply['error'])
    return {**reply['value'], 'native_dialog': dialog, 'dialog_observation_seconds': [before_alert, after_alert],
            'endpointLimit': 'DOM usable includes harness dismissal of the verified native rejection dialog; not an unattended interaction latency. HEAD, draft, complete index and working-tree content must be preserved.'}


def native_search(directory):
    before = runtime.evaluate(directory, 'performance.now()')
    runtime.request(directory, {'op': 'menu-bar', 'path': ['Edit', 'Find']})
    runtime.until(directory, '(()=>{const e=document.querySelector("input.search-bar-input");return e&&getComputedStyle(e).visibility!=="hidden"})()')
    after = runtime.evaluate(directory, 'performance.now()')
    return {'op': 'search-open-native', 'start': before, 'usable': after,
            'feedback': None, 'backgroundSettled': None,
            'endpointLimit': 'Upper-bound page-clock interval includes socket requests and native menu dispatch; DOM presence, not presentation.'}


def run_round(args, round_number):
    output = args.output / f'{round_number:02d}'
    output.mkdir()
    harness = output / 'harness'
    harness.mkdir()
    for name in ['matrix.py', 'flows.js', 'observe.js', 'fixture.py', 'run.py', 'processes.py']:
        shutil.copy2(SOURCE / name, harness / name)
    shutil.copy2(SOURCE.parent / 'diff-scroll/run.py', harness / 'diff-scroll-run.py')
    results = []
    attempt = {}
    pids = None
    with tempfile.TemporaryDirectory(prefix='trunk-interaction-matrix-', dir='/tmp') as temporary:
        directory = Path(temporary)
        repo = directory / 'repo'
        second = directory / 'second'
        commits = create_fixture(repo, 10, 200)
        create_fixture(second, 10, 200)
        states = {}
        for path in [repo, second]:
            original = {file.name: file.read_text() for file in path.glob('*.ts')}
            states[str(path)] = {'head': original, 'index': {**original}, 'oid': commits[2]}
        for index in [0, 1]:
            modify_file(repo, index)
        modify_file(second, 9)
        for path in [repo, second]:
            states[str(path)]['worktree'] = {file.name: file.read_text() for file in path.glob('*.ts')}
        for path in [repo, second]:
            with (path / '.git/config').open('a') as config:
                config.write('[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\n')

        data = directory / 'data'
        data.mkdir()
        runtime.save(data / 'trunk-prefs.json', {
            'open_tabs': [{'id': 'perf', 'repoPath': str(repo), 'repoName': 'matrix one'},
                          {'id': 'second', 'repoPath': str(second), 'repoName': 'matrix two'}],
            'active_tab_id': 'perf', 'fetch_interval_ms': 0})
        environment = {**os.environ, 'TRUNK_DRIVE_DIR': str(directory), 'TRUNK_DATA_DIR': str(data),
                       'DYLD_INSERT_LIBRARIES': str(args.native_probe)}
        with (output / 'app.log').open('w') as log:
            app = subprocess.Popen([str(args.binary)], env=environment, stdout=log, stderr=log)
            try:
                runtime.wait_ready(directory, app)
                runtime.until(directory, '[...document.querySelectorAll("[data-testid=commit-row-summary]")].some(e=>e.textContent.trim()==="fixture revision 2")')
                runtime.evaluate(directory, (harness / 'observe.js').read_text())
                runtime.evaluate(directory, (harness / 'flows.js').read_text())
                pids = runtime.request(directory, {'op': 'processes'}, native=True)
                if pids['host'] != app.pid or any(pid <= 0 for pid in pids.values()):
                    raise RuntimeError(f'invalid process ownership: {pids}')

                runtime.save(output / 'manifest.json', {
                    'binary': str(args.binary), 'sha256': args.binary_hash,
                    'native_probe_sha256': args.probe_hash,
                    'flow_source_sha256': hashlib.sha256((harness / 'flows.js').read_bytes()).hexdigest(),
                    'harness_hashes': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in harness.iterdir()},
                    'files': 10, 'lines': 200, 'commits': commits, 'processes': pids,
                    'timebase': {'numer': runtime.base.numer, 'denom': runtime.base.denom},
                    'fixture_contents': {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
                                         for root in [repo, second] for path in sorted(root.glob('*.ts'))},
                    'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'load_average': os.getloadavg(),
                    'unmeasured': ['physical input latency', 'actual displayed feedback', 'global background settlement',
                                   'rapid repeated Git mutations', 'remote activity contention', 'cold filesystem cache'],
                    'resource_interval': 'before drive request through result including Git correctness oracles; not gesture-only CPU'})
                for index, flow in enumerate(flows(repo, second, commits)):
                    spec = {'repo': str(repo), **flow}
                    if spec['op'] == 'ref-navigate':
                        spec['oid'] = states[str(repo)]['oid']
                    if spec.get('prepareFiles'):
                        for path, content in spec['prepareFiles'].items():
                            target = repo / path
                            target.parent.mkdir(exist_ok=True)
                            target.write_text(content)
                        states[str(repo)]['worktree'].update(spec['prepareFiles'])
                        runtime.save(output / 'added-fixture.json', spec['prepareFiles'])
                        runtime.until(directory, 'document.querySelector("[data-testid=staging-unstaged-section]")?.innerText.includes("group/a.txt") && document.querySelector("[data-testid=staging-unstaged-section]")?.innerText.includes("group-neighbor/c.txt")')
                    if spec['op'] == 'commit-failure':
                        hooks = directory / 'fixture-hooks'
                        hooks.mkdir()
                        hook = hooks / 'pre-commit'
                        hook.write_text(f'#!/bin/sh\nprintf "%s\\n" "{spec["hookMessage"]}"\nexit 1\n')
                        hook.chmod(0o755)
                        with (repo / '.git/config').open('a') as config:
                            config.write(f'[core]\nhooksPath = {hooks}\n')
                        spec['expectedHead'] = states[str(repo)]['oid']
                        runtime.save(output / 'failure-fixture.json', {'hook': hook.read_text(), 'config': (repo / '.git/config').read_text()})
                    before = runtime.snapshot(pids)
                    started = time.monotonic()
                    attempt = {'index': index, 'spec': spec, 'resources_before': before, 'completed_flows': len(results)}
                    runtime.save(output / 'attempt.json', attempt)
                    if spec['op'] == 'search-open-native':
                        result = native_search(directory)
                    elif spec['op'] == 'commit-failure':
                        result = rejected_commit(directory, spec)
                    else:
                        expression = f'window.interactionFlows.run({json.dumps(spec)})'
                        result = runtime.evaluate(directory, expression)
                    finished = time.monotonic()
                    after = runtime.snapshot(pids)
                    if runtime.request(directory, {'op': 'processes'}, native=True) != pids:
                        raise RuntimeError('WebKit process identity changed')
                    if any(before[role]['start'] != after[role]['start'] or after[role]['exit'] for role in pids):
                        raise RuntimeError('process lifetime changed during measurement')

                    independent = exact_git_state(Path(spec['repo']), states[spec['repo']], spec, result)
                    results.append({'index': index, **result, 'resources_before': before, 'resources_after': after,
                                    'resource_observation_seconds': finished - started, 'independent_git_oracle': independent})
                    runtime.save(output / 'results.json', results)
                    print(json.dumps({'round': round_number, 'flow': spec['op'], 'index': index,
                                      'dom_usable_ms': result['usable'] - result['start']}), flush=True)
                runtime.request(directory, {'op': 'snapshot', 'path': str(output / 'final.png')})
            except Exception as error:
                runtime.save(output / 'failure.json', {'error': str(error), **attempt, 'completed_flows': len(results)})
                try:
                    if pids:
                        runtime.save(output / 'failure-resources.json', runtime.snapshot(pids))
                    runtime.save(output / 'failure-page.json', runtime.evaluate(directory,
                        '({text:document.body.innerText, html:document.body.outerHTML, samples:window.interactionSamples, last:window.interactionFlowLast})'))
                    runtime.request(directory, {'op': 'snapshot', 'path': str(output / 'failure.png')})
                except Exception as observation_error:
                    runtime.save(output / 'failure-observation.json', {'error': str(observation_error)})
                raise
            finally:
                stop_app(app, lambda: runtime.request(directory, {'op': 'quit'}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--native-probe', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--rounds', type=int, choices=range(1, 7), default=1)
    args = parser.parse_args()
    args.binary = args.binary.resolve(strict=True)
    args.native_probe = args.native_probe.resolve(strict=True)
    args.output = args.output.resolve()
    args.output.mkdir(exist_ok=False)
    args.binary_hash = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    args.probe_hash = hashlib.sha256(args.native_probe.read_bytes()).hexdigest()
    with Path('/tmp/trunk-native-diff-scroll.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for round_number in range(1, args.rounds + 1):
            run_round(args, round_number)


if __name__ == '__main__':
    main()
