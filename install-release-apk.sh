#!/usr/bin/env bash
# One-command installer for the Freebuff Gate mobile app: downloads the
# latest release APK, verifies its SHA-256 checksum, uninstalls any previously
# installed build (each debug build is signed with a per-machine key, so
# Android refuses in-place updates), and installs the new APK with runtime
# permissions granted.
set -euo pipefail

DEFAULT_REPO='VenTheZone/freebuff-gate'
DEFAULT_TAG='mobile-debug-latest'
DEFAULT_ASSET='freebuff-gate-debug.apk'
GECKO_TAG='mobile-gecko-latest'
GECKO_ASSET='freebuff-gate-gecko-debug.apk'
PACKAGE='com.freebuff.mobile'

TAG="$DEFAULT_TAG"
ASSET="$DEFAULT_ASSET"
LOCAL_APK=''
SKIP_CHECKSUM=0
SERIAL=''

usage() {
  cat <<'EOF'
Freebuff Gate mobile app installer

Downloads the latest release APK, verifies its checksum, uninstalls the
previously installed Freebuff Gate (required because each debug build is
signed with a different key, so Android will not update in place), and
installs the new APK with all runtime permissions granted.

Usage:
  install-release-apk.sh [options]

Options:
  --gecko               Install the GeckoView (Firefox engine) spike APK
  --apk <file>          Install a local APK file instead of downloading
  --skip-checksum       Skip SHA-256 verification (use only with --apk)
  --serial <serial>     adb serial of the target device (ANDROID_SERIAL also works)
  --help                Show this help

Requires the gh CLI (authenticated and with access to the private repo),
adb, and sha256sum.
EOF
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

adb_cmd() {
  if [[ -n "$SERIAL" ]]; then
    adb -s "$SERIAL" "$@"
  else
    adb "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gecko) TAG="$GECKO_TAG"; ASSET="$GECKO_ASSET"; shift ;;
    --apk) LOCAL_APK="${2:?--apk requires a file path}"; shift 2 ;;
    --skip-checksum) SKIP_CHECKSUM=1; shift ;;
    --serial) SERIAL="${2:?--serial requires a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

if [[ -z "$LOCAL_APK" && "$SKIP_CHECKSUM" -eq 1 ]]; then
  fail '--skip-checksum is only valid with --apk'
fi

command -v adb >/dev/null 2>&1 || fail 'adb not found on PATH. Install Android platform-tools first.'
if [[ -z "$LOCAL_APK" ]]; then
  command -v gh >/dev/null 2>&1 || fail 'gh not found on PATH. Install the GitHub CLI and run gh auth login.'
fi
if [[ "$SKIP_CHECKSUM" -eq 0 ]]; then
  command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum not found on PATH.'
fi

# Resolve the repo from the current git remote when available; otherwise fall
# back to the default Freebuff Gate repo.
REPO="$DEFAULT_REPO"
if git remote get-url origin >/dev/null 2>&1; then
  url="$(git remote get-url origin)"
  case "$url" in
    git@github.com:*) REPO="${url#git@github.com:}" ;;
    https://github.com/*) REPO="${url#https://github.com/}" ;;
  esac
  REPO="${REPO%.git}"
fi

# Pick the APK: a local file, or the release asset plus its checksum.
if [[ -n "$LOCAL_APK" ]]; then
  APK="$LOCAL_APK"
  [[ -s "$APK" ]] || fail "APK file not found or empty: $APK"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  printf 'Downloading %s from %s ...\n' "$ASSET" "$TAG"
  gh release download "$TAG" --repo "$REPO" --pattern "${ASSET}*" \
    --dir "$TMP_DIR" --clobber \
    || fail 'Release download failed. Check gh auth and repo access.'
  APK="$TMP_DIR/$ASSET"
  [[ -s "$APK" ]] || fail "Downloaded APK is missing or empty: $APK"
  if [[ "$SKIP_CHECKSUM" -eq 0 ]]; then
    ( cd "$TMP_DIR" && sha256sum -c "$ASSET.sha256" ) \
      || fail 'Checksum verification failed. Do not install this APK; the download may be corrupted or tampered with.'
    printf 'Checksum OK.\n'
  fi
fi

# Resolve the target device.
if [[ -z "$SERIAL" ]]; then
  devices="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
  count="$(printf '%s\n' "$devices" | grep -c . || true)"
  if [[ "$count" -eq 0 ]]; then
    fail 'No adb device connected. Plug in the phone with USB debugging on, or start an emulator.'
  fi
  if [[ "$count" -gt 1 ]]; then
    fail "Multiple adb devices connected ($(printf '%s ' $devices | sed 's/ $//')). Pass --serial to pick one."
  fi
fi

printf 'Uninstalling previous Freebuff Gate (wipes app data) ...\n'
adb_cmd uninstall "$PACKAGE" >/dev/null 2>&1 || true

printf 'Installing %s ...\n' "$APK"
adb_cmd install -g "$APK" || fail 'Install failed.'

printf 'Done. Freebuff Gate is installed with runtime permissions granted.\n'
