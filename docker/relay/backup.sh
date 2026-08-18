#!/bin/sh
# Backup and restore relay-state plus Caddy state volumes.
# Run from docker/relay or set COMPOSE_PROJECT_NAME for a custom project.

set -eu

VOLUMES="relay-state caddy-data caddy-config"
DOCKER_BIN="${DOCKER_BIN:-docker}"

usage() {
  cat >&2 <<'EOF'
Usage:
  backup.sh backup
  backup.sh dry-run
  backup.sh restore
  backup.sh metadata <project> <volume> <version> <created-at>
  backup.sh validate-archive <archive> <project> <volume> <version> <created-at>

Environment:
  FREEBUFF_VERSION       deployed release version, for example v0.2.0
  STAMP                  backup timestamp for dry-run/restore; backup generates one
  BACKUP_DIR             archive directory (default: ./backups)
  COMPOSE_PROJECT_NAME   Compose project name (default: freebuff-relay)
  DOCKER_BIN             Docker executable (default: docker)
EOF
  exit 2
}

fail() {
  echo "backup: $*" >&2
  exit 1
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail 'sha256sum or shasum is required'
  fi
}

write_metadata() {
  project=$1
  volume=$2
  version=$3
  created_at=$4
  printf 'format=freebuff-relay-backup-v1\nproject=%s\nvolume=%s\nversion=%s\ncreated_at=%s\n' \
    "$project" "$volume" "$version" "$created_at"
}

metadata_value() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p"
}

validate_metadata() {
  metadata=$1
  expected_project=$2
  expected_volume=$3
  expected_version=$4
  expected_created_at=$5

  [ "$(metadata_value "$metadata" format)" = 'freebuff-relay-backup-v1' ] || \
    fail 'unsupported or missing backup metadata format'
  [ "$(metadata_value "$metadata" project)" = "$expected_project" ] || \
    fail "archive project does not match $expected_project"
  [ "$(metadata_value "$metadata" volume)" = "$expected_volume" ] || \
    fail "archive volume does not match $expected_volume"
  [ "$(metadata_value "$metadata" version)" = "$expected_version" ] || \
    fail "archive version does not match $expected_version"
  [ "$(metadata_value "$metadata" created_at)" = "$expected_created_at" ] || \
    fail "archive creation timestamp does not match $expected_created_at"
}

validate_archive() {
  archive=$1
  expected_project=$2
  expected_volume=$3
  expected_version=$4
  expected_created_at=$5
  checksum_file="$archive.sha256"

  [ -s "$archive" ] || fail "archive missing or empty: $archive"
  metadata=$(tar -xOf "$archive" freebuff-backup-metadata 2>/dev/null || \
    tar -xOf "$archive" ./freebuff-backup-metadata 2>/dev/null) || \
    fail "archive has no backup metadata: $archive"
  validate_metadata "$metadata" "$expected_project" "$expected_volume" "$expected_version" "$expected_created_at"

  [ -s "$checksum_file" ] || fail "checksum sidecar missing: $checksum_file"
  archive_name=$(basename "$archive")
  expected_hash=$(awk -v file="$archive_name" '$2 == file { print $1; exit }' "$checksum_file")
  [ -n "$expected_hash" ] || fail "checksum sidecar has no entry for $archive_name"
  actual_hash=$(hash_file "$archive")
  [ "$actual_hash" = "$expected_hash" ] || \
    fail "archive checksum mismatch: $archive"
}

check_compose_volumes() {
  compose_volumes=$("$DOCKER_BIN" compose config --volumes) || fail 'could not read Compose volumes'
  for volume_name in $VOLUMES; do
    printf '%s\n' "$compose_volumes" | grep -Fxq "$volume_name" || \
      fail "Compose file has no expected volume: $volume_name"

    volume="${PROJECT}_${volume_name}"
    "$DOCKER_BIN" volume inspect "$volume" >/dev/null || \
      fail "Compose volume missing: $volume"
    volume_project=$("$DOCKER_BIN" volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$volume")
    volume_key=$("$DOCKER_BIN" volume inspect --format '{{ index .Labels "com.docker.compose.volume" }}' "$volume")
    [ "$volume_project" = "$PROJECT" ] || \
      fail "volume $volume belongs to project $volume_project, not $PROJECT"
    [ "$volume_key" = "$volume_name" ] || \
      fail "volume $volume has Compose key $volume_key, expected $volume_name"
  done
}

prepare_paths() {
  BACKUP_DIR="${BACKUP_DIR:-./backups}"
  test -d "$BACKUP_DIR" || mkdir -p "$BACKUP_DIR"
  BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd)
  PROJECT="${COMPOSE_PROJECT_NAME:-freebuff-relay}"
}

