import unittest

from analysis import Inconclusive, captured_geometry, validate_capture, validate_motion, validate_temporal_coverage


class CaptureCoverage(unittest.TestCase):
    def test_accepts_frames_that_bracket_the_delivered_input(self):
        capture = {"samples": [{"displayMachTicks": "100"}, {"displayMachTicks": "500"}]}
        delivery = {"sent": 2, "events": [{"machTicks": "200"}, {"machTicks": "400"}]}

        validate_temporal_coverage(capture, delivery)

    def test_refuses_a_recording_that_stops_before_the_last_input(self):
        capture = {"samples": [{"displayMachTicks": "100"}, {"displayMachTicks": "300"}]}
        delivery = {"sent": 2, "events": [{"machTicks": "200"}, {"machTicks": "400"}]}

        with self.assertRaises(Inconclusive):
            validate_temporal_coverage(capture, delivery)

    def test_refuses_a_recording_that_starts_after_the_first_input(self):
        capture = {"samples": [{"displayMachTicks": "300"}, {"displayMachTicks": "500"}]}
        delivery = {"sent": 2, "events": [{"machTicks": "200"}, {"machTicks": "400"}]}

        with self.assertRaises(Inconclusive):
            validate_temporal_coverage(capture, delivery)

    def test_refuses_missing_delivery_timestamps(self):
        capture = {"samples": [{"displayMachTicks": "100"}, {"displayMachTicks": "500"}]}
        delivery = {"sent": 2, "events": [{"machTicks": "200"}]}

        with self.assertRaises(Inconclusive):
            validate_temporal_coverage(capture, delivery)

    def test_later_motion_cannot_validate_a_stationary_recording(self):
        frames = [{"marker": 1}]
        geometry = {
            1: {"scrollTop": 0, "max": 2000, "t": 0},
            2: {"scrollTop": 700, "max": 2000, "t": 6000},
        }

        with self.assertRaises(Inconclusive):
            validate_motion(captured_geometry(frames, geometry).values(), 300)

    def test_accepts_ordinary_idle_capture_status(self):
        capture = {"frames": 2, "droppedFrames": 0, "streamError": "", "invalidFrames": 0,
                   "statuses": {"0": 2, "1": 3, "4": 1, "5": 1}, "samples": [{}, {}]}

        validate_capture(capture, [2, 2, 2, 2])

    def test_refuses_blank_capture_status(self):
        capture = {"frames": 2, "droppedFrames": 0, "streamError": "", "invalidFrames": 0,
                   "statuses": {"0": 2, "2": 1}, "samples": [{}, {}]}

        with self.assertRaises(Inconclusive):
            validate_capture(capture, [2, 2, 2, 2])

    def test_refuses_suspended_capture_status(self):
        capture = {"frames": 2, "droppedFrames": 0, "streamError": "", "invalidFrames": 0,
                   "statuses": {"0": 2, "3": 1}, "samples": [{}, {}]}

        with self.assertRaises(Inconclusive):
            validate_capture(capture, [2, 2, 2, 2])

    def test_refuses_unknown_capture_status(self):
        capture = {"frames": 2, "droppedFrames": 0, "streamError": "", "invalidFrames": 0,
                   "statuses": {"0": 2, "99": 1}, "samples": [{}, {}]}

        with self.assertRaises(Inconclusive):
            validate_capture(capture, [2, 2, 2, 2])

    def test_refuses_frames_without_capture_status(self):
        capture = {"frames": 2, "droppedFrames": 0, "streamError": "", "invalidFrames": 1,
                   "statuses": {"0": 2}, "samples": [{}, {}]}

        with self.assertRaises(Inconclusive):
            validate_capture(capture, [2, 2, 2, 2])


if __name__ == "__main__":
    unittest.main()
