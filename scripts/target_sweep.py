from dataclasses import dataclass, field
import fcntl
from pathlib import Path
import re
import shutil
import sys
import time

DAY = 86_400
UNUSED_FOR = 2 * DAY
LOCKS = ['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock']
UNIT_HASH = re.compile(r'-([0-9a-f]{16})(?=\.|$)')
UNIT_OUTPUTS = ['deps', 'build', 'examples']


@dataclass
class Report:
    removed: int = 0
    busy: list = field(default_factory=list)


def sweep(target, *, now, unused_for=UNUSED_FOR):
    report = Report()
    for profile in profiles(target):
        locks = acquire(profile)
        if locks is None:
            report.busy.append(profile)
            continue

        try:
            report.removed += sweep_profile(profile, cutoff=now - unused_for)
        finally:
            for lock in locks:
                lock.close()

    return report


def profiles(target):
    fingerprints = [*target.glob('*/.fingerprint'), *target.glob('*/*/.fingerprint')]
    return sorted(directory.parent for directory in fingerprints if directory.is_dir())


def acquire(profile):
    held = []
    for name in LOCKS:
        lock = (profile / name).open('a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            for other in held:
                other.close()
            return None
        held.append(lock)

    return held


def sweep_profile(profile, *, cutoff):
    last_use = {}
    for unit in (profile / '.fingerprint').iterdir():
        last_use[unit] = last_read(unit)
    live = {unit.name.rsplit('-', 1)[-1] for unit, used in last_use.items() if used >= cutoff}

    removed = 0
    for unit, used in last_use.items():
        if used < cutoff:
            removed += remove(unit)
    for output in UNIT_OUTPUTS:
        for entry in entries(profile / output):
            unit_hash = UNIT_HASH.search(entry.name)
            if unit_hash and unit_hash.group(1) not in live:
                removed += remove(entry)
    for crate in entries(profile / 'incremental'):
        if last_write(crate) < cutoff:
            removed += remove(crate)

    return removed


def last_read(unit):
    newest = 0.0
    for file in unit.iterdir():
        status = file.lstat()
        newest = max(newest, status.st_mtime)
        if file.suffix != '.json':
            newest = max(newest, status.st_atime)

    return newest


def last_write(crate):
    return max([crate.lstat().st_mtime, *(session.lstat().st_mtime for session in crate.iterdir())])


def entries(directory):
    return list(directory.iterdir()) if directory.is_dir() else []


def remove(path):
    if path.is_symlink() or not path.is_dir():
        path.unlink()
    else:
        shutil.rmtree(path)

    return 1


def main():
    target = Path(sys.argv[1])
    free = shutil.disk_usage(target).free if target.is_dir() else 0

    report = sweep(target, now=time.time())

    if report.removed:
        freed = shutil.disk_usage(target).free - free
        print(f'target-sweep: freed {freed / 1e9:.1f} GB of build output no build used for two days')
    for profile in report.busy:
        print(f'target-sweep: left {profile} alone, a build holds it')


if __name__ == '__main__':
    main()
