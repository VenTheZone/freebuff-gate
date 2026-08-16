#!/usr/bin/env bash
# One-command installer for the Freebuff Gate stack: the Freebuff Desktop
# mobile-connect companion plus the Freebuff Gate readiness checks (Desktop
# install discovery and host dependencies).
# Usage: curl -fsSL <release-url>/install-mobile-connect.sh | bash -s -- [installer options]
set -euo pipefail

# Release packaging replaces these defaults with the published version.
DEFAULT_VERSION='v0.1.0'
DEFAULT_RELEASE_BASE_URL='https://github.com/VenTheZone/freebuff-gate/releases/download/v0.1.0'

VERSION="${FB_MOBILE_CONNECT_VERSION:-$DEFAULT_VERSION}"
RELEASE_BASE_URL="${FB_MOBILE_CONNECT_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"
FORWARD_ARGS=()
RUN_CHECKS=1
ASSUME_YES=0
NO_PROMPT=0

usage() {
  cat <<'EOF'
Freebuff Gate one-command installer

Installs the Freebuff Desktop mobile-connect companion and checks that the
host is ready for the Freebuff Gate stack (Desktop install present, Node 22+,
curl, and SHA-256 tooling). The script offers to install
missing dependencies.

Usage:
  curl -fsSL <release-url>/install-mobile-connect.sh | bash -s -- [options]

Bootstrap options:
  --version <v>             Release tag, for example v0.1.0
  --release-base-url <url>  HTTPS base URL containing versioned assets
  --check                   Check Freebuff Desktop + dependencies only, then exit
  --skip-checks             Skip Desktop discovery and dependency checks
  -y, --assume-yes          Install missing dependencies without prompting
  --no-prompt               Fail on missing dependencies instead of prompting
  --help                    Show this help

All other options are passed to the Node installer, including:
  --relay-http-url <url> --relay-ws-url <url> --enrollment-token <token>
  --upstream-url <url> --connector-id <id> --auto-start --no-auto-start
  --dry-run --force

The bootstrap requires Node 22 or newer, curl, and SHA-256 support. It
verifies release checksums before running downloaded code.
EOF
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$1" >&2
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    fail "$1 needs a value"
  fi
}

while (($# > 0)); do
  case "$1" in
    --version)
      require_value "$1" "${2-}"
      VERSION="$2"
      shift 2
      ;;
    --release-base-url)
      require_value "$1" "${2-}"
      RELEASE_BASE_URL="$2"
      shift 2
      ;;
    --check)
      RUN_CHECKS=1
      CHECK_ONLY=1
      shift
      ;;
    --skip-checks)
      RUN_CHECKS=0
      shift
      ;;
    -y|--assume-yes)
      ASSUME_YES=1
      shift
      ;;
    --no-prompt)
      NO_PROMPT=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      FORWARD_ARGS+=("$1")
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Freebuff Desktop install discovery
# ---------------------------------------------------------------------------

DESKTOP_CANDIDATES=(
  "${FREEBUFF_DESKTOP_DIR:-}"
  "${XDG_DATA_HOME:-$HOME/.local/share}/freebuff-desktop"
  "$HOME/.local/share/freebuff-desktop"
  "$HOME/AppData/Local/Programs/freebuff-desktop"
  "$HOME/AppData/Local/freebuff-desktop"
  "${LOCALAPPDATA:-}/Programs/freebuff-desktop"
  "${LOCALAPPDATA:-}/freebuff-desktop"
  "/Applications/Freebuff Desktop.app/Contents/Resources"
  "/usr/local/share/freebuff-desktop"
  "/opt/freebuff-desktop"
)

# Markers that identify a real Freebuff Desktop install, strongest first.
desktop_markers() {
  printf '%s\n' \
    'squashfs-root/resources/orchestrator/orchestrator.js' \
    'resources/orchestrator/orchestrator.js' \
    'orchestrator.js'
}

