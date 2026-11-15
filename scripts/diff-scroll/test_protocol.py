import unittest

from analysis import Inconclusive, validate_motion
from run import parse_reply, trace, validate_wheel


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
