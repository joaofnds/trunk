"""Endpoint admission cannot detect work that starts and ends between snapshots."""

from contextlib import contextmanager
import json
import math
from pathlib import Path
import re
import shlex
import subprocess
import time

from analysis import Inconclusive


EXECUTABLES = {'cargo', 'cargo-nextest', 'nextest', 'rustc', 'just', 'make', 'gmake', 'cmake', 'ninja',
               'xcodebuild', 'clang', 'clang++', 'cc', 'c++', 'gcc', 'g++', 'cc1', 'cc1plus',
               'swiftc', 'swift-frontend', 'esbuild', 'tsc', 'svelte-check', 'vitest', 'jest', 'pytest'}
SCRIPTS = {'vitest', 'vitest.mjs', 'jest', 'jest.js', 'jest-cli.js', 'tsc', 'tsc.js',
           'svelte-check', 'svelte-check.js', 'webpack', 'webpack.js', 'rollup', 'rollup.js'}
PACKAGE_MANAGERS = {'npm', 'npm-cli.js', 'pnpm', 'pnpm.cjs', 'yarn', 'yarn.js'}
LIMITATION = 'Entry and exit inventories cannot detect competing work that starts and ends between snapshots.'


def inventory_snapshot():
    inventory = {}
    for field, columns in [('comm', 'pid=,pcpu=,comm='), ('args', 'pid=,args=')]:
        try:
            inventory[field] = subprocess.check_output(['ps', '-axww', '-o', columns], text=True, timeout=5)
        except (OSError, subprocess.SubprocessError) as error:
            inventory['collection_error'] = str(error)
            break

    return inventory


def is_interpreter(name):
    return name in {'node', 'nodejs', 'bun', *PACKAGE_MANAGERS} or bool(re.fullmatch(r'python(?:\d+(?:\.\d+)*)?', name.lower()))


def interpreter_work(name, command):
    if re.match(r'^\[[^\]]+\](?:\s|$)', command):
        raise Inconclusive(f'arguments unavailable for interpreter {name}')

    try:
        argv = shlex.split(command)
    except ValueError as error:
        raise Inconclusive(f'cannot parse arguments for {name}: {error}') from error

    arguments = argv[1:]
    if name.lower().startswith('python'):
        while arguments:
            option = arguments.pop(0)
            if option.startswith('-m'):
                module = option[2:] or (arguments.pop(0) if arguments else '')
                return 'python -m ' + module if module in {'pytest', 'unittest'} else None

            if option in {'-', '--'} or option.startswith('-c') or not option.startswith('-'):
                return None

            if option in {'-W', '-X', '--check-hash-based-pycs'}:
                if not arguments:
                    raise Inconclusive(f'incomplete interpreter options for {name}')

                arguments.pop(0)
            elif option.startswith(('-W', '-X', '--check-hash-based-pycs=')):
                continue
            elif not set(option[1:]) <= set('bBdEhiIOPqRsSuvVx'):
                raise Inconclusive(f'unrecognized interpreter options for {name}')

        return None

    if name in {'node', 'nodejs'}:
        while arguments and arguments[0].startswith('-'):
            option = arguments.pop(0)
            if option == '--test':
                return 'node --test'

            if option in {'-e', '--eval', '-p', '--print'}:
                return None

            if option in {'-r', '--require', '--loader', '--import'} and arguments:
                arguments.pop(0)

        if not arguments:
            return None

        name = Path(arguments.pop(0)).name
        if name in SCRIPTS:
            return 'node script ' + name

    if name in PACKAGE_MANAGERS or name == 'bun':
        if arguments[:1] in [['run'], ['run-script']]:
            arguments = arguments[1:]
        if arguments and arguments[0] in {'test', 'build', 'check', 'typecheck', 'test:unit', 'test:integration'}:
            return name + ' ' + arguments[0]

    return None


def classify_inventory(inventory):
    if inventory.get('collection_error'):
        raise Inconclusive(f'process inventory collection failed: {inventory["collection_error"]}')

    arguments = {}
    for line in inventory.get('args', '').splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) == 2 and fields[0].isdigit():
            arguments[int(fields[0])] = fields[1]

    lines = inventory.get('comm', '').splitlines()
    if not lines:
        raise Inconclusive('process executable inventory is empty')

    competing = []
    for line in lines:
        fields = line.strip().split(maxsplit=2)
        try:
            pid, cpu, comm = int(fields[0]), float(fields[1]), fields[2]
            if pid <= 0 or not math.isfinite(cpu) or cpu < 0 or not comm:
                raise ValueError('invalid pid, CPU value, or executable')
        except (ValueError, IndexError) as error:
            raise Inconclusive(f'invalid process executable inventory row: {line}') from error

        name = Path(comm).name
        reason = None
        if re.search(r'/target/(?:[^/]+/)?(?:debug|release)/deps/[^/]+-[0-9a-f]{8,64}$', comm):
            reason = 'Rust test executable'
        elif name in EXECUTABLES or re.fullmatch(r'(?:clang\+\+|clang|gcc|g\+\+)-\d+', name):
            reason = 'build or test executable'
        elif is_interpreter(name):
            if pid not in arguments:
                raise Inconclusive(f'arguments unavailable for interpreter {pid} {comm}')

            workload = interpreter_work(name, arguments[pid])
            if workload:
                reason = 'interpreter workload: ' + workload
        if reason:
            competing.append({'pid': pid, 'pcpu': cpu, 'comm': comm, 'reason': reason})

    return competing


@contextmanager
def measurement_window(output, *, snapshot=inventory_snapshot):
    evidence = {'schema': 1, 'limitation': LIMITATION}

    def inspect(phase):
        record = {'started_monotonic_ns': time.monotonic_ns()}
        try:
            inventory = snapshot()
            record['inventory'] = {field: inventory[field] for field in ('comm', 'collection_error') if field in inventory}
            record['competing'] = classify_inventory(inventory)
            if record['competing']:
                identities = ', '.join(f'{item["pid"]} {item["comm"]}' for item in record['competing'])
                raise Inconclusive(f'competing build/test work at measurement {phase}: {identities}')

            record['verdict'] = 'admitted'
        except Exception as error:
            record.update(verdict='rejected', reason=str(error))
        record['finished_monotonic_ns'] = time.monotonic_ns()
        evidence[phase] = record
        pending = output / 'process-admission.json.tmp'
        pending.write_text(json.dumps(evidence, indent=2) + '\n')
        pending.replace(output / 'process-admission.json')
        if record['verdict'] == 'rejected':
            raise Inconclusive(record['reason'])

    inspect('entry')
    failure = None
    try:
        yield
    except BaseException as error:
        failure = error
        raise
    finally:
        try:
            inspect('exit')
        except Exception as error:
            if failure is None:
                raise

            failure.add_note(f'Process admission exit also failed ({type(error).__name__}): {error}')
