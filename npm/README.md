# freebuff-gate npm distribution

Six packages that ship the `freebuff-setup` SEA binaries through npm:

| Package | Platform | os / cpu |
|---|---|---|
| `freebuff-gate` | metapackage (bin `freebuff-setup`) | any |
| `freebuff-gate-linux-x64` | Linux x64 | linux / x64 |
| `freebuff-gate-linux-arm64` | Linux arm64 | linux / arm64 |
| `freebuff-gate-darwin-x64` | macOS Intel | darwin / x64 |
| `freebuff-gate-darwin-arm64` | macOS Apple Silicon | darwin / arm64 |
| `freebuff-gate-windows-x64` | Windows x64 | win32 / x64 |

The metapackage's launcher (`bin/freebuff-setup.js`) resolves the matching
platform package via `optionalDependencies` and spawns its binary, so npm
installs only the binary for the host platform. Version numbers in these
stubs are placeholders (`0.0.0`); the publish script stamps the real version.

## Install

```sh
npm install -g freebuff-gate
freebuff-setup --version
freebuff-setup --dry-run
```

## Publish

Prerequisite: CI-built SEA binaries for the version (default lookup
`dist/freebuff-setup-v<version>/`).

```sh
node src/package-freebuff-npm.js --version v0.2.0                    # pack only, inspect tarballs
node src/package-freebuff-npm.js --version v0.2.0 --publish --npm-tag next # publish prerelease packages
```

Platform packages are published before the metapackage so the pinned
`optionalDependencies` always resolve. `--npm-tag next` keeps prerelease
packages out of the `latest` dist-tag. Publishing requires npm credentials
(`NPM_TOKEN` or `npm login`); every package must use the same version.

The setup-binary workflow publishes these packages only for a manual run with
`publish_prerelease` enabled and `NPM_TOKEN` configured. It verifies the
release sidecar before packing and publishing, then installs the published
package in Linux, macOS, and Windows CI runners. Each runner checks
`freebuff-setup --version` and `--dry-run`.

The staged `dist/` release and the GitHub prerelease remain the primary
distribution for users without Node; this npm wrapper is a convenience for
developer installs.
