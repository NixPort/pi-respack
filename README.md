# pi-respack

Packages the upstream coding agent (pi) for the phone.

The assistant that lives in the app's Linux environment needs an engine. The engine is not part of
the app: it comes as its own package, which the app downloads (or the player imports from a file),
checks, and swaps in place. This repository builds those packages.

## What a release carries

One asset per package:

```
pi-agent-r<pi version>-<revision>.zip
```

For example `pi-agent-r1.6.0-1.zip`. The app finds the packages by that shape and reads the
manifest inside them.

## What is inside the package

```
manifest.json          what the package is (see below)
pi                     the engine (the upstream Linux arm64 build)
native/                the native addon the engine loads
assets/                the engine's own assets
theme/                 the engine's theme
photon_rs_bg.wasm      the module the engine renders with
package.json           the upstream's own file
```

The upstream's documentation and examples are left behind: the phone has no use for them.

## The manifest

```json
{
  "name": "pi-agent",
  "version": "r1.6.0-1",
  "sha256": "…",
  "minAppVersion": "0.3.0-alpha15",
  "piVersion": "1.6.0"
}
```

- `version` — this package's version. The file name carries it too.
- `sha256` — the digest of the `pi` binary. The app checks it before the engine is put in place; a
  package that does not match is refused and the engine that is installed keeps working.
- `minAppVersion` — the oldest app that can use the package. An older app refuses it instead of
  installing something it cannot run.
- `piVersion` — the upstream version the package was built from.

## Building a package

```bash
python3 build.py --pi-version 1.6.0 --rev 1 --min-app-version 0.3.0-alpha15
```

The script fetches the upstream release, checks it against the digest the upstream publishes, keeps
the files the engine needs, writes the manifest and writes the package into `dist/`.

## Publishing

Push a tag and the workflow builds the package and publishes it as a release asset:

```bash
git tag v1.6.0-1
git push origin v1.6.0-1
```

The tag's name is the package's name: `v<pi version>-<revision>`.

## The upstream

The engine is [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`),
MIT licensed. This repository only repacks it: the code is not changed here.
