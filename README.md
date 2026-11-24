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
extensions/            the pi extensions the phone can load on demand
```

The upstream's documentation and examples are left behind: the phone has no use for them.

## The extensions

`extensions/<name>/` holds a pi extension: its compiled JavaScript, its skills and the packages it
needs at run time. They come from the npm registry, pinned by version and by digest in
`extensions.lock.json`.

One of them is ours: `local-extensions/nx2a-subagent-records` lives in this repository and the lock
file points at it (`"source": "local"`). It has no dependencies and no digest — it is the code next
door, and it travels with the package like the others.

They sit beside the engine, not in the engine's home, so **pi does not load them on its own**:
the app points at them when the player turns the feature on. An extension nobody loads costs
nothing but the disk it takes (the first one, `pi-subagents`, is about 8 MB).

## The manifest

```json
{
  "name": "pi-agent",
  "version": "r1.6.0-1",
  "sha256": "…",
  "minAppVersion": "0.3.0-alpha15",
  "piVersion": "1.6.0",
  "extensions": ["pi-subagents"]
}
```

- `version` — this package's version. The file name carries it too.
- `sha256` — the digest of the `pi` binary. The app checks it before the engine is put in place; a
  package that does not match is refused and the engine that is installed keeps working.
- `minAppVersion` — the oldest app that can use the package. An older app refuses it instead of
  installing something it cannot run.
- `piVersion` — the upstream version the package was built from.
- `extensions` — the extensions the package carries. The app decides whether to load them.

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
