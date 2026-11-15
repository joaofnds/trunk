import argparse
import json
from pathlib import Path
import statistics


def distribution(values):
    return {'n': len(values), 'median': statistics.median(values), 'min': min(values), 'max': max(values)}


def summarize(root, prefix):
    output = {}
    for size in [10, 100, 1000]:
        for label in ['before', 'after']:
            runs = []
            for path in sorted(root.glob(f'{prefix}-{size}-*-{label}/[0-9][0-9]/results.json')):
                results = json.loads(path.read_text())
                manifest = json.loads((path.parent / 'manifest.json').read_text())
                factor = manifest['timebase']['numer'] / manifest['timebase']['denom'] / 1e6
                runs.append([
                    {'feedback_ms': row['feedback'] - row['start'],
                     'usable_ms': row['usable'] - row['start'],
                     'selection_reads_and_two_frames_ms': row.get('selectionReadsComplete', row.get('settled')) - row['start'],
                     'cpu_ms': sum((row['resources_after'][role]['user'] + row['resources_after'][role]['system'] -
                                    values['user'] - values['system']) * factor for role, values in row['resources_before'].items()),
                     'end_footprint_mib': sum(values['footprint'] for values in row['resources_after'].values()) / 2**20,
                     'read_bytes': sum(row['resources_after'][role]['read_bytes'] - values['read_bytes']
                                       for role, values in row['resources_before'].items()),
                     'write_bytes': sum(row['resources_after'][role]['write_bytes'] - values['write_bytes']
                                        for role, values in row['resources_before'].items()),
                     'max_raf_gap_ms': max(row['frames'], default=0)}
                    for row in results])
            if not runs:
                continue
            output[f'{size}-{label}'] = {
                phase: {metric: distribution([statistics.median(run[i][metric] for i in indices) for run in runs])
                        for metric in runs[0][0]}
                for phase, indices in [('first_selection', [0]), ('second_uncached_selection', [1]), ('warm_returns', [2, 3])]}
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--prefix', default='final')
    args = parser.parse_args()
    print(json.dumps(summarize(args.root, args.prefix), indent=2))