# Print the first candidate directory that looks like a Freebuff Desktop
# install, or exit non-zero when none is found.
find_freebuff_desktop() {
  local candidate marker
  for candidate in "${DESKTOP_CANDIDATES[@]}"; do
    [[ -n "$candidate" && -d "$candidate" ]] || continue
    while IFS= read -r marker; do
      if [[ -f "$candidate/$marker" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    done < <(desktop_markers)
  done
  return 1
}

# ---------------------------------------------------------------------------
# Host dependency checks
# ---------------------------------------------------------------------------

node_version() {
  if ! command -v node >/dev/null 2>&1; then
    printf 'missing'
    return 1
  fi
  node -p 'process.versions.node' 2>/dev/null || printf 'unknown'
}

node_major() {
  local v
  v="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  printf '%s' "$v"
}

check_curl() {
  command -v curl >/dev/null 2>&1
}

check_sha() {
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1
}

check_node() {
  command -v node >/dev/null 2>&1 && (( $(node_major) >= 22 ))
}

# Print a short human summary of Gate readiness. Returns 0 when ready.
check_gate_ready() {
  local ready=0
  if [[ -n "${DESKTOP_DIR:-}" ]]; then
    printf 'Freebuff Desktop: found at %s\n' "$DESKTOP_DIR"
  else
    printf 'Freebuff Desktop: NOT FOUND (checked %s locations)\n' "${#DESKTOP_CANDIDATES[@]}"
    ready=1
  fi
  if check_curl; then
    printf 'curl: found\n'
  else
    printf 'curl: missing\n'
    ready=1
  fi
  if check_sha; then
    printf 'SHA-256: found\n'
  else
    printf 'SHA-256: missing (need sha256sum or shasum)\n'
    ready=1
  fi
  if check_node; then
    printf 'Node.js: %s (ok, 22+)\n' "$(node_version)"
  elif command -v node >/dev/null 2>&1; then
    printf 'Node.js: %s (too old, need 22+)\n' "$(node_version)"
    ready=1
  else
    printf 'Node.js: missing (need 22+)\n'
    ready=1
  fi
  return "$ready"
}

# ---------------------------------------------------------------------------
# Guided dependency installation
# ---------------------------------------------------------------------------

have_prompt() {
  [[ "$NO_PROMPT" -ne 1 ]] && [[ -t 0 ]]
}

ask_install() {
  local name="$1" command="$2"
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    printf 'Installing %s: %s\n' "$name" "$command"
    if ! eval "$command"; then
      fail "could not install $name. Install it manually, then re-run this script"
    fi
    return 0
  fi
  if ! have_prompt; then
    fail "missing dependency: $name. Install it manually (e.g. $command), then re-run this script"
  fi
  printf 'Freebuff Gate needs %s.\n' "$name"
  printf 'Install command: %s\n' "$command"
  printf 'Run it now? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      if ! eval "$command"; then
        fail "could not install $name. Install it manually, then re-run this script"
      fi
      ;;
    *)
      fail "Freebuff Gate needs $name. Install it manually, then re-run this script"
      ;;
  esac
}

pkg_install() {
  # Best-effort package-manager command for the host, preferring sudo-free
  # user-level managers first.
  if command -v brew >/dev/null 2>&1; then
    printf 'brew install %s' "$*"
  elif command -v choco >/dev/null 2>&1; then
    printf 'choco install -y %s' "$*"
  elif command -v apt-get >/dev/null 2>&1; then
    printf 'sudo apt-get install -y %s' "$*"
  elif command -v dnf >/dev/null 2>&1; then
    printf 'sudo dnf install -y %s' "$*"
  elif command -v pacman >/dev/null 2>&1; then
    printf 'sudo pacman -S --noconfirm %s' "$*"
  else
    printf '%s' "$*"
  fi
}

node_install_hint() {
  # Node 22+ is rarely the distro package version; point at official installers.
  if command -v brew >/dev/null 2>&1; then
    printf 'brew install node@22'
  elif command -v choco >/dev/null 2>&1; then
    printf 'choco install -y nodejs-lts'
  else
    printf 'curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz (official Node 22 tarball; see https://nodejs.org)'
  fi
}

install_missing_deps() {
  if ! check_node; then
    ask_install 'Node.js 22+' "$(node_install_hint)"
  fi
  if ! check_curl; then
    ask_install 'curl' "$(pkg_install curl)"
  fi
  if ! check_sha; then
    if command -v apt-get >/dev/null 2>&1; then
      ask_install 'sha256sum (coreutils)' "$(pkg_install coreutils)"
    else
      ask_install 'sha256sum or shasum' 'install coreutils (Linux), or run this script from a Mac terminal (shasum is built in)'
    fi
  fi
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

if [[ "${RUN_CHECKS:-1}" -eq 1 ]]; then
  if DESKTOP_DIR="$(find_freebuff_desktop)"; then
    export DESKTOP_DIR
    printf 'Freebuff Desktop install: %s\n' "$DESKTOP_DIR"
  else
    DESKTOP_DIR=''
    printf 'Freebuff Desktop install: NOT FOUND\n' >&2
    if [[ "${CHECK_ONLY:-0}" -eq 1 ]]; then
      printf 'Install Freebuff Desktop first, then re-run this script.\n' >&2
      exit 1
    fi
    fail 'Freebuff Desktop was not found. Install Freebuff Desktop first, or pass --skip-checks to continue anyway'
  fi

  if [[ "${CHECK_ONLY:-0}" -eq 1 ]]; then
    check_gate_ready
    exit $?
  fi

  if ! check_gate_ready; then
    install_missing_deps
    printf 'Re-checking dependencies after install...\n'
    check_gate_ready || fail 'dependencies still missing after install'
  fi
fi

case "$VERSION" in
  v*) ;;
  *) VERSION="v$VERSION" ;;
esac
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)*$ ]] \
  || fail "release version must look like v1.2.3"

command -v node >/dev/null 2>&1 || fail 'Node 22 or newer is required; node was not found'
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail 'could not determine Node.js version'
(( NODE_MAJOR >= 22 )) || fail "Node 22 or newer is required; found $(node --version)"

command -v curl >/dev/null 2>&1 || fail 'curl is required'
if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM_TOOL='sha256sum'
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM_TOOL='shasum'
else
  fail 'sha256sum or shasum is required'
fi

