from pathlib import Path
from types import SimpleNamespace

from analysis import Inconclusive


class AppFake:
    pid = 7

    def __init__(self):
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, *, timeout):
        self.returncode = 0
        return self.returncode


class HostFake:
    def __init__(self):
        self.app = AppFake()
        self.commands = []

    def check_output(self, command, **options):
        return 'Test OS' if command[0] == 'sw_vers' else '7 0.0 /test/drive-app\n'

    def run(self, command, **options):
        self.commands.append(command)
        Path(command[command.index('-o') + 1]).write_bytes(b'compiled helper')

    def Popen(self, command, **options):
        self.commands.append(command)
        return self.app


class NativeDriverFake:
    def __init__(self):
        self.recorder_starts = 0

    def wait_ready(self, directory, app):
        return True

    def place_window(self, directory):
        return True

    def visible_window(self, directory):
        return {'pid': 7, 'window': 70, 'displayID': 1, 'visible': True, 'occlusion': 2}

    def request(self, directory, body, native=False):
        if body['op'] == 'processes':
            return {'host': 7, 'web': 8, 'gpu': 9}
        if body['op'] == 'wheel':
            return {'windowNumber': 70}
        return {'displayID': 1}

    def until(self, directory, expression):
        return {'x': 300, 'y': 200} if 'diffScrollWheel' in expression else True

    def evaluate(self, directory, expression):
        return {'left': 100, 'top': 50, 'width': 400, 'height': 300, 'scrollTop': 1200, 'max': 5000}

    def capture(self, directory, output, info, events):
        self.recorder_starts += 1
        raise Inconclusive('fake capture stops at recorder startup')


def trial_arguments(directory):
    output = directory / 'artifacts'
    output.mkdir()
    binary = directory / 'drive-app'
    probe = directory / 'probe.dylib'
    recorder = directory / 'recorder'
    for path in [binary, probe, recorder]:
        path.write_bytes(b'test executable')

    return SimpleNamespace(output=output, binary=binary, native_probe=probe, recorder=recorder,
                           source_revision='test revision', lines=146, start_scroll=0, profile='fast',
                           refresh_rate=120, display='virtual', mode='graph', resources=False, geometry=False)
