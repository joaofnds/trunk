import fcntl
import os
from pathlib import Path
import tempfile
import unittest

from target_sweep import DAY, sweep

NOW = 2_000_000_000.0
HASH = '0123456789abcdef'
OTHER = 'fedcba9876543210'


def write(path, *, at):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'artifact')
    os.utime(path, (at, at))
    return path


def profile(path):
    write(path / '.cargo-lock', at=NOW)
    return path


def fingerprint(profile, unit, *, built, read):
    directory = profile / '.fingerprint' / unit
    fingerprint_files(directory, built=built, read=read)
    return directory


def unit_directory(profile, *, built, read):
    directory = profile / 'build' / 'trunk_lib' / HASH
    fingerprint_files(directory / 'fingerprint', built=built, read=read)
    write(directory / 'out' / 'libtrunk_lib.rlib', at=built)
    return directory


def fingerprint_files(directory, *, built, read):
    write(directory / 'lib-trunk_lib.json', at=built)
    write(directory / 'invoked.timestamp', at=built)
    write(directory / 'dep-lib-trunk_lib', at=built)
    hash_file = write(directory / 'lib-trunk_lib', at=built)
    os.utime(hash_file, (read, built))


def artifacts(profile, crate, digest):
    return [write(profile / 'deps' / f'lib{crate}-{digest}.rlib', at=NOW - 30 * DAY),
            write(profile / 'deps' / f'{crate}-{digest}.d', at=NOW - 30 * DAY),
            write(profile / 'deps' / f'{crate}-{digest}.cgu.01.rcgu.o', at=NOW - 30 * DAY),
            write(profile / 'build' / f'{crate}-{digest}' / 'out' / 'generated.rs', at=NOW - 30 * DAY),
            write(profile / 'examples' / f'{crate}-{digest}', at=NOW - 30 * DAY)]


class TargetSweep(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.target = Path(temporary.name)
        self.profile = profile(self.target / 'debug')

    def test_removes_a_unit_no_build_has_read_for_two_days(self):
        unit = fingerprint(self.profile, f'trunk-{HASH}', built=NOW - 30 * DAY, read=NOW - 3 * DAY)
        files = artifacts(self.profile, 'trunk_lib', HASH)

        sweep(self.target, now=NOW)

        self.assertFalse(unit.exists())
        self.assertEqual([path for path in files if path.exists()], [])

    def test_keeps_a_unit_a_build_read_within_two_days(self):
        unit = fingerprint(self.profile, f'trunk-{HASH}', built=NOW - 30 * DAY, read=NOW - DAY)
        files = artifacts(self.profile, 'trunk_lib', HASH)

        sweep(self.target, now=NOW)

        self.assertTrue(unit.exists())
        self.assertEqual([path for path in files if not path.exists()], [])

    def test_keeps_a_unit_built_within_two_days(self):
        unit = fingerprint(self.profile, f'trunk-{HASH}', built=NOW - DAY, read=NOW - DAY)

        sweep(self.target, now=NOW)

        self.assertTrue(unit.exists())

    def test_a_read_of_the_fingerprint_description_does_not_count_as_use(self):
        unit = fingerprint(self.profile, f'trunk-{HASH}', built=NOW - 30 * DAY, read=NOW - 3 * DAY)
        description = unit / 'lib-trunk_lib.json'
        os.utime(description, (NOW, NOW - 30 * DAY))

        sweep(self.target, now=NOW)

        self.assertFalse(unit.exists())

    def test_removes_artifacts_whose_fingerprint_is_gone(self):
        fingerprint(self.profile, f'trunk-{HASH}', built=NOW, read=NOW)
        orphans = artifacts(self.profile, 'trunk_lib', OTHER)

        sweep(self.target, now=NOW)

        self.assertEqual([path for path in orphans if path.exists()], [])

    def test_leaves_the_artifacts_cargo_copies_out_of_deps(self):
        copies = [write(self.profile / 'trunk', at=NOW - 30 * DAY),
                  write(self.profile / 'libtrunk_lib.rlib', at=NOW - 30 * DAY),
                  write(self.profile / 'examples' / 'app_host', at=NOW - 30 * DAY)]

        sweep(self.target, now=NOW)

        self.assertEqual([path for path in copies if not path.exists()], [])

    def test_removes_incremental_state_not_written_for_two_days(self):
        stale = write(self.profile / 'incremental' / 'trunk_lib-004ehrv3ezmer' / 's-old' / 'query-cache.bin',
                      at=NOW - 3 * DAY)
        fresh = write(self.profile / 'incremental' / 'trunk_lib-02e8k8omfmofq' / 's-new' / 'query-cache.bin',
                      at=NOW - DAY)
        for path in [stale, fresh]:
            os.utime(path.parent, (NOW, path.stat().st_mtime))
            os.utime(path.parent.parent, (NOW, path.stat().st_mtime))

        sweep(self.target, now=NOW)

        self.assertFalse(stale.parent.parent.exists())
        self.assertTrue(fresh.exists())

    def test_sweeps_every_profile_directory_under_the_target(self):
        nested = profile(self.target / 'drive-build' / 'debug')
        unit = fingerprint(nested, f'trunk-{HASH}', built=NOW - 30 * DAY, read=NOW - 3 * DAY)

        sweep(self.target, now=NOW)

        self.assertFalse(unit.exists())

    def test_removes_a_unit_cargo_1_100_keeps_in_a_directory_of_its_own(self):
        release = profile(self.target / 'release')
        unit = unit_directory(release, built=NOW - 30 * DAY, read=NOW - 3 * DAY)

        sweep(self.target, now=NOW)

        self.assertFalse(unit.exists())

    def test_keeps_a_unit_cargo_1_100_keeps_in_a_directory_of_its_own_while_a_build_reads_it(self):
        unit = unit_directory(self.profile, built=NOW - 30 * DAY, read=NOW - DAY)

        sweep(self.target, now=NOW)

        self.assertTrue((unit / 'out' / 'libtrunk_lib.rlib').exists())

    def test_leaves_a_fingerprint_directory_a_build_script_writes(self):
        fingerprint(self.profile, f'trunk-{HASH}', built=NOW, read=NOW)
        written = write(self.profile / 'build' / f'trunk_lib-{HASH}' / 'out' / 'fingerprint' / 'lib-trunk_lib',
                        at=NOW - 30 * DAY)

        sweep(self.target, now=NOW)

        self.assertTrue(written.exists())

    def test_passes_over_the_files_beside_the_profiles(self):
        files = [write(self.target / '.rustc_info.json', at=NOW - 30 * DAY),
                 write(self.target / 'tmp' / 'scratch', at=NOW - 30 * DAY)]

        sweep(self.target, now=NOW)

        self.assertEqual([path for path in files if not path.exists()], [])

    def test_leaves_a_profile_directory_alone_while_a_build_holds_its_lock(self):
        unit = fingerprint(self.profile, f'trunk-{HASH}', built=NOW - 30 * DAY, read=NOW - 3 * DAY)
        lock = (self.profile / '.cargo-build-lock').open('w')
        self.addCleanup(lock.close)
        fcntl.flock(lock, fcntl.LOCK_EX)

        report = sweep(self.target, now=NOW)

        self.assertTrue(unit.exists())
        self.assertEqual(report.busy, [self.profile])


if __name__ == '__main__':
    unittest.main()
