#!/usr/bin/env python3
import argparse
import fcntl
import hashlib
import json
import os
import select
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from analysis import Inconclusive, analyze
from fixture import create_fixture
from process_admission import inventory_snapshot, measurement_window

SOURCE = Path(__file__).resolve().parent


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def parse_reply(reply, native=False):
    if not isinstance(reply, dict):
        raise Inconclusive("socket reply is not an object")

    if native:
        if "error" in reply:
            raise Inconclusive(str(reply["error"]))

        return reply

    if reply.get("ok") is not True or "value" not in reply:
        raise Inconclusive(str(reply.get("error", "drive returned no result")))

    return reply["value"]


def request(directory, body, native=False):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(40)
        connection.connect(str(directory / ("native.sock" if native else "drive.sock")))
        connection.sendall(json.dumps(body).encode() + b"\n")
        reply = json.loads(connection.makefile().readline())

    return parse_reply(reply, native=native)


def evaluate(directory, expression):
    return request(directory, {"op": "eval", "js": expression})


def until(directory, expression):
    return evaluate(directory, f"window.__trunkDrive.until({json.dumps(expression)})")


def wait_ready(directory, process):
    deadline = time.monotonic() + 25
    while not ((directory / "listening").exists() and (directory / "native.sock").exists()):
        if process.poll() is not None:
            raise Inconclusive(f"app exited {process.returncode} before becoming ready")

        if time.monotonic() >= deadline:
            raise Inconclusive("app did not announce its sockets within 25 seconds")

        time.sleep(0.05)


def configure_display(directory, output, manifest, *, send=request):
    manifest["native_display"] = send(directory, {"op": "virtual-display",
                                                "refreshRate": manifest["requested_refresh_rate"]}, native=True)
    save(output / "manifest.json", manifest)


def place_window(directory):
    deadline = time.monotonic() + 10
    while True:
        try:
            return request(directory, {"op": "place-on-virtual-display"}, native=True)
        except Inconclusive:
            if time.monotonic() >= deadline:
                raise

            time.sleep(0.05)


def visible_window(directory):
    deadline = time.monotonic() + 10
    while True:
        info = request(directory, {"op": "info"}, native=True)
        if info["occlusion"] & 2:
            return info

        if time.monotonic() >= deadline:
            raise Inconclusive("test window is covered; covered windows invalidate this experiment")

        time.sleep(0.05)


def trace(box, profile):
    x = box["left"] + box["width"] / 2
    y = box["top"] + box["height"] / 2
    events = []
    step_ms, fling_ms, gesture_delta, momentum_delta = {
        "slow": (16, 600, 45, 60),
        "fast": (8, 500, 180, 240),
    }[profile]
    for fling in range(8):
        direction = -1 if fling % 2 == 0 else 1
        origin = fling * fling_ms
        for step in range(5):
            events.append(dict(atMs=origin + step * step_ms, x=x, y=y, dy=direction * gesture_delta,
                               phase=1 if step == 0 else 2, momentum=0))
        events.append(dict(atMs=origin + 5 * step_ms, x=x, y=y, dy=0, phase=4, momentum=0))
        for step in range(20):
            events.append(dict(atMs=origin + (6 + step) * step_ms, x=x, y=y,
                               dy=direction * round(momentum_delta * 0.86 ** step), phase=0,
                               momentum=1 if step == 0 else 2))
        events.append(dict(atMs=origin + 26 * step_ms, x=x, y=y, dy=0, phase=0, momentum=3))

    return events


def validate_wheel(observed, native, expected, window):
    if native["windowNumber"] != window:
        raise Inconclusive("native wheel event is not bound to the test window")

    if abs(observed["x"] - expected["x"]) > 1 or abs(observed["y"] - expected["y"]) > 1:
        raise Inconclusive(f"native event missed its target: {observed}")


