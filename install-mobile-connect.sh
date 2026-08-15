#!/usr/bin/env bash
# One-command installer for the Freebuff Desktop mobile-connect companion.
# Usage: curl -fsSL <release-url>/install-mobile-connect.sh | bash -s -- [installer options]
set -euo pipefail

# Release packaging replaces these defaults with the published version.
DEFAULT_VERSION='v0.1.0'
DEFAULT_RELEASE_BASE_URL='https://github.com/VenTheZone/FB-Browser-UI/releases/download/v0.1.0'

VERSION="${FB_MOBILE_CONNECT_VERSION:-$DEFAULT_VERSION}"
RELEASE_BASE_URL="${FB_MOBILE_CONNECT_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"
FORWARD_ARGS=()

usage() {
  cat <<'EOF'
Freebuff Desktop mobile-connect one-command installer

Usage:
  curl -fsSL <release-url>/install-mobile-connect.sh | bash -s -- [options]

Bootstrap options:
  --version <v>             Release tag, for example v0.1.0
  --release-base-url <url>  HTTPS base URL containing versioned assets
  --help                    Show this help

All other options are passed to the Node installer, including:
  --relay-http-url <url> --relay-ws-url <url> --enrollment-token <token>
  --upstream-url <url> --connector-id <id> --auto-start --no-auto-start
  --dry-run --force

The bootstrap requires Node 22 or newer, curl, and SHA-256 support. It verifies
release checksums before executing downloaded installer code.
EOF
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
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