RELEASE_BASE_URL_VALUE="$RELEASE_BASE_URL" node <<'NODE'
const value = process.env.RELEASE_BASE_URL_VALUE;
let parsed;
try {
  parsed = new URL(value);
} catch {
  console.error('release base URL must be a valid HTTPS URL');
  process.exit(1);
}
if (parsed.protocol !== 'https:') {
  console.error('release base URL must use HTTPS');
  process.exit(1);
}
NODE

RELEASE_BASE_URL="${RELEASE_BASE_URL%/}"
ASSET_PREFIX="freebuff-mobile-connect-${VERSION}"
MANIFEST_ASSET="${ASSET_PREFIX}-manifest.json"
CHECKSUM_ASSET="${ASSET_PREFIX}-SHA256SUMS"
LOGICAL_FILES=(
  'install-mobile-connect.js'
  'mobile-connect-agent.js'
  'mobile-connect-protocol.js'
  'mobile-connect-qr.js'
)

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/freebuff-mobile-connect.XXXXXXXX")"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM
DOWNLOAD_DIR="$TEMP_DIR/download"
SOURCE_DIR="$TEMP_DIR/source"
mkdir -p "$DOWNLOAD_DIR" "$SOURCE_DIR"

download_asset() {
  local asset="$1"
  curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
    "${RELEASE_BASE_URL}/${asset}" --output "${DOWNLOAD_DIR}/${asset}"
}

printf 'Freebuff mobile-connect release %s\n' "$VERSION"
printf 'Validating Node.js: %s\n' "$(node --version)"
printf 'Downloading versioned installer files...\n'
download_asset "$MANIFEST_ASSET"
download_asset "$CHECKSUM_ASSET"

EXPECTED_VERSION="$VERSION" MANIFEST_FILE="$DOWNLOAD_DIR/$MANIFEST_ASSET" ASSET_PREFIX="$ASSET_PREFIX" node <<'NODE'
const fs = require('node:fs');
const expectedVersion = process.env.EXPECTED_VERSION;
const assetPrefix = process.env.ASSET_PREFIX;
const manifestFile = process.env.MANIFEST_FILE;
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
} catch (error) {
  console.error(`release manifest is invalid: ${error.message}`);
  process.exit(1);
}
const expected = [
  'install-mobile-connect.js',
  'mobile-connect-agent.js',
  'mobile-connect-protocol.js',
  'mobile-connect-qr.js',
];
if (manifest.product !== 'freebuff-mobile-connect' || manifest.version !== expectedVersion) {
  console.error('release manifest version or product does not match requested release');
  process.exit(1);
}
if (manifest.requiredNodeMajor !== 22) {
  console.error('release manifest requires unsupported Node major');
  process.exit(1);
}
if (!Array.isArray(manifest.files) || manifest.files.length !== expected.length) {
  console.error('release manifest has unexpected file list');
  process.exit(1);
}
const names = manifest.files.map((file) => file.logicalName).sort();
if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) {
  console.error('release manifest file list is not the expected installer set');
  process.exit(1);
}
for (const file of manifest.files) {
  const expectedAsset = `${assetPrefix}-${file.logicalName}`;
  if (file.assetName !== expectedAsset || !/^freebuff-mobile-connect-v[^/]+-[A-Za-z0-9._-]+\.js$/.test(file.assetName)) {
    console.error(`release manifest contains unexpected asset name: ${file.assetName}`);
    process.exit(1);
  }
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.bytes) || file.bytes < 0) {
    console.error(`release manifest contains invalid metadata for ${file.logicalName}`);
    process.exit(1);
  }
}
NODE

for logical in "${LOGICAL_FILES[@]}"; do
  download_asset "${ASSET_PREFIX}-${logical}"
done

EXPECTED_VERSION="$VERSION" MANIFEST_FILE="$DOWNLOAD_DIR/$MANIFEST_ASSET" DOWNLOAD_DIR="$DOWNLOAD_DIR" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_FILE, 'utf8'));
for (const file of manifest.files) {
  const target = path.join(process.env.DOWNLOAD_DIR, file.assetName);
  const content = fs.readFileSync(target);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (content.length !== file.bytes || digest !== file.sha256) {
    console.error(`manifest checksum mismatch for ${file.logicalName}`);
    process.exit(1);
  }
}
NODE

printf 'Verifying SHA-256 checksums...\n'
if [[ "$CHECKSUM_TOOL" == 'sha256sum' ]]; then
  (cd "$DOWNLOAD_DIR" && sha256sum -c "$CHECKSUM_ASSET")
else
  (cd "$DOWNLOAD_DIR" && shasum -a 256 -c "$CHECKSUM_ASSET")
fi

for logical in "${LOGICAL_FILES[@]}"; do
  cp "$DOWNLOAD_DIR/${ASSET_PREFIX}-${logical}" "$SOURCE_DIR/$logical"
done

printf 'Launching verified installer...\n'
exec node "$SOURCE_DIR/install-mobile-connect.js" install \
  --source-dir "$SOURCE_DIR" \
  --agent-version "$VERSION" \
  "${FORWARD_ARGS[@]}"