def capture(directory, output, info, events):
    with (output / "capture.stderr.log").open("w") as errors:
        recorder = subprocess.Popen(
            [str(output / "native-capture"), str(info["window"]), str(output / "capture.mov"), "5"],
            stdout=subprocess.PIPE, stderr=errors, text=True,
        )
        try:
            ready, _, _ = select.select([recorder.stdout], [], [], 15)
            if not ready or not recorder.stdout.readline().startswith("READY "):
                raise Inconclusive("recorder did not announce readiness; see capture.stderr.log")
            response = request(directory, {"op": "sequence", "events": events}, native=True)
            save(output / "native-input.json", response)
            if response.get("sent") != len(events):
                raise Inconclusive("native injector did not send the whole trace")
            if response["first"]["windowNumber"] != info["window"] or response["last"]["windowNumber"] != info["window"]:
                raise Inconclusive("native trace was not bound to the test window")
            remaining = recorder.communicate(timeout=20)[0]
            (output / "capture.stdout.log").write_text(remaining)
            if recorder.returncode != 0:
                raise Inconclusive(f"recorder exited {recorder.returncode}; see capture.stderr.log")
        finally:
            if recorder.poll() is None:
                recorder.terminate()
                try:
                    recorder.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    recorder.kill()
                    recorder.wait(timeout=5)


def capture_with_admission(directory, output, info, events, *, capture_operation=None, snapshot=inventory_snapshot):
    with measurement_window(output, snapshot=snapshot):
        return (capture if capture_operation is None else capture_operation)(directory, output, info, events)


class NativeDriver:
    request = staticmethod(request)
    evaluate = staticmethod(evaluate)
    until = staticmethod(until)
    wait_ready = staticmethod(wait_ready)
    place_window = staticmethod(place_window)
    visible_window = staticmethod(visible_window)

    def capture(self, directory, output, info, events):
        return capture(directory, output, info, events)


