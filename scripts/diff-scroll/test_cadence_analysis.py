import json
from pathlib import Path
import tempfile
import unittest

from analysis import Inconclusive
from cadence import trace
from cadence_analysis import analyze, assess_pixels, assess_recording, validate_input, validate_resources


def evidence():
    box = {'left': 100, 'top': 50, 'width': 400, 'height': 300, 'scrollTop': 1200, 'max': 5000}
    manifest = {'mode': 'graph', 'box': box, 'info': {'window': 7, 'height': 770}}
    planned = trace(box)
    delivery = {'sent': 404, 'timebaseNumer': 1, 'timebaseDenom': 1,
                'plannedStartMachTicksLowerBound': '1000000000',
                'plannedStartMachTicksUpperBound': '1000000000', 'events': []}
    observations = {'wheels': [], 'scrolls': [], 'final': 1200}
    top = box['scrollTop']
    for event in planned:
        delivery['events'].append({'machTicks': str(1000000000 + event['atMs'] * 1000000),
                                   'windowNumber': 7, 'locationX': event['x'], 'locationY': 770 - event['y'],
                                   'deltaY': event['dy'], 'phase': {1: 1, 2: 4, 4: 8}[event['phase']], 'momentum': 0})
        if event['dy']:
            observations['wheels'].append({'at': event['atMs'] + 100, 'x': event['x'], 'y': event['y'], 'dy': -event['dy']})
            top -= event['dy']
            observations['scrolls'].append({'at': event['atMs'] + 101, 'top': top})

    return manifest, planned, delivery, observations


class CadenceAdmission(unittest.TestCase):
    def test_accepts_complete_targeted_input_and_four_excursions(self):
        result = validate_input(*evidence())

        self.assertEqual(result['native_events'], 404)
        self.assertEqual(result['browser_nonzero_receipts'], 400)
        self.assertEqual(result['gesture_endpoints_px'], [2400, 1200, 2400, 1200])

    def test_rejects_a_missing_browser_receipt(self):
        manifest, planned, delivery, observations = evidence()
        observations['wheels'].pop()

        with self.assertRaises(Inconclusive):
            validate_input(manifest, planned, delivery, observations)

    def test_rejects_a_native_event_bound_to_a_different_window(self):
        manifest, planned, delivery, observations = evidence()
        delivery['events'][200]['windowNumber'] = 8

        with self.assertRaises(Inconclusive):
            validate_input(manifest, planned, delivery, observations)

    def test_rejects_a_browser_receipt_that_misses_the_target(self):
        manifest, planned, delivery, observations = evidence()
        observations['wheels'][200]['x'] += 2

        with self.assertRaises(Inconclusive):
            validate_input(manifest, planned, delivery, observations)

    def test_rejects_native_lateness_over_three_milliseconds(self):
        manifest, planned, delivery, observations = evidence()
        delivery['events'][200]['machTicks'] = str(int(delivery['events'][200]['machTicks']) + 3000001)

        with self.assertRaises(Inconclusive):
            validate_input(manifest, planned, delivery, observations)

    def test_rejects_return_without_the_required_excursion(self):
        manifest, planned, delivery, observations = evidence()
        for sample in observations['scrolls']:
            sample['top'] = min(sample['top'], 2300)

        with self.assertRaises(Inconclusive):
            validate_input(manifest, planned, delivery, observations)

    def test_rejects_an_incomplete_native_schedule(self):
        manifest, planned, delivery, observations = evidence()
        planned[10]['atMs'] += 1

        with self.assertRaises(Inconclusive):
            validate_input(manifest, planned, delivery, observations)


