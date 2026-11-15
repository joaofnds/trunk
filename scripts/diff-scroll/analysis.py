import json
import math
import subprocess
from pathlib import Path


class Inconclusive(Exception):
    pass


class InvalidPresentationTimes(Inconclusive):
    pass


def decode_marker(levels):
    if len(levels) != 16 or any(48 < level < 192 for level in levels):
        raise Inconclusive("frame marker is not sixteen unambiguous bits")

    return sum(1 << bit for bit, level in enumerate(levels) if level >= 192)


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def dark_interval(green_rows, bright_rows, *, scroll_top, scroll_max):
    height = len(green_rows)
    expected_top = max(0, math.ceil(-scroll_top))
    expected_bottom = min(height, math.floor(height + scroll_max - scroll_top))
    longest = {"top": 0, "bottom": 0, "height": 0}
    start = expected_top
    for row in range(expected_top, expected_bottom):
        if green_rows[row] or bright_rows[row]:
            start = row + 1
        elif row + 1 - start > longest["height"]:
            longest = {"top": start, "bottom": row + 1, "height": row + 1 - start}

    return longest


def classify_pixels(stripe, pane, *, height):
    if height <= 0 or len(stripe) != 6 * height * 3 or len(pane) != 64 * height * 3:
        raise Inconclusive("RGB crops do not match the expected scanline dimensions")

    green_pixels = [stripe[i + 1] > stripe[i] * 1.25 + 10 and stripe[i + 1] > stripe[i + 2] * 1.15
                    for i in range(0, len(stripe), 3)]
    bright_pixels = [max(pane[i:i + 3]) > 35 for i in range(0, len(pane), 3)]

    return {
        "green": sum(green_pixels) / len(green_pixels),
        "bright": sum(bright_pixels) / len(bright_pixels),
        "green_rows": [any(green_pixels[row * 6:(row + 1) * 6]) for row in range(height)],
        "bright_rows": [any(bright_pixels[row * 64:(row + 1) * 64]) for row in range(height)],
    }


def captured_geometry(frames, geometry):
    selected = {}
    for index, frame in enumerate(frames):
        if frame["marker"] not in geometry:
            raise Inconclusive(f"frame {index} names unknown geometry {frame['marker']}")

        selected[frame["marker"]] = geometry[frame["marker"]]

    return selected


def validate_motion(samples, minimum):
    positions = [max(0, min(sample["max"], sample["scrollTop"])) for sample in samples]
    if not positions or max(positions) - min(positions) < minimum:
        raise Inconclusive(f"captured trace did not move through at least {minimum:g}px of file content")


def assess(frames, geometry):
    if not frames:
        raise Inconclusive("capture contains no decoded frames")

    times = [frame["seconds"] for frame in frames]
    if any(not math.isfinite(value) for value in times) or any(right < left for left, right in zip(times, times[1:])):
        raise InvalidPresentationTimes("presentation timestamps must be finite and ordered")

    all_samples = sorted(geometry.values(), key=lambda item: item["t"])
    geometry = captured_geometry(frames, geometry)
    blanks = []
    durations = []
    run_start = None
    last_blank = None
    for index, frame in enumerate(frames):
        sample = geometry[frame["marker"]]
        in_range = 0 <= sample["scrollTop"] <= sample["max"]
        expects_content = in_range or sample["coverage"] > 0.5
        whole_pane = frame["green"] < 0.01 and frame["bright"] < 0.005 and expects_content
        blank = whole_pane or frame["dark_height"] >= 64
        if blank:
            blanks.append(index)
            if run_start is None:
                run_start = frame["seconds"]
            last_blank = frame["seconds"]
        elif run_start is not None:
            durations.append(last_blank - run_start)
            run_start = None

    if run_start is not None:
        durations.append(last_blank - run_start)

    samples = sorted(geometry.values(), key=lambda item: item["t"])
    raf_samples = [sample for sample in all_samples if samples[0]["t"] <= sample["t"] <= samples[-1]["t"]]
    gaps = [right["t"] - left["t"] for left, right in zip(raf_samples, raf_samples[1:])]

    return {
        "verdict": "fail" if blanks else "pass",
        "scope": "whole-pane blanks and dark vertical gaps of at least 64px in the synthetic added-file fixture",
        "frames": len(frames),
        "captured_fps": round((len(frames) - 1) / (times[-1] - times[0]), 3) if times[-1] > times[0] else 0,
        "presentation_seconds": times,
        "blank_frames": blanks,
        "largest_dark_gap_px": max(frame["dark_height"] for frame in frames),
        "longest_blank_ms_lower_bound": round(max(durations, default=0) * 1000, 3),
        "raf_gap_p95_ms": round(percentile(gaps, 0.95), 3) if gaps else None,
        "raf_gap_p50_ms": round(percentile(gaps, 0.5), 3) if gaps else None,
        "raf_gap_p99_ms": round(percentile(gaps, 0.99), 3) if gaps else None,
        "raf_gap_max_ms": round(max(gaps), 3) if gaps else None,
        "mounted_rows_max": max(sample["rowCount"] for sample in samples),
        "scroll_min": min(sample["scrollTop"] for sample in samples),
        "scroll_max": max(sample["scrollTop"] for sample in samples),
        "blank_evidence": [{"frame": i, **frames[i], "geometry": geometry[frames[i]["marker"]],
                            "kind": "missing_rows" if geometry[frames[i]["marker"]]["coverage"] < 0.5 else "missing_paint"}
                           for i in blanks],
    }


