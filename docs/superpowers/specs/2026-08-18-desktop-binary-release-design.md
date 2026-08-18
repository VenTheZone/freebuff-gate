# Freebuff Companion Binary and Setup Wizard

**Date:** 2026-08-18  
**Status:** Approved design  
**Scope:** Standalone companion binary for Linux, macOS, and Windows

## Goal

Ship a versioned `freebuff-setup` companion binary that users can launch on a
fresh machine without installing Node or configuring Tailscale. The binary
opens a first-run setup wizard, detects the existing Freebuff Desktop install,
installs or upgrades the mobile-connect companion stack, and reports a usable
or actionable final state.

The binary does not replace or rebuild the upstream Freebuff Desktop
application. It owns companion setup only.

## Scope

### In scope

- Single executable artifacts for Linux, macOS, and Windows.
- Browser-based local wizard with a terminal fallback.
- Per-user installation with no administrator elevation by default.
- Hosted-relay mode as the normal path, behind a control-plane adapter.
- Advanced self-hosted/Tailscale mode for existing users and recovery.
- Idempotent install, upgrade, retry, dry-run, and health-check behavior.
- Versioned artifacts, manifest, SHA-256 checksums, platform signing hooks, and
  native CI smoke tests.

### Out of scope

- Bundling the upstream Desktop app.
- Replacing the existing local gateway or hosted relay control plane.
- Automatic background updates in the first release.
- Mobile store distribution.
- Root/admin service installation as a normal setup step.

## Packaging approach

Use Node 22 Single Executable Application (SEA) generation with a pinned
CommonJS bundle. The repository already uses Node 22 and the setup wizard is
Node code, so the binary can reuse the current planner and installer logic.
The SEA preparation blob embeds the wizard assets and release companion files;
the runtime materializes only the files needed by the installer into a
per-user, versioned cache directory.

Node's Node 22 documentation defines `--experimental-sea-config`, embedded
assets, and `node:sea` asset access. SEA is still marked active development, so
the release workflow must build with a pinned Node version, use platform-native
builders where available, and execute every produced binary before publication:
<https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html>.

The source entrypoint remains runnable with Node during development. A small
asset-store abstraction chooses filesystem assets in development and
`node:sea` assets in the packaged binary. The injected main script must not
depend on file-based `require()`; the bundler produces one deterministic
CommonJS entry file and Node built-ins remain external.

## Runtime architecture

The binary has five narrow layers:

1. **Entry and argument parser** — handles `--version`, `--help`, `--dry-run`,
   `--yes`, `--no-browser`, `--json`, `--advanced`, and `--release`.
2. **Asset store** — reads embedded release files or development siblings,
   verifies the manifest, and materializes an immutable versioned cache.
3. **Platform adapter** — supplies per-user paths, browser launch, process
   execution, Desktop detection, and companion lifecycle operations. Commands
   receive argument arrays; UI input is never interpolated into a shell string.
4. **Setup state machine** — turns discovery and action results into stable
   states and retryable transitions. It is independent of browser rendering.
5. **Local wizard server** — serves embedded HTML/CSS/JS over loopback and
   exposes a small state/action API. The terminal renderer consumes the same
   state machine when `--no-browser` is used or browser launch fails.

The local server binds to `127.0.0.1` on an ephemeral port. Each run gets a
cryptographically random session nonce, expires after inactivity, and requires
that nonce for state-changing requests. It never binds to a LAN address and
does not put account credentials, connector tokens, or provider tokens in the
browser URL, page title, or logs.

## Wizard states and behavior

The first release exposes these observable states:

- **Welcome** — explains what will be installed and offers Continue or
  Advanced setup.
- **Detecting** — finds Freebuff Desktop, its port, existing companion files,
  and current health without modifying state.
- **Desktop missing** — gives an install link/instruction and Retry; it never
  claims setup succeeded without a detected Desktop target.
- **Installing** — stages verified release assets, applies the existing
  installer, and reports step-level progress.
- **Hosted setup** — invokes the hosted-relay adapter when its configured
  control-plane contract is available. The normal path does not ask for relay
  URLs, enrollment tokens, ports, or Tailscale settings.
