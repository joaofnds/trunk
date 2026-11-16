from pathlib import Path
import tempfile
import unittest

from cadence_analysis import decode_pixels


class CadenceDecoder(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.movie = Path(directory.name) / 'pixels.y4m'
        self.frames = [bytes(255 if (x + 2 * y + frame) % 5 == 0 else 0
                             for y in range(12) for x in range(16))
                       for frame in range(3)]
        content = bytearray(b'YUV4MPEG2 W16 H12 F30:1 Ip A1:1 C420jpeg\n')
        for frame in self.frames:
            content.extend(b'FRAME\n')
            content.extend(235 if value else 16 for value in frame)
            content.extend(bytes([128]) * 96)

        self.movie.write_bytes(content)

    def expected_crop(self, crop):
        return [bytes(frame[y * 16 + x]
                      for y in range(crop['y'], crop['y'] + crop['height'])
                      for x in range(crop['x'], crop['x'] + crop['width']))
                for frame in self.frames]

    def test_preserves_odd_crop_dimensions_in_subsampled_video(self):
        crop = {'x': 2, 'y': 2, 'width': 9, 'height': 7}

        decoded = decode_pixels(self.movie, crop)

        self.assertEqual(decoded, self.expected_crop(crop))

    def test_preserves_odd_crop_origins_in_subsampled_video(self):
        crop = {'x': 1, 'y': 1, 'width': 8, 'height': 6}

        decoded = decode_pixels(self.movie, crop)

        self.assertEqual(decoded, self.expected_crop(crop))

    def test_preserves_even_crop_pixels_and_frame_boundaries(self):
        crop = {'x': 2, 'y': 2, 'width': 8, 'height': 6}

        decoded = decode_pixels(self.movie, crop)

        self.assertEqual(decoded, self.expected_crop(crop))


if __name__ == '__main__':
    unittest.main()
