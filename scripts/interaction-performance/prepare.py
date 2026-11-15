import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

PROBE = '''
import { enablePerf } from "./lib/perf.js";
const interactionSamples: unknown[] = [];
Object.assign(window, { interactionSamples });
enablePerf({ frames: false, batchSize: 1, sink: { async write(lines) {
    interactionSamples.push(...lines.map(line => JSON.parse(line)));
} } });
'''


def main():
    parser = argparse.ArgumentParser(description='Freeze current source and instrument only the copied drive entrypoint.')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    output.mkdir(exist_ok=False, parents=True)
    paths = subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
    manifest = {}
    for name in sorted(set(paths)):
        source = root / name
        if not name or not source.is_file() or source.is_symlink():
            continue
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    (output / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
    drive = output / 'src' / 'drive.ts'
    drive.write_text(drive.read_text() + PROBE)
    manifest['src/drive.ts'] = hashlib.sha256(drive.read_bytes()).hexdigest()
    (output / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'build-context.json').write_text(json.dumps({
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'status': subprocess.check_output(['git', 'status', '--short'], cwd=root, text=True),
        'instrumentation': PROBE, 'source_manifest_sha256': hashlib.sha256((output / 'source-manifest.json').read_bytes()).hexdigest(),
    }, indent=2) + '\n')
    print(output)


if __name__ == '__main__':
    main()
