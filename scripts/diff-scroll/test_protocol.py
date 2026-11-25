from contextlib import redirect_stderr
import io
import json
from pathlib import Path
import tempfile
import unittest

from analysis import Inconclusive, validate_motion
from native_runner_test_support import HostFake, NativeDriverFake, trial_arguments
from run import capture_with_admission, parse_args, parse_reply, prepare_display, run, trace, validate_wheel
from test_process_admission import BUSY, CLEAN, InventoryFake


class PaintOptions(unittest.TestCase):
    def test_defaults_to_the_existing_sixty_hertz_display(self):
        args = parse_args(["--binary", "drive-app", "--source-revision", "supplied", "--output", "new-output"])

        self.assertEqual(args.refresh_rate, 60)

    def test_accepts_an_explicit_one_hundred_twenty_hertz_display(self):
        args = parse_args(["--binary", "drive-app", "--source-revision", "supplied", "--output", "new-output",
                           "--refresh-rate", "120"])

        self.assertEqual(args.refresh_rate, 120)

    def test_defaults_to_the_main_display(self):
        args = parse_args(["--binary", "drive-app", "--source-revision", "supplied", "--output", "new-output"])

        self.assertEqual(args.display, "main")

    def test_accepts_an_explicit_virtual_display(self):
        args = parse_args(["--binary", "drive-app", "--source-revision", "supplied", "--output", "new-output",
                           "--display", "virtual"])

        self.assertEqual(args.display, "virtual")

    def test_refuses_an_unsupported_refresh_rate(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            parse_args(["--binary", "drive-app", "--source-revision", "supplied", "--output", "new-output",
                        "--refresh-rate", "90"])

        self.assertEqual(caught.exception.code, 2)


class DisplayChoice(unittest.TestCase):
    def test_places_the_window_on_the_main_display_without_creating_one(self):
        host, driver = HostFake(), NativeDriverFake()
        with tempfile.TemporaryDirectory() as temporary:
            args = trial_arguments(Path(temporary), display="main")

            with self.assertRaises(Inconclusive):
                run(args, host=host, driver=driver, snapshot=InventoryFake(BUSY))
            manifest = json.loads((args.output / "manifest.json").read_text())

        operations = [body["op"] for body in driver.requests]
        self.assertIn("place-on-main-display", operations)
        self.assertNotIn("virtual-display", operations)
        self.assertEqual((manifest["display_kind"], manifest["requested_refresh_rate"]), ("main", None))

    def test_records_the_requested_rate_and_unmodified_virtual_display_response(self):
        host, driver = HostFake(), NativeDriverFake()
        with tempfile.TemporaryDirectory() as temporary:
            args = trial_arguments(Path(temporary), display="virtual")

            with self.assertRaises(Inconclusive):
                run(args, host=host, driver=driver, snapshot=InventoryFake(BUSY))
            manifest = json.loads((args.output / "manifest.json").read_text())

        self.assertIn({"op": "virtual-display", "refreshRate": 120}, driver.requests)
        self.assertEqual((manifest["display_kind"], manifest["requested_refresh_rate"], manifest["native_display"]),
                         ("virtual", 120, {"displayID": 1}))


class DisplayDriverFake:
    def __init__(self, observed_display=1, visible=True):
        self.observed_display = observed_display
        self.visible = visible
        self.virtual_displays = []

    def request(self, directory, body, native=False):
        if body['op'] == 'virtual-display':
            self.virtual_displays.append(body['refreshRate'])
            return {'displayID': 100, 'applied': True, 'requestedRefreshRate': body['refreshRate'], 'actualRefreshRate': 0}

        return {'displayID': 1, 'mainDisplay': True, 'builtIn': True, 'maximumFramesPerSecond': 120}

    def place_window(self, directory):
        self.observed_display = 100

    def visible_window(self, directory):
        return {'displayID': self.observed_display, 'visible': self.visible,
                'occlusion': 2 if self.visible else 0, 'window': 7, 'maximumFramesPerSecond': 120}


class DisplayPlacement(unittest.TestCase):
    def test_keeps_the_requested_virtual_display_rate(self):
        driver = DisplayDriverFake()

        display, window = prepare_display(Path('/unused'), kind='virtual', refresh_rate=60, driver=driver)

        self.assertEqual(display, {'displayID': 100, 'applied': True, 'requestedRefreshRate': 60, 'actualRefreshRate': 0})
        self.assertEqual(window['displayID'], 100)
        self.assertEqual(driver.virtual_displays, [60])

    def test_records_the_main_maximum_without_requesting_a_display_rate(self):
        driver = DisplayDriverFake()

        display, window = prepare_display(Path('/unused'), kind='main', refresh_rate=60, driver=driver)

        self.assertEqual(display, {'displayID': 1, 'mainDisplay': True, 'builtIn': True, 'maximumFramesPerSecond': 120})
        self.assertEqual(window['displayID'], 1)
        self.assertEqual(driver.virtual_displays, [])

    def test_rejects_a_window_that_is_visible_on_another_display(self):
        driver = DisplayDriverFake(observed_display=2)

        with self.assertRaises(Inconclusive):
            prepare_display(Path('/unused'), kind='main', refresh_rate=60, driver=driver)

    def test_rejects_a_hidden_main_window(self):
        driver = DisplayDriverFake(visible=False)

        with self.assertRaises(Inconclusive):
            prepare_display(Path('/unused'), kind='main', refresh_rate=60, driver=driver)


class CaptureFake:
    def __init__(self):
        self.calls = 0

    def __call__(self, directory, output, info, events):
        self.calls += 1
        (output / 'capture.mov').write_bytes(b'completed movie')


class CaptureAdmission(unittest.TestCase):
    def test_paint_entry_rejects_busy_inventory_before_starting_the_recorder(self):
        host, driver = HostFake(), NativeDriverFake()
        with tempfile.TemporaryDirectory() as temporary:
            args = trial_arguments(Path(temporary))

            with self.assertRaises(Inconclusive):
                run(args, host=host, driver=driver, snapshot=InventoryFake(BUSY))

            self.assertEqual(driver.recorder_starts, 0)
            evidence = json.loads((args.output / 'process-admission.json').read_text())
            self.assertTrue(json.loads((args.output / 'manifest.json').read_text())['process_admission_required'])
            self.assertEqual(evidence['entry']['verdict'], 'rejected')
            self.assertEqual(host.app.returncode, 0)

    def test_refuses_capture_before_start_when_competing_work_is_present(self):
        capture = CaptureFake()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                capture_with_admission(output, output, {}, [], capture_operation=capture, snapshot=InventoryFake(BUSY))
            evidence = json.loads((output / 'process-admission.json').read_text())

        self.assertEqual(capture.calls, 0)
        self.assertEqual(evidence['entry']['verdict'], 'rejected')

    def test_refuses_capture_after_completion_and_retains_its_movie(self):
        capture = CaptureFake()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaises(Inconclusive):
                capture_with_admission(output, output, {}, [], capture_operation=capture, snapshot=InventoryFake(CLEAN, BUSY))
            evidence = json.loads((output / 'process-admission.json').read_text())
            movie = (output / 'capture.mov').read_bytes()

        self.assertEqual(capture.calls, 1)
        self.assertEqual(movie, b'completed movie')
        self.assertEqual(evidence['exit']['verdict'], 'rejected')


class DriveProtocol(unittest.TestCase):
    def test_returns_the_success_payload(self):
        self.assertEqual(parse_reply({"ok": True, "value": {"ready": True}}), {"ready": True})

    def test_refuses_an_error_envelope(self):
        with self.assertRaises(Inconclusive):
            parse_reply({"ok": False, "error": "evaluation failed"})

    def test_refuses_a_success_envelope_without_a_payload(self):
        with self.assertRaises(Inconclusive):
            parse_reply({"ok": True})

    def test_refuses_a_nonobject_reply(self):
        with self.assertRaises(Inconclusive):
            parse_reply([])

    def test_refuses_native_errors(self):
        with self.assertRaises(Inconclusive):
            parse_reply({"error": "window missing"}, native=True)

    def test_keeps_the_native_input_trace_bounded_and_ordered(self):
        events = trace({"left": 100, "top": 100, "width": 900, "height": 600}, "fast")

        self.assertEqual(len(events), 216)
        self.assertEqual(events[-1]["atMs"], 3708)
        self.assertEqual([event["atMs"] for event in events], sorted(event["atMs"] for event in events))

    def test_refuses_a_wheel_event_without_the_actual_window(self):
        with self.assertRaises(Inconclusive):
            validate_wheel({"x": 10, "y": 20}, {"windowNumber": 0}, {"x": 10, "y": 20}, 123)

    def test_refuses_a_wheel_event_that_misses_the_viewport(self):
        with self.assertRaises(Inconclusive):
            validate_wheel({"x": 10, "y": 80}, {"windowNumber": 123}, {"x": 10, "y": 20}, 123)

    def test_keeps_the_slow_trace_bounded_at_3750_pixels_per_second(self):
        events = trace({"left": 100, "top": 100, "width": 900, "height": 600}, "slow")

        self.assertEqual(len(events), 216)
        self.assertEqual(events[-1]["atMs"], 4616)
        self.assertEqual(max(abs(event["dy"]) for event in events) / 0.016, 3750)

    def test_refuses_a_scroll_trace_that_never_moves(self):
        with self.assertRaises(Inconclusive):
            validate_motion([{"scrollTop": 100, "max": 2000}] * 5, 300)

    def test_refuses_bounce_as_evidence_of_scroll_progress(self):
        with self.assertRaises(Inconclusive):
            validate_motion([{"scrollTop": -400, "max": 2000}, {"scrollTop": 0, "max": 2000}], 300)

    def test_accepts_a_trace_that_moves_through_content(self):
        validate_motion([{"scrollTop": 100, "max": 2000}, {"scrollTop": 798, "max": 2000}], 698)


if __name__ == "__main__":
    unittest.main()
