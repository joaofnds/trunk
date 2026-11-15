import hashlib
import struct
import zlib
from pathlib import Path


def create_fixture(path, files, lines):
    if not 1 <= files <= 1000 or not 1 <= lines <= 1000 or files * lines > 200_000:
        raise ValueError('fixture requires 1..1000 files/lines and at most 200,000 total lines')

    path = Path(path)
    objects = path / '.git' / 'objects'
    objects.mkdir(parents=True)
    (path / '.git' / 'refs' / 'heads').mkdir(parents=True)
    (path / '.git' / 'config').write_text('[core]\nrepositoryformatversion = 0\nbare = false\n')

    def write_object(kind, content):
        raw = f'{kind} {len(content)}\0'.encode() + content
        oid = hashlib.sha1(raw).digest()
        target = objects / oid.hex()[:2] / oid.hex()[2:]
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(zlib.compress(raw))
        return oid

    parent = None
    commits = []
    for revision in range(3):
        tree = bytearray()
        entries = bytearray()
        for index in range(files):
            name = f'file-{index:04d}.ts'.encode()
            content = ''.join(f'export const value{line} = "file {index} revision {revision} line {line}";\n'
                              for line in range(lines)).encode()
            blob = write_object('blob', content)
            tree.extend(b'100644 ' + name + b'\0' + blob)
            if revision == 2:
                (path / name.decode()).write_bytes(content)
                entry = struct.pack('!10I', 0, 0, 0, 0, 0, 0, 0o100644, 0, 0, len(content)) + blob + struct.pack('!H', len(name)) + name + b'\0'
                entries.extend(entry + b'\0' * ((-len(entry)) % 8))
        tree_oid = write_object('tree', tree)
        parent_line = f'parent {parent.hex()}\n' if parent else ''
        stamp = 1700000000 + revision * 60
        commit = (f'tree {tree_oid.hex()}\n{parent_line}'
                  f'author Interaction Fixture <fixture@example.test> {stamp} +0000\n'
                  f'committer Interaction Fixture <fixture@example.test> {stamp} +0000\n\n'
                  f'fixture revision {revision}\n').encode()
        parent = write_object('commit', commit)
        commits.append(parent.hex())
    (path / '.git' / 'HEAD').write_text('ref: refs/heads/main\n')
    (path / '.git' / 'refs' / 'heads' / 'main').write_text(parent.hex() + '\n')
    index = b'DIRC' + struct.pack('!II', 2, files) + entries
    (path / '.git' / 'index').write_bytes(index + hashlib.sha1(index).digest())
    return commits
