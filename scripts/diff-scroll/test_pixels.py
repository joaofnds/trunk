import unittest

from analysis import classify_pixels, dark_interval


class PixelClassification(unittest.TestCase):
    def test_recognizes_the_green_stripe_and_bright_text_from_rgb(self):
        stripe = bytes([70, 150, 80]) * 6
        pane = bytes([8, 8, 8]) * 63 + bytes([180, 180, 180])

        result = classify_pixels(stripe, pane, height=1)

        self.assertEqual(result, {"green": 1, "bright": 1 / 64, "green_rows": [True], "bright_rows": [True]})

    def test_measures_a_partial_black_gap_from_rgb(self):
        stripe = bytes([8, 8, 8]) * (6 * 80) + bytes([70, 150, 80]) * (6 * 20)
        pane = bytes([8, 8, 8]) * (64 * 80) + bytes([180, 180, 180]) * (64 * 20)

        result = classify_pixels(stripe, pane, height=100)
        hole = dark_interval(result["green_rows"], result["bright_rows"], scroll_top=500, scroll_max=2000)

        self.assertEqual(hole, {"top": 0, "bottom": 80, "height": 80})

    def test_does_not_treat_a_blue_stripe_as_added_content(self):
        result = classify_pixels(bytes([70, 150, 200]) * 6, bytes([8, 8, 8]) * 64, height=1)

        self.assertEqual(result, {"green": 0, "bright": 0, "green_rows": [False], "bright_rows": [False]})


if __name__ == "__main__":
    unittest.main()