class CadencePixels(unittest.TestCase):
    def test_rejects_a_capture_with_lost_frames(self):
        capture = {'frames': 2, 'droppedFrames': 1, 'streamError': '', 'invalidFrames': 0,
                   'statuses': {'0': 2}, 'samples': [{'displayMachTicks': '1'}, {'displayMachTicks': '9'}]}

        with self.assertRaises(Inconclusive):
            assess_recording(capture, {'sent': 1, 'events': [{'machTicks': '5'}]}, {'text': [b'\0', b'\1']})

    def test_rejects_a_capture_that_misses_the_last_native_input(self):
        capture = {'frames': 2, 'droppedFrames': 0, 'streamError': '', 'invalidFrames': 0,
                   'statuses': {'0': 2}, 'samples': [{'displayMachTicks': '1'}, {'displayMachTicks': '9'}]}

        with self.assertRaises(Inconclusive):
            assess_recording(capture, {'sent': 1, 'events': [{'machTicks': '10'}]}, {'text': [b'\0', b'\1']})

    def test_reports_threshold_sensitivity_and_capture_gaps(self):
        times = [90, 100, 116, 149, 165, 700, 850, 900, 950]
        frames = [bytes([level]) for level in [0, 2, 4, 4, 10, 10, 10, 10, 10]]

        result = assess_pixels(times, frames, [0])

        self.assertEqual(result['thresholds']['1']['changed_comparisons'], 2)
        self.assertEqual(result['thresholds']['3']['changed_comparisons'], 1)
        self.assertEqual(result['thresholds']['5']['changed_comparisons'], 1)
        self.assertEqual(result['capture_gaps_ms']['max'], 535)
        self.assertNotIn('fps', result)

    def test_rejects_crops_without_samples_in_the_motion_window(self):
        with self.assertRaises(Inconclusive):
            assess_pixels([0, 10], [b'\0', b'\1'], [1000])

    def test_reports_sparse_idle_capture_without_discarding_observed_motion(self):
        times = [100, 110, 841, 917, 992, 1100, 1110, 1850, 1900, 1950]
        frames = [bytes([level]) for level in [0, 20, 20, 20, 20, 20, 40, 40, 40, 40]]

        result = assess_pixels(times, frames, [0, 1000])

        self.assertEqual(result['motion_comparisons'], 2)
        self.assertEqual(result['idle_comparisons_by_gesture'], [0, 2])
        self.assertEqual(result['idle_gray_difference']['count'], 2)

    def test_rejects_a_capture_without_any_idle_noise_observation(self):
        with self.assertRaises(Inconclusive):
            assess_pixels([100, 110, 841, 917, 992], [b'\0'] * 5, [0])

    def test_rejects_an_unsampled_gesture_even_with_other_motion_and_idle_samples(self):
        times = [100, 110, 850, 900, 950, 1850, 1900, 1950]

        with self.assertRaises(Inconclusive):
            assess_pixels(times, [b'\0'] * len(times), [0, 1000])


def resource_evidence():
    snapshot = {'user': 100, 'system': 100, 'read_bytes': 0, 'write_bytes': 0,
                'pageins': 0, 'wakeups': 0, 'interrupts': 0, 'start': 1, 'exit': 0,
                'resident': 1000, 'footprint': 800}
    return {'before': {'host': dict(snapshot)}, 'after': {'host': {**snapshot, 'user': 1100}},
            'seconds': 4, 'before_snapshot_monotonic_ns': [1000000, 2000000],
            'after_snapshot_monotonic_ns': [4002000000, 4004000000],
            'processes_before': {'host': 7}, 'processes_after': {'host': 7},
            'timebase': {'numer': 1, 'denom': 1}}


def resource_manifest():
    return {'processes': {'host': 7}, 'info': {'pid': 7}}


def save_record(directory, files):
    for name, value in files.items():
        (directory / f'{name}.json').write_text(json.dumps(value))


def valid_resource_records():
    manifest, planned, delivery, observations = evidence()
    manifest['processes'] = {'host': 7}
    manifest['info']['pid'] = 7
    return {'manifest': manifest, 'input': planned, 'native-input': delivery,
            'observations': observations, 'resources': resource_evidence(),
            'cpu-calibration': {'converted_ns': 10, 'process_time_ns_bracket': [9, 11],
                                'timebase': {'numer': 1, 'denom': 1}}}