def run(args, *, host=subprocess, driver=None, snapshot=inventory_snapshot):
    driver = NativeDriver() if driver is None else driver
    output = Path(args.output).resolve()
    binary = Path(args.binary).resolve()
    with binary.open("rb") as executable:
        binary_hash = hashlib.file_digest(executable, "sha256").hexdigest()

    manifest = {"source_revision_supplied": args.source_revision, "process_admission_required": True,
                "binary": str(binary), "binary_sha256": binary_hash,
                "lines": args.lines, "flings": 8, "capture_seconds": 5,
                "start_scroll": args.start_scroll,
                "profile": args.profile,
                "requested_refresh_rate": args.refresh_rate,
                "platform": host.check_output(["sw_vers"], text=True, timeout=5).strip()}
    save(output / "manifest.json", manifest)
    with (output / "compile.log").open("w") as log:
        host.run(["clang", "-dynamiclib", "-fobjc-arc", "-framework", "AppKit", "-framework", "WebKit",
                        "-framework", "CoreGraphics", str(SOURCE / "native-probe.m"), "-o", str(output / "native-probe.dylib")],
                       check=True, stdout=log, stderr=log, timeout=60)
        host.run(["swiftc", "-parse-as-library", "-O", str(SOURCE / "native-capture.swift"),
                        "-o", str(output / "native-capture")], check=True, stdout=log, stderr=log, timeout=60)

    with tempfile.TemporaryDirectory(prefix="trunk-scroll-", dir="/tmp") as temporary:
        directory = Path(temporary)
        repository = directory / "repo"
        create_fixture(repository, args.lines)
        data = directory / "data"
        data.mkdir()
        save(data / "trunk-prefs.json", {"open_tabs": [{"id": "scroll", "repoPath": str(repository), "repoName": "scroll fixture"}],
                                        "active_tab_id": "scroll"})
        environment = {**os.environ, "TRUNK_DRIVE_DIR": str(directory), "TRUNK_DATA_DIR": str(data),
                       "DYLD_INSERT_LIBRARIES": str(output / "native-probe.dylib")}
        with (output / "app.log").open("w") as log:
            app = host.Popen([str(binary)], env=environment, stdout=log, stderr=log)
            try:
                driver.wait_ready(directory, app)
                driver.until(directory, '[...document.querySelectorAll("[data-testid=commit-row-summary]")].some(x=>x.textContent.trim()==="native scroll fixture")')
                configure_display(directory, output, manifest, send=driver.request)
                driver.place_window(directory)
                info = driver.visible_window(directory)
                manifest["native_window"] = info
                save(output / "manifest.json", manifest)
                driver.evaluate(directory, '([...document.querySelectorAll("[data-testid=commit-row-summary]")].find(x=>x.textContent.trim()==="native scroll fixture").click(),true)')
                driver.until(directory, '(()=>{const file=[...document.querySelectorAll("[data-testid=commit-detail] *")].find(x=>x.childElementCount===0&&x.textContent.trim()==="scroll.ts");if(!file)return false;file.click();return true})()')
                driver.until(directory, 'document.querySelector(".exact-virtual-rows .diff-line-add")')
                driver.evaluate(directory, f"window.diffScrollStart={args.start_scroll}")
                observation = (SOURCE / "observe.js").read_text().rstrip().removesuffix(";")
                box = driver.evaluate(directory, observation)
                save(output / "viewport.json", box)
                events = trace(box, args.profile)
                native = driver.request(directory, {"op": "wheel", **events[0], "dy": -1}, native=True)
                observed = driver.until(directory, 'window.diffScrollWheel.length>0&&window.diffScrollWheel[0]')
                validate_wheel(observed, native, events[0], info["window"])
                save(output / "wheel-calibration.json", {"native": native, "observed": observed, "window": info["window"]})
                driver.request(directory, {"op": "wheel", **events[0], "dy": 0, "phase": 4}, native=True)
                box = driver.evaluate(directory, observation)
                save(output / "viewport.json", box)
                save(output / "input.json", events)
                capture_with_admission(directory, output, info, events, capture_operation=driver.capture, snapshot=snapshot)
                samples = driver.evaluate(directory, '(window.diffScrollStop(),window.diffScrollSamples)')
                save(output / "geometry.json", samples)
                result = analyze(output)
                save(output / "result.json", result)
                return result
            finally:
                try:
                    driver.request(directory, {"op": "quit"})
                    app.wait(timeout=5)
                except (OSError, ValueError, Inconclusive, subprocess.TimeoutExpired):
                    app.terminate()
                    try:
                        app.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        app.kill()
                        app.wait(timeout=5)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Replay a bounded native diff-scroll trace and preserve pixel/DOM evidence.")
    parser.add_argument("--binary", required=True, help="existing drive build, never the installed user app")
    parser.add_argument("--source-revision", required=True, help="source revision used to build that binary; recorded as supplied")
    parser.add_argument("--output", required=True, help="new artifact directory; existing paths are refused")
    parser.add_argument("--lines", type=int, choices=[146, 1500, 90000], default=146)
    parser.add_argument("--start-scroll", type=int, default=0, help="initial scroll position in CSS pixels, within fixture bounds")
    parser.add_argument("--profile", choices=["slow", "fast"], default="slow", help="peak input 3750px/s or 30000px/s")
    parser.add_argument("--refresh-rate", type=int, choices=[60, 120], default=60,
                        help="requested virtual display refresh rate; the native mode is recorded separately")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    output = Path(args.output).resolve()
    owns_output = False
    try:
        with Path("/tmp/trunk-native-diff-scroll.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            output.mkdir(parents=True, exist_ok=False)
            owns_output = True
            result = run(args)

        print(json.dumps({key: value for key, value in result.items()
                          if key not in {"presentation_seconds", "blank_evidence"}}, indent=2))
        return 1 if result["verdict"] == "fail" else 0
    except (Inconclusive, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        result = {"verdict": "inconclusive", "reason": str(error), "error_notes": getattr(error, '__notes__', [])}
        if owns_output:
            save(output / "result.json", result)
        print(json.dumps(result, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
