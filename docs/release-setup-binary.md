# freebuff-setup binary releases

How `freebuff-setup` artifacts are named, verified, signed, and published.

## Artifacts

Each target produces one self-contained executable. The packager builds it as
a Node 22 single-executable application (SEA) with setup assets embedded.
`src/package-freebuff-setup.js` creates the artifacts.

| Target | Runner | Artifact |
|---|---|---|
| linux-x64 | ubuntu-24.04 | `freebuff-setup-<version>-linux-x64` |
| linux-arm64 | ubuntu-24.04-arm | `freebuff-setup-<version>-linux-arm64` |
| darwin-x64 | macos-13 | `freebuff-setup-<version>-darwin-x64` |
| darwin-arm64 | macos-14 | `freebuff-setup-<version>-darwin-arm64` |
| windows-x64 | windows-2022 | `freebuff-setup-<version>-windows-x64.exe` |

Versions follow `v\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)*` (for example `v0.2.0`,
`v0.2.0-rc1`). Each release ships two sidecars:

- `freebuff-setup-<version>-SHA256SUMS`: `sha256 <space><space> name` lines
  for every artifact and the manifest itself.
- `freebuff-setup-<version>-manifest.json`: `schemaVersion: 1`, `product`,
  `version`, and an `artifacts` array with `target`, `assetName`, `bytes`, and
  `sha256` for each binary.

Local builds are staged under `dist/freebuff-setup-<version>/` in this repo
(`dist/` is gitignored; staging is on-disk only).

## Reproduce a build

Pin Node v22.23.1. Native builds use the runner's Node binary. Cross-builds
use `--host-node-binary` to prepare the SEA blob and `--node-binary` for the
target executable:

```sh
node src/package-freebuff-setup.js --version v0.2.0 --target linux-x64 --output <outdir>
node src/package-freebuff-setup.js --metadata --version v0.2.0 --output <outdir>
```

For a cross-build, add `--host-node-binary <host-node>` and
`--node-binary <target-node>` to the build command. The host binary prepares
the SEA blob; the target binary becomes the packaged executable.

The SEA blob is prepared with `--experimental-sea-config` (embedded `assets`),
injected with `npx postject@1.0.0-alpha.6` and sentinel fuse
`NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`. macOS builds strip the
signature before injection (`codesign --remove-signature`).

## Verify checksums

```sh
sha256sum -c freebuff-setup-v0.2.0-SHA256SUMS
# freebuff-setup-v0.2.0-linux-x64: OK
# freebuff-setup-v0.2.0-manifest.json: OK

./freebuff-setup-v0.2.0-linux-x64 --version   # freebuff-setup v0.2.0
./freebuff-setup-v0.2.0-linux-x64 --dry-run   # report + plan, change nothing
```

The manifest records a `sha256` value for each artifact. The `SHA256SUMS`
sidecar covers those artifacts and the manifest, so one checksum check also
covers the manifest contents.

## Signing status

Prerelease artifacts are **unsigned** by default. macOS Gatekeeper and Windows
SmartScreen warn on first launch (right-click → Open on macOS).

The setup-binary workflow signs when signing secrets are configured. Signing
runs after smoke tests and before upload, so the metadata job hashes the final
bytes:

- **macOS**: Developer ID Application codesign (`--options runtime
  --timestamp`), followed by `notarytool submit --wait`, `stapler staple`, and
  `stapler validate`. It requires `MACOS_CERT_P12`,
  `MACOS_CERT_P12_PASSWORD`, and `MACOS_CERT_ID`. Notarization also requires
  `MACOS_NOTARY_APPLE_ID`, `MACOS_NOTARY_PASSWORD`, and
  `MACOS_NOTARY_TEAM_ID`. A cert-only setup produces a signed but
  unnotarized build.
- **Windows**: Authenticode with SHA-256 (`/fd SHA256`) and an RFC 3161
  timestamp (`/tr https://timestamp.digicert.com /td SHA256`) through the
  Windows SDK `signtool`. It requires `WINDOWS_CERT_PFX` and
  `WINDOWS_CERT_PFX_PASSWORD`, with the certificate and private key encoded in
  base64.
- **Linux**: no signing step. Distribution-package signing is out of scope.

If a platform's secrets are missing, its signing steps are skipped and the
artifact remains unsigned. Prerelease publishing does not require signing
credentials. A stapled macOS binary has a different checksum from the
unsigned build; the manifest records the shipped bytes.

## Trigger a prerelease

Workflow: `.github/workflows/setup-binary.yml`. It has two entry points:

1. **Manual, recommended for prereleases**: GitHub UI → Actions → *Freebuff
   setup binary* → *Run workflow*:
   - `version`: `v0.2.0`
   - `publish_prerelease`: check the box to publish a GitHub prerelease after
     the build.
2. **Tag push**: pushing a `v*.*.*` tag runs the same build, test, and signing
   pipeline. It does not publish; publishing remains manual.

Job flow: `version` normalizes and validates the version, `tests` runs the
release suites on Node 22.23.1, and `build` handles the five targets, smoke
tests, agent-reconnect smoke, optional signing, and upload. `metadata` writes
the manifest and `SHA256SUMS` for the final artifacts. `publish-prerelease`
runs only for a manual workflow with the checkbox enabled.

The publish step creates a GitHub **prerelease** with `--generate-notes`:

```sh
gh release create v0.2.0 dist/* --repo <owner>/<repo> --prerelease --generate-notes
```

## Release checklist

- [ ] Version bumped and validated (`v\d+\.\d+\.\d+…`).
- [ ] `tests` and `build` jobs green on all five targets (agent-reconnect smoke
      included).
- [ ] Signing secrets set if shipping signed artifacts; otherwise prerelease
      stays unsigned and the docs note it.
- [ ] `sha256sum -c freebuff-setup-<version>-SHA256SUMS` passes.
- [ ] Staged local copy under `dist/freebuff-setup-<version>/` refreshed when
      embedded assets change (rebuild embeds the current `src/` files).
