#!/usr/bin/env python3
"""Pack the upstream coding agent into the package the phone installs.

The engine the assistant runs comes as its own package: the app downloads it (or the player imports
it from a file), checks it against its own manifest, and swaps it in. This builds that package out
of the upstream release.

    python3 build.py --pi-version 1.6.0 --rev 1 --min-app-version 0.3.0-alpha15 [--out dist]

The upstream release carries a standalone Linux arm64 binary (a Bun build) and the files it looks
for beside itself. The package keeps the binary, those files and a manifest; the documentation and
the examples stay behind (the phone has no use for them).

The package also carries the pi extensions the phone can load on demand (extensions.lock.json says
which ones, at which versions). They sit in their own folder beside the engine, so pi does not load
them by itself: the app points at them when the player turns the feature on, and an extension that
nobody loads costs nothing but the disk it takes.

The manifest says what the package is (its version), what the binary's digest is (the app checks it
before the engine is put in place) and which app version the package needs (an older app refuses it).
"""
import argparse
import base64
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

# The npm registry: the pi extensions come from there.
NPM = 'https://registry.npmjs.org'

# The extensions the package carries, with the versions and the digests they are pinned to.
LOCK = Path(__file__).resolve().parent / 'extensions.lock.json'

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


def npm_tarball(name: str, version: str) -> str:
    """Where the registry keeps one package's tarball."""
    return f'{NPM}/{name}/-/{name.split("/")[-1]}-{version}.tgz'


def npm_integrity(data: bytes) -> str:
    """The digest npm publishes for a tarball (sha512, base64)."""
    return 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()


def fetch_npm(name: str, version: str, integrity: str, cache: Path) -> Path:
    """Downloads one package and checks it against the digest the lock file carries."""
    path = cache / 'npm' / f'{name.replace("/", "+")}-{version}.tgz'
    if not path.exists():
        fetch(npm_tarball(name, version), path)
    got = npm_integrity(path.read_bytes())
    if got != integrity:
        raise SystemExit(f'{name}@{version} is not the one the registry published ({got} != {integrity})')
    return path


def unpack_npm(tarball: Path, dest: Path) -> None:
    """Unpacks one npm tarball: every one of them keeps its files under a 'package' folder.

    The type declarations are left behind — the phone runs the code, it does not type-check it.
    """
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tarball) as tar:
        members = []
        for member in tar.getmembers():
            parts = member.name.split('/', 1)
            if len(parts) < 2 or parts[0] != 'package' or member.name.endswith('.d.ts'):
                continue
            member.name = parts[1]
            members.append(member)
        tar.extractall(dest, members=members, filter='data')


def vendor_extensions(stage: Path, cache: Path) -> list[str]:
    """Puts the pi extensions the phone can load into the package.

    They live in their own folder beside the engine, not in the engine's home: pi does not find
    them on its own, so the app points at them when the player turns the feature on. An extension
    that nobody loads costs nothing but the disk it takes.

    Most of them come from the npm registry: the lock file carries their versions and digests.
    An extension of our own (marked "source": "local") lives in this repository — no registry,
    no digest, it is the code next door.
    """
    lock = json.loads(LOCK.read_text())
    names = []
    for spec in lock['extensions']:
        dest = stage / 'extensions' / spec['dir']
        if spec.get('source') == 'local':
            source = Path(__file__).resolve().parent / spec['path']
            if not source.is_dir():
                raise SystemExit(f'the extension {spec["dir"]} is missing ({spec["path"]})')
            shutil.copytree(source, dest, dirs_exist_ok=True)
            names.append(spec['dir'])
            print(f'>> the extension {spec["dir"]} (ours) is in the package')
            continue
        with tempfile.TemporaryDirectory() as tmp:
            unpacked = Path(tmp) / spec['dir']
            unpack_npm(fetch_npm(spec['package'], spec['version'], spec['integrity'], cache), unpacked)
            dest.mkdir(parents=True, exist_ok=True)
            for name in spec['files']:
                source = unpacked / name
                if not source.exists():
                    print(f'>> {spec["package"]} does not carry {name}: skipped')
                    continue
                if source.is_dir():
                    shutil.copytree(source, dest / name, ignore=shutil.ignore_patterns('*.d.ts'))
                else:
                    shutil.copy2(source, dest / name)
        for dep in spec.get('dependencies', []):
            unpack_npm(fetch_npm(dep['name'], dep['version'], dep['integrity'], cache),
                       dest / 'node_modules' / dep['name'])
        # the entry: the compiled JavaScript. The TypeScript sources stay behind — the phone loads
        # the extension through pi's own loader, which reads the compiled files.
        (dest / spec['entry']).write_text(f'import ext from "{spec["target"]}";\nexport default ext;\n')
        names.append(spec['dir'])
        print(f'>> the extension {spec["package"]}@{spec["version"]} is in the package')
    return names


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
        extensions = vendor_extensions(stage, cache)
        manifest = {
            'name': NAME,
            'version': version,
            'sha256': sha256_of(binary),
            'minAppVersion': a.min_app_version,
            'piVersion': a.pi_version,
            'extensions': extensions,
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