- **Hosted unavailable** — clearly says hosted onboarding is unavailable,
  offers Retry and Advanced setup, and records no fake success.
- **Ready** — shows Desktop, companion, proxy, and selected transport health;
  provides Open Freebuff and Re-run setup.
- **Offline / retryable failure** — preserves existing state, shows one
  actionable cause, and offers Retry or Advanced setup.
- **Advanced setup** — exposes self-hosted relay and direct Tailscale inputs
  only after an explicit choice; validates them before writing.

Rerunning setup is safe. Existing protected credentials and unrelated Desktop
settings are preserved. Writes use temporary files plus atomic rename, and a
per-user lock prevents concurrent setup runs.

## Platform behavior

The platform adapter provides these implementations:

- **Linux:** XDG config/data directories, `xdg-open`, user-level systemd when
  available, and a clear degraded path when systemd or Tailscale is absent.
- **macOS:** Application Support/config directories, `open`, and per-user
  launch-agent behavior where companion auto-start is enabled.
- **Windows:** `%APPDATA%`/`%LOCALAPPDATA%`, default browser launch through the
  OS, and per-user startup/task behavior without elevation.

The setup core does not assume `systemctl`, `launchctl`, `schtasks`, or
`tailscale` exists. Missing tools become typed state results, not uncaught
shell errors. The first hosted flow does not require any of them.

## Hosted-relay boundary

The binary depends on a `HostedSetupAdapter` interface rather than embedding
tenant or account logic. Its contract returns one of:

- `ready` with an opaque, locally protected connector enrollment result;
- `auth_required` with an official Freebuff account sign-in URL and a polling
  handle that contains no credential;
- `unavailable` with a retry-safe error code; or
- `failed` with a redacted diagnostic.

Until the hosted control-plane implementation is deployed, the adapter returns
`unavailable` and the wizard offers Advanced setup. The binary must not imply
hosted relay, account authorization, or end-to-end tunnel readiness that the
server has not confirmed.

## Release artifacts

Each release publishes:

- `freebuff-setup-v<version>-linux-x64`
- `freebuff-setup-v<version>-linux-arm64`
- `freebuff-setup-v<version>-darwin-x64`
- `freebuff-setup-v<version>-darwin-arm64`
- `freebuff-setup-v<version>-windows-x64.exe`
- matching `.tar.gz`/`.zip` convenience archives;
- a JSON manifest containing version, target, byte count, and SHA-256;
- a `SHA256SUMS` file.

macOS signing/notarization and Windows Authenticode signing are release gates
for stable releases. If signing credentials are unavailable, CI may publish a
clearly marked prerelease artifact only. Linux artifacts remain checksum
verified and may add detached signing in a later release.

There is no background auto-update in v1. A later run may check a versioned
release manifest and offer an explicit update; it must verify checksums before
replacement.

## Verification

### Unit and integration tests

- Argument parsing and asset-store selection.
- Manifest and checksum validation, including tampering and version mismatch.
- Wizard state transitions for fresh install, rerun, missing Desktop, offline
  hosted service, retry, and Advanced mode.
- Platform adapter tests with fake command runners and temporary user homes.
- Redaction tests proving tokens and provider output never reach UI state,
  URLs, or logs.

### Artifact smoke tests

Each native CI job builds its target, verifies the checksum, and executes the
binary without a separately installed Node runtime. It runs `--version`,
`--dry-run`, and a loopback wizard health check. The smoke test confirms the
binary exits cleanly, does not bind beyond loopback, and writes only inside the
temporary test home.

### Manual release checks

Before stable publication, test one clean user account on each OS family:

1. launch binary from a downloaded artifact;
2. complete detection and companion installation;
3. close and rerun wizard;
4. simulate unavailable hosted service and choose Advanced mode;
5. verify existing Desktop settings and credentials remain intact;
6. uninstall only the companion stack and confirm Desktop remains untouched.

## Rollout

First publish a prerelease with unsigned-artifact warnings and hosted setup
disabled unless the adapter endpoint is present. Promote to stable only after
all target binaries pass native smoke tests, signing is active for macOS and
Windows, and hosted setup returns a real server-confirmed state.
