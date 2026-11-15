import unittest

from analysis import assess, dark_interval


class PartialBlank(unittest.TestCase):
    def test_finds_a_partial_hole_with_content_below_it(self):
        result = dark_interval([False] * 504 + [True] * 194, [False] * 504 + [True] * 194,
                               scroll_top=12000, scroll_max=27000)

        self.assertEqual(result, {"top": 0, "bottom": 504, "height": 504})

    def test_excludes_empty_space_beyond_the_end_of_the_file(self):
        result = dark_interval([True] * 194 + [False] * 504, [True] * 194 + [False] * 504,
                               scroll_top=27504, scroll_max=27000)

        self.assertEqual(result["height"], 0)

    def test_requires_the_interior_and_stripe_to_both_be_missing(self):
        result = dark_interval([False] * 698, [True] * 698, scroll_top=12000, scroll_max=27000)

        self.assertEqual(result["height"], 0)

    def test_excludes_empty_space_before_the_start_of_the_file(self):
        result = dark_interval([False] * 504 + [True] * 194, [False] * 504 + [True] * 194,
                               scroll_top=-504, scroll_max=27000)

        self.assertEqual(result["height"], 0)

    def test_fails_a_partial_hole_even_though_the_pane_has_visible_content(self):
        frames = [{"marker": 1, "seconds": 0, "green": 0.3, "bright": 0.1, "dark_height": 504}]
        geometry = {1: {"coverage": 1, "rowCount": 1500, "scrollTop": 12000, "max": 27000, "t": 10}}

        result = assess(frames, geometry)

        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["largest_dark_gap_px"], 504)


if __name__ == "__main__":
    unittest.main()
