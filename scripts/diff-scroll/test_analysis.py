import unittest

from analysis import Inconclusive, InvalidPresentationTimes, assess, decode_marker, validate_capture


class CaptureAnalysis(unittest.TestCase):
    def test_decodes_a_visible_frame_marker(self):
        self.assertEqual(decode_marker([255, 0, 255] + [0] * 13), 5)

    def test_refuses_a_missing_capture(self):
        with self.assertRaises(Inconclusive):
            assess([], {})

    def test_refuses_an_ambiguous_marker(self):
        with self.assertRaises(Inconclusive):
            decode_marker([100] + [0] * 15)

    def test_refuses_nonfinite_presentation_times(self):
        frames = [{"marker": 1, "seconds": float("nan"), "dark_height": 0, "green": 0.5, "bright": 0.08}]
        geometry = {1: {"coverage": 1, "rowCount": 70, "scrollTop": 400, "max": 1000, "t": 10}}

        with self.assertRaises(InvalidPresentationTimes):
            assess(frames, geometry)

    def test_refuses_missing_encoded_frames(self):
        with self.assertRaises(Inconclusive):
            validate_capture({"frames": 2, "droppedFrames": 0, "streamError": "", "invalidFrames": 0,
                              "statuses": {"0": 2}, "samples": [{}, {}]}, [1, 1, 1, 1])

    def test_refuses_a_capture_that_dropped_frames(self):
        with self.assertRaises(Inconclusive):
            validate_capture({"frames": 2, "droppedFrames": 1, "streamError": "", "invalidFrames": 0,
                              "statuses": {"0": 2}, "samples": [{}, {}]}, [2, 2, 2, 2])

    def test_refuses_a_capture_without_stream_status(self):
        with self.assertRaises(Inconclusive):
            validate_capture({"frames": 2}, [2, 2, 2, 2])

    def test_refuses_a_frame_without_matching_geometry(self):
        with self.assertRaises(Inconclusive):
            assess([{"marker": 9, "seconds": 0, "dark_height": 0, "green": 0, "bright": 0}], {})

    def test_reports_a_black_pane_when_rows_cover_it(self):
        frames = [{"marker": 1, "seconds": 0, "dark_height": 0, "green": 0, "bright": 0}]
        geometry = {1: {"coverage": 1, "rowCount": 70, "scrollTop": 400, "max": 1000, "t": 10}}

        result = assess(frames, geometry)

        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["blank_frames"], [0])

    def test_does_not_call_ordinary_overscroll_a_black_pane(self):
        frames = [{"marker": 1, "seconds": 0, "dark_height": 0, "green": 0, "bright": 0}]
        geometry = {1: {"coverage": 0.1, "rowCount": 70, "scrollTop": -900, "max": 1000, "t": 10}}

        result = assess(frames, geometry)

        self.assertEqual(result["verdict"], "pass")

    def test_does_not_confuse_a_missing_stripe_with_missing_content(self):
        frames = [{"marker": 1, "seconds": 0, "dark_height": 0, "green": 0, "bright": 0.08}]
        geometry = {1: {"coverage": 1, "rowCount": 70, "scrollTop": 400, "max": 1000, "t": 10}}

        result = assess(frames, geometry)

        self.assertEqual(result["verdict"], "pass")

    def test_detects_missing_rows_at_an_in_range_scroll_position(self):
        frames = [{"marker": 1, "seconds": 0, "dark_height": 0, "green": 0, "bright": 0}]
        geometry = {1: {"coverage": 0, "rowCount": 70, "scrollTop": 400, "max": 1000, "t": 10}}

        result = assess(frames, geometry)

        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["blank_evidence"][0]["kind"], "missing_rows")

    def test_detects_missing_paint_when_mounted_rows_cover_the_pane(self):
        frames = [{"marker": 1, "seconds": 0, "dark_height": 0, "green": 0, "bright": 0}]
        geometry = {1: {"coverage": 1, "rowCount": 70, "scrollTop": 400, "max": 1000, "t": 10}}

        result = assess(frames, geometry)

        self.assertEqual(result["blank_evidence"][0]["kind"], "missing_paint")

    def test_measures_blank_duration_from_presentation_times(self):
        frames = [
            {"marker": 1, "seconds": 0, "dark_height": 0, "green": 0, "bright": 0},
            {"marker": 2, "seconds": 0.02, "dark_height": 0, "green": 0, "bright": 0},
            {"marker": 3, "seconds": 0.05, "dark_height": 0, "green": 0.5, "bright": 0.08},
        ]
        geometry = {
            n: {"coverage": 1, "rowCount": 70, "scrollTop": 400, "max": 1000, "t": n * 16}
            for n in range(1, 4)
        }

        result = assess(frames, geometry)

        self.assertEqual(result["longest_blank_ms_lower_bound"], 20)

    def test_measures_all_raf_callbacks_inside_the_captured_interval(self):
        frames = [
            {"marker": 1, "seconds": 0, "dark_height": 0, "green": 0.5, "bright": 0.08},
            {"marker": 3, "seconds": 0.02, "dark_height": 0, "green": 0.5, "bright": 0.08},
        ]
        geometry = {
            n: {"coverage": 1, "rowCount": 70, "scrollTop": 400, "max": 1000, "t": t}
            for n, t in [(1, 0), (2, 10), (3, 20), (4, 6000)]
        }

        result = assess(frames, geometry)

        self.assertEqual(result["raf_gap_max_ms"], 10)


if __name__ == "__main__":
    unittest.main()
