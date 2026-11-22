#!/usr/bin/env python3
"""Pack the upstream coding agent into the package the phone installs.

The engine the assistant runs comes as its own package: the app downloads it (or the player imports
it from a file), checks it against its own manifest, and swaps it in. This builds that package out
of the upstream release.

    python3 build.py --pi-version 1.6.0 --rev 1 --min-app-version 0.3.0-alpha15 [--out dist]

The upstream release carries a standalone Linux arm64 binary (a Bun build) and the files it looks
for beside itself. The package keeps the binary, those files and a manifest; the documentation and
the examples stay behind (the phone has no use for them).

The manifest says what the package is (its version), what the binary's digest is (the app checks it
before the engine is put in place) and which app version the package needs (an older app refuses it).
"""
import argparse
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

UPSTREAM = 'https://github.com/earendil-works/pi/releases/download'

# The files the engine needs beside itself: the native addon, the assets, the theme and the wasm
# module it renders with.
KEEP = ['pi', 'native', 'assets', 'theme', 'photon_rs_bg.wasm', 'package.json']

# The name of the package: the app finds it by this shape.
NAME = 'pi-agent'


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> Path:
    """Downloads a file (the proxy in the environment is honoured)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f'>> {url}')
    with urllib.request.urlopen(url, timeout=120) as response, dest.open('wb') as out:
        shutil.copyfileobj(response, out, 1 << 20)
    return dest


def upstream_digest(version: str, cache: Path) -> str:
    """The digest the upstream release publishes for the Linux arm64 archive."""
    sums = fetch(f'{UPSTREAM}/v{version}/SHA256SUMS', cache / 'SHA256SUMS').read_text()
    for line in sums.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip('*') == 'pi-linux-arm64.tar.gz':
            return parts[0].lower()
    raise SystemExit(f'the upstream release v{version} does not publish the digest of pi-linux-arm64.tar.gz')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--pi-version', required=True, help='the upstream version (1.6.0)')
    ap.add_argument('--rev', required=True, help='the revision of this package (1)')
    ap.add_argument('--min-app-version', required=True, help='the oldest app that can use it')
    ap.add_argument('--out', default='dist')
    ap.add_argument('--cache', default='.cache')
    a = ap.parse_args()

    cache = Path(a.cache)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    version = f'r{a.pi_version}-{a.rev}'
    archive = cache / f'pi-linux-arm64-{a.pi_version}.tar.gz'
    if not archive.exists():
        fetch(f'{UPSTREAM}/v{a.pi_version}/pi-linux-arm64.tar.gz', archive)
    expected = upstream_digest(a.pi_version, cache)
    got = sha256_of(archive)
    if got != expected:
        raise SystemExit(f'the archive is not the one the upstream published ({got} != {expected})')
    print(f'>> the archive is the one the upstream published: {got[:16]}…')

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        with tarfile.open(archive) as tar:
            tar.extractall(work, filter='data')
        source = work / 'pi'
        if not (source / 'pi').is_file():
            raise SystemExit('the upstream archive does not carry the engine')

        stage = work / 'stage'
        stage.mkdir()
        for name in KEEP:
            path = source / name
            if not path.exists():
                print(f'>> the archive does not carry {name}: skipped')
                continue
            if path.is_dir():
                shutil.copytree(path, stage / name)
            else:
                shutil.copy2(path, stage / name)

        binary = stage / 'pi'
        manifest = {
            'name': NAME,
            'version': version,
            'sha256': sha256_of(binary),
            'minAppVersion': a.min_app_version,
            'piVersion': a.pi_version,
        }
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

        package = out / f'{NAME}-{version}.zip'
        with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as z:
            for path in sorted(stage.rglob('*')):
                if path.is_file():
                    z.write(path, str(path.relative_to(stage)))

    print(f'>> {package} ({package.stat().st_size / 2**20:.1f} MB)')
    print(f'>> the manifest: {json.dumps(manifest)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
