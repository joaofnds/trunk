"""Sign accepted bytes and finalize the updater feed inside the existing draft release."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "src-tauri/updater-targets.json"
LANES = {
    "darwin-aarch64": "UPDATER_DARWIN_AARCH64",
    "darwin-x86_64": "UPDATER_DARWIN_X86_64",
    "windows-x86_64-nsis": "UPDATER_WINDOWS_X86_64_NSIS",
    "windows-x86_64-msi": "UPDATER_WINDOWS_X86_64_MSI",
    "linux-x86_64-appimage": "UPDATER_LINUX_X86_64_APPIMAGE",
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path):
    return json.loads(path.read_text(), object_pairs_hook=unique_object)


def run(command, **kwargs):
    subprocess.run(command, cwd=ROOT, check=True, timeout=600, **kwargs)


def validator(*args):
    run(["cargo", "run", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
         "-p", "trunk-update-release", "-j", "2", "--", *map(str, args)])


def registry():
    config = read_json(REGISTRY)
    if config == {"targets": {}}:
        return {}
    validator("validate-registry", REGISTRY, ROOT)
    return config["targets"]


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def version():
    value = read_json(ROOT / "src-tauri/tauri.conf.json")["version"]
    if os.environ.get("GITHUB_REF_NAME", f"v{value}") != f"v{value}":
        raise ValueError("release tag and configured app version differ")
    return value


def receipt_for(target, policy, release_version):
    receipt = read_json(ROOT / "updater-acceptance" / f"{target}.json")
    required = {"target", "version", "minimumOsVersion", "file", "sha256", "size", "status", "platformSigning"}
    if set(receipt) != required:
        raise ValueError(f"invalid native acceptance receipt: {target}")
    if (receipt["target"] != target or receipt["version"] != release_version
            or receipt["minimumOsVersion"] != policy["minimumOsVersion"]
            or receipt["status"] != "accepted" or receipt["platformSigning"] != "verified"):
        raise ValueError(f"native acceptance did not approve this lane/version/baseline: {target}")
    source = (ROOT / receipt["file"]).resolve()
    if not source.is_relative_to((ROOT / "src-tauri/target").resolve()):
        raise ValueError("accepted artifact must come from this build's target directory")
    if source.stat().st_size != receipt["size"] or digest(source) != receipt["sha256"]:
        raise ValueError("accepted artifact changed after native acceptance")
    return receipt, source


def prepare(args, targets):
    selected = {lane: targets[lane] for lane in args.targets if lane in targets}
    if not selected:
        print("No enabled updater lanes for this runner; manual assets unchanged.")
        return
    release_version = version()
    output = ROOT / "updater-output"
    output.mkdir(exist_ok=True)
    artifacts = []
    for target, policy in selected.items():
        receipt, source = receipt_for(target, policy, release_version)
        destination = output / f"{target}-{release_version}-{source.name}"
        shutil.copyfile(source, destination)
        signature_path = Path(f"{destination}.sig")
        if args.upload and any(asset["name"] == signature_path.name for asset in draft_assets(release_version)):
            with tempfile.TemporaryDirectory(prefix="trunk-existing-signature-") as temporary:
                run(["gh", "release", "download", f"v{release_version}", "--pattern", signature_path.name,
                     "--dir", temporary, "--repo", "joaofnds/trunk"])
                shutil.copyfile(Path(temporary) / signature_path.name, signature_path)
        else:
            sign(target, release_version, destination)
        if digest(destination) != receipt["sha256"]:
            raise ValueError("artifact changed during signing")
        artifacts.append({
            "target": target, "version": release_version,
            "minimumOsVersion": policy["minimumOsVersion"],
            "file": destination.name,
            "url": f"https://github.com/joaofnds/trunk/releases/download/v{release_version}/{destination.name}",
            "signature": Path(f"{destination}.sig").read_text().strip(),
            "sha256": receipt["sha256"], "size": receipt["size"],
        })
    part = output / "release-input.json"
    part.write_text(json.dumps({"version": release_version, "artifacts": artifacts}))
    subset = output / "registry.json"
    subset.write_text(json.dumps({"targets": selected}))
    validator("assemble", subset, ROOT, part, output, output / "verified-part.json")
    if args.upload:
        for artifact in artifacts:
            immutable_upload(release_version, output / artifact["file"])
            immutable_upload(release_version, output / f'{artifact["file"]}.sig')



def sign(target, release_version, destination):
    secret = LANES[target]
    private_key = os.environ.get(f"{secret}_KEY")
    password = os.environ.get(f"{secret}_PASSWORD")
    if not private_key or password is None:
        raise ValueError(f"missing signing environment for {target}")
    environment = {key: value for key, value in os.environ.items() if not key.startswith("UPDATER_")}
    environment.update(TAURI_SIGNING_PRIVATE_KEY=private_key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD=password)
    run(["bun", "tauri", "signer", "sign", "--app-version", release_version, str(destination)], env=environment)


def draft_assets(release_version):
    result = subprocess.run(
        ["gh", "release", "view", f"v{release_version}", "--json", "isDraft,assets", "--repo", "joaofnds/trunk"],
        cwd=ROOT, check=True, capture_output=True, text=True, timeout=60,
    )
    release = json.loads(result.stdout)
    if not release["isDraft"]:
        raise ValueError("updater assets can only be added to a draft release")
    return release["assets"]


def immutable_upload(release_version, path):
    assets = draft_assets(release_version)
    if any(asset["name"] == path.name for asset in assets):
        with tempfile.TemporaryDirectory(prefix="trunk-existing-asset-") as temporary:
            run(["gh", "release", "download", f"v{release_version}", "--pattern", path.name,
                 "--dir", temporary, "--repo", "joaofnds/trunk"])
            existing = Path(temporary) / path.name
            if existing.stat().st_size != path.stat().st_size or digest(existing) != digest(path):
                raise ValueError(f"refusing to replace an existing asset: {path.name}")
        return
    run(["gh", "release", "upload", f"v{release_version}", str(path), "--repo", "joaofnds/trunk"])


def finalize(targets):
    if not targets:
        print("Updater registry is empty; no feed is assembled or uploaded.")
        return
    release_version = version()
    with tempfile.TemporaryDirectory(prefix="trunk-updater-release-") as temporary:
        root = Path(temporary)
        parts = root / "parts"
        run(["gh", "run", "download", os.environ["GITHUB_RUN_ID"], "--pattern", "updater-*",
             "--dir", str(parts), "--repo", "joaofnds/trunk"])
        artifacts = []
        local = root / "local"
        local.mkdir()
        for part in parts.rglob("release-input.json"):
            data = read_json(part)
            if data["version"] != release_version:
                raise ValueError("mixed versions in build receipts")
            for artifact in data["artifacts"]:
                name = artifact["file"]
                if Path(name).name != name or (local / name).exists():
                    raise ValueError("duplicate or unsafe artifact filename")
                shutil.copyfile(part.parent / name, local / name)
                artifacts.append(artifact)
        release_input = root / "input.json"
        release_input.write_text(json.dumps({"version": release_version, "artifacts": artifacts}))
        manifest = root / "latest.json"
        validator("assemble", REGISTRY, ROOT, release_input, local, manifest)
        hosted = root / "hosted"
        hosted.mkdir()
        for artifact in artifacts:
            run(["gh", "release", "download", f"v{release_version}", "--pattern", artifact["file"],
                 "--dir", str(hosted), "--repo", "joaofnds/trunk"])
        validator("verify-hosted", REGISTRY, ROOT, release_input, hosted, manifest)
        immutable_upload(release_version, manifest)
        run(["gh", "release", "download", f"v{release_version}", "--pattern", "latest.json",
             "--dir", str(hosted), "--repo", "joaofnds/trunk"])
        if (hosted / "latest.json").read_bytes() != manifest.read_bytes():
            raise ValueError("hosted manifest differs from verified local bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("prepare")
    build.add_argument("targets", nargs="+", choices=list(LANES))
    build.add_argument("--upload", action="store_true", help="upload verified assets into the existing draft")
    commands.add_parser("finalize")
    args = parser.parse_args()
    targets = registry()
    if "-" in os.environ.get("GITHUB_REF_NAME", ""):
        print("Prerelease remains outside the stable updater feed.")
        return
    if args.command == "prepare":
        prepare(args, targets)
    else:
        finalize(targets)


if __name__ == "__main__":
    main()