class WorkloadReanalysis(unittest.TestCase):
    def test_keeps_legacy_workload_observation_explicitly_unknown(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save_record(directory, valid_resource_records())

            result = analyze(directory, resources=True)

        self.assertEqual(result['workload_admission']['verdict'], 'unobserved')

    def test_refuses_a_recorded_exit_rejection_even_with_valid_resource_samples(self):
        records = valid_resource_records()
        records['process-admission'] = {'entry': {'verdict': 'admitted'}, 'exit': {'verdict': 'rejected'}}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save_record(directory, records)

            with self.assertRaises(Inconclusive):
                analyze(directory, resources=True)

    def test_refuses_missing_admission_when_the_runner_requires_it(self):
        records = valid_resource_records()
        records['manifest']['process_admission_required'] = True
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save_record(directory, records)

            with self.assertRaises(Inconclusive):
                analyze(directory, resources=True)

    def test_identifies_the_admitted_record_in_reanalysis_provenance(self):
        records = valid_resource_records()
        records['manifest']['process_admission_required'] = True
        records['process-admission'] = {'entry': {'verdict': 'admitted'}, 'exit': {'verdict': 'admitted'}}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save_record(directory, records)

            result = analyze(directory, resources=True)

            self.assertEqual(result['workload_admission']['verdict'], 'admitted')
            self.assertIn(str((directory / 'process-admission.json').resolve()), result['provenance']['input_files_sha256'])


class CadenceResources(unittest.TestCase):
    def test_reports_cpu_time_and_observation_interval_bounds(self):
        result = validate_resources(resource_evidence(), resource_manifest())

        self.assertEqual(result['observation_interval_seconds_bounds'], [4, 4.003])
        self.assertEqual(result['processes']['host']['cpu_ms'], 0.001)
        self.assertNotIn('cpu_percent_one_core', result['processes']['host'])

    def test_rejects_resources_from_a_different_native_run(self):
        manifest, planned, delivery, observations = evidence()
        manifest.update({'processes': {'host': 70}})
        manifest['info']['pid'] = 70
        calibration = {'converted_ns': 10, 'process_time_ns_bracket': [9, 11], 'timebase': {'numer': 1, 'denom': 1}}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save_record(directory, {'manifest': manifest, 'input': planned, 'native-input': delivery,
                                    'observations': observations, 'resources': resource_evidence(),
                                    'cpu-calibration': calibration})

            with self.assertRaises(Inconclusive):
                analyze(directory, resources=True)

    def test_rejects_a_nonfinite_cpu_counter(self):
        resources = resource_evidence()
        resources['after']['host']['user'] = float('nan')

        with self.assertRaises(Inconclusive):
            validate_resources(resources, resource_manifest())

    def test_rejects_negative_memory(self):
        resources = resource_evidence()
        resources['after']['host']['footprint'] = -1

        with self.assertRaises(Inconclusive):
            validate_resources(resources, resource_manifest())

    def test_rejects_negative_counters_even_when_the_delta_is_positive(self):
        resources = resource_evidence()
        resources['before']['host']['read_bytes'] = -2
        resources['after']['host']['read_bytes'] = -1

        with self.assertRaises(Inconclusive):
            validate_resources(resources, resource_manifest())

    def test_rejects_a_fractional_process_start_identity(self):
        resources = resource_evidence()
        resources['before']['host']['start'] = 1.5
        resources['after']['host']['start'] = 1.5

        with self.assertRaises(Inconclusive):
            validate_resources(resources, resource_manifest())

    def test_rejects_a_reused_process_identifier(self):
        resources = resource_evidence()
        resources['after']['host']['start'] = 2

        with self.assertRaises(Inconclusive):
            validate_resources(resources, resource_manifest())


if __name__ == '__main__':
    unittest.main()