def pixels(movie, expression, stride):
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-threads", "1", "-i", str(movie), "-vf", expression,
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True, timeout=30,
    )
    if len(result.stdout) % stride:
        raise Inconclusive("decoder returned an incomplete frame")

    return [result.stdout[index:index + stride] for index in range(0, len(result.stdout), stride)]


def validate_capture(capture, decoded_counts):
    if not {"frames", "droppedFrames", "streamError", "invalidFrames", "statuses", "samples"}.issubset(capture):
        raise Inconclusive("capture report is missing frame or stream status")

    statuses = capture["statuses"]
    if not statuses or set(statuses) - {"0", "1", "4", "5"}:
        raise Inconclusive(f"capture contains blank, suspended or unknown frame statuses: {statuses}")

    counts = [*decoded_counts, capture["frames"], len(capture["samples"]), statuses.get("0", 0)]
    if not capture["frames"] or len(set(counts)) != 1 or capture["droppedFrames"] or capture["streamError"] or capture["invalidFrames"]:
        raise Inconclusive(f"capture and decoded frame counts disagree or capture lost frames: {counts}")


def mach_ticks(samples, field):
    values = []
    for sample in samples:
        value = sample.get(field)
        if not isinstance(value, str) or not value.isdecimal() or int(value) <= 0:
            raise Inconclusive(f"missing or invalid {field} timestamp")

        values.append(int(value))

    if not values or any(right < left for left, right in zip(values, values[1:])):
        raise Inconclusive(f"{field} timestamps must exist and be ordered")

    return values


def validate_temporal_coverage(capture, delivery):
    if not {"sent", "events"}.issubset(delivery) or delivery["sent"] != len(delivery["events"]):
        raise Inconclusive("native input delivery timestamps are incomplete")

    displayed = mach_ticks(capture["samples"], "displayMachTicks")
    delivered = mach_ticks(delivery["events"], "machTicks")
    if displayed[0] > delivered[0] or displayed[-1] < delivered[-1]:
        raise Inconclusive("captured frames do not bracket the whole native input delivery interval")


def analyze(directory):
    directory = Path(directory)
    movie = directory / "capture.mov"
    samples = json.loads((directory / "geometry.json").read_text())
    if not samples:
        raise Inconclusive("geometry sampling produced no samples")

    geometry = {sample["seq"]: sample for sample in samples}
    if len(geometry) != len(samples):
        raise Inconclusive("geometry contains duplicate frame markers")

    box = json.loads((directory / "viewport.json").read_text())
    x, y, width, height = (round(box[key]) for key in ("left", "top", "width", "height"))
    markers = pixels(movie, "crop=128:8:8:220", 128 * 8 * 3)
    stripes = pixels(movie, f"crop=6:{height}:{x}:{y}", 6 * height * 3)
    panes = pixels(movie, f"crop={width - 30}:{height}:{x + 6}:{y},scale=64:{height}", 64 * height * 3)
    timestamps = json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "frame=best_effort_timestamp_time", "-of", "json", str(movie)], timeout=30,
    ))["frames"]
    capture = json.loads((directory / "capture.mov.json").read_text())
    validate_capture(capture, [len(markers), len(stripes), len(panes), len(timestamps)])
    delivery = json.loads((directory / "native-input.json").read_text())
    validate_temporal_coverage(capture, delivery)

    frames = []
    for marker, stripe, pane, timestamp in zip(markers, stripes, panes, timestamps):
        levels = [marker[(4 * 128 + bit * 8 + 4) * 3] for bit in range(16)]
        sequence = decode_marker(levels)
        if sequence not in geometry:
            raise Inconclusive(f"frame names unknown geometry {sequence}")

        colors = classify_pixels(stripe, pane, height=height)
        sample = geometry[sequence]
        hole = dark_interval(colors["green_rows"], colors["bright_rows"], scroll_top=sample["scrollTop"], scroll_max=sample["max"])
        frames.append({"marker": sequence, "seconds": float(timestamp["best_effort_timestamp_time"]),
                       "green": colors["green"], "bright": colors["bright"], "dark_height": hole["height"], "dark_interval": hole})

    planned_input = json.loads((directory / "input.json").read_text())
    if len(planned_input) != delivery["sent"]:
        raise Inconclusive("native input delivery did not contain the planned trace")

    first_fling_travel = sum(abs(event["dy"]) for event in planned_input[:27])
    validate_motion(captured_geometry(frames, geometry).values(), min(height, first_fling_travel / 2))
    result = assess(frames, geometry)
    result["viewport"] = box

    return result