backup_volumes() {
  VERSION="${FREEBUFF_VERSION:?set FREEBUFF_VERSION, e.g. v0.2.0}"
  STAMP="${STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
  prepare_paths
  check_compose_volumes

  "$DOCKER_BIN" compose stop
  trap '"$DOCKER_BIN" compose start >/dev/null 2>&1 || true' EXIT
  for volume_name in $VOLUMES; do
    volume="${PROJECT}_${volume_name}"
    archive="${STAMP}-${volume_name}.tgz"
    "$DOCKER_BIN" run --rm \
      --mount "type=volume,src=$volume,dst=/data,readonly" \
      --mount "type=bind,src=$BACKUP_DIR,dst=/backup" \
      alpine:3.20 sh -c '
        printf "format=freebuff-relay-backup-v1\\nproject=%s\\nvolume=%s\\nversion=%s\\ncreated_at=%s\\n" \
          "$2" "$3" "$4" "$5" > /tmp/freebuff-backup-metadata
        tar -czf "/backup/$1" -C /data . -C /tmp freebuff-backup-metadata
      ' backup "$archive" "$PROJECT" "$volume_name" "$VERSION" "$STAMP"
    checksum=$(hash_file "$BACKUP_DIR/$archive")
    printf '%s  %s\n' "$checksum" "$archive" > "$BACKUP_DIR/$archive.sha256"
    chmod 600 "$BACKUP_DIR/$archive" "$BACKUP_DIR/$archive.sha256"
  done
  trap - EXIT
  "$DOCKER_BIN" compose start
  printf 'Backup written under %s (stamp %s)\n' "$BACKUP_DIR" "$STAMP"
}

dry_run() {
  VERSION="${FREEBUFF_VERSION:?set FREEBUFF_VERSION, e.g. v0.2.0}"
  STAMP="${STAMP:?set STAMP to backup timestamp, e.g. 20260818T120000Z}"
  prepare_paths
  check_compose_volumes

  for volume_name in $VOLUMES; do
    archive="$BACKUP_DIR/${STAMP}-${volume_name}.tgz"
    validate_archive "$archive" "$PROJECT" "$volume_name" "$VERSION" "$STAMP"
    echo "== $(basename "$archive") ($volume_name) =="
    entries=$(tar -tzf "$archive")
    printf '%s\n' "$entries"
    if printf '%s\n' "$entries" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
      fail "unsafe absolute or parent path in $archive"
    fi
  done
  echo "Dry run passed: $PROJECT volumes, version $VERSION, and $STAMP archives are compatible."
}

restore_volumes() {
  dry_run
  "$DOCKER_BIN" compose stop
  trap '"$DOCKER_BIN" compose start >/dev/null 2>&1 || true' EXIT
  for volume_name in $VOLUMES; do
    volume="${PROJECT}_${volume_name}"
    archive="${STAMP}-${volume_name}.tgz"
    "$DOCKER_BIN" run --rm \
      --mount "type=volume,src=$volume,dst=/data" \
      --mount "type=bind,src=$BACKUP_DIR,dst=/backup,readonly" \
      alpine:3.20 sh -c \
      'find /data -mindepth 1 -delete && tar -xzf "/backup/$1" -C /data && rm -f /data/freebuff-backup-metadata' restore "$archive"
  done
  trap - EXIT
  "$DOCKER_BIN" compose start
  printf 'Restored backup %s\n' "$STAMP"
}

command_name=${1:-}
case "$command_name" in
  metadata)
    [ "$#" -eq 5 ] || usage
    write_metadata "$2" "$3" "$4" "$5"
    ;;
  validate-archive)
    [ "$#" -eq 6 ] || usage
    validate_archive "$2" "$3" "$4" "$5" "$6"
    echo "Archive valid: $2"
    ;;
  backup)
    [ "$#" -eq 1 ] || usage
    backup_volumes
    ;;
  dry-run)
    [ "$#" -eq 1 ] || usage
    dry_run
    ;;
  restore)
    [ "$#" -eq 1 ] || usage
    restore_volumes
    ;;
  *)
    usage
    ;;
esac
