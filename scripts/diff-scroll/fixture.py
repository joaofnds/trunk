import hashlib
import zlib
from pathlib import Path


def create_fixture(path, lines, *, history=1):
    if type(lines) is not int or not 1 <= lines <= 90000:
        raise ValueError("lines must be an integer in 1..90000")

    if type(history) is not int or not 1 <= history <= 400:
        raise ValueError("history must be an integer in 1..400")

    path = Path(path)
    objects = path / ".git" / "objects"
    objects.mkdir(parents=True)
    (path / ".git" / "refs").mkdir()
    (path / ".git" / "config").write_text("[core]\n\trepositoryformatversion = 0\n\tbare = false\n")

    def write_object(kind, content):
        raw = f"{kind} {len(content)}\0".encode() + content
        oid = hashlib.sha1(raw).hexdigest()
        target = objects / oid[:2] / oid[2:]
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(zlib.compress(raw))

        return oid

    def commit(tree, parent, summary):
        parent_line = f"parent {parent}\n" if parent else ""
        content = (f"tree {tree}\n{parent_line}"
                   "author Scroll Fixture <fixture@example.test> 1700000000 +0000\n"
                   "committer Scroll Fixture <fixture@example.test> 1700000000 +0000\n\n"
                   f"{summary}\n")

        return write_object("commit", content.encode())

    base = None
    empty_tree = write_object("tree", b"")
    for index in range(history):
        summary = "empty fixture" if history == 1 else f"history row {index:04d}"
        base = commit(empty_tree, base, summary)
    content = "".join(f'export const row{index:06d} = "native diff scrolling fixture {index:06d}";\n'
                      for index in range(lines)).encode()
    (path / "scroll.ts").write_bytes(content)
    blob = write_object("blob", content)
    tree = write_object("tree", b"100644 scroll.ts\0" + bytes.fromhex(blob))
    head = commit(tree, base, "native scroll fixture")
    (path / ".git" / "HEAD").write_text(head + "\n")
    tags = path / ".git" / "refs" / "tags"
    tags.mkdir()
    (tags / "scroll-fixture").write_text(head + "\n")

    return head
