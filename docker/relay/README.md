# Self-hosted mobile relay

The default deployment uses Caddy for public HTTPS/WSS and automatic Let's
Encrypt certificates. Tailscale is optional and keeps relay access inside a
private tailnet.

## Caddy deployment (default)

Requirements:

- Docker Engine with Compose v2.
- Public DNS `A`/`AAAA` record for relay host.
- Inbound ports `80` and `443` available for ACME HTTP-01 and app traffic.
- Strong enrollment and admin secrets.

## Published image

CI publishes the relay image to GHCR for `linux/amd64` and `linux/arm64`:

```sh
docker pull ghcr.io/venthezone/freebuff-gate-relay:latest
```

Tag convention:

- `latest` for stable releases (`v0.2.0` and later)
- `next` for prereleases
- `vX.Y.Z` for the exact release

`docker-compose.yml` and `docker-compose.tailscale.yml` pull the published
image when it is available locally, otherwise they build from source. Prefer
the published image unless you are testing local relay changes.

Create configuration:

```sh
cp .env.example .env
$EDITOR .env
```

Set at least:

```dotenv
RELAY_DOMAIN=relay.example.com
RELAY_ENROLLMENT_TOKEN=<random-secret>
RELAY_ADMIN_TOKEN=<random-secret>
```

Start relay and Caddy:

```sh
docker compose up -d --build
docker compose ps
curl -fsS https://relay.example.com/healthz
```

For local smoke tests on a host where ports 80/443 are occupied, set
`CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` to free host ports. ACME HTTP-01
requires host port 80, so use a temporary internal-TLS Caddyfile for that
isolated test rather than production certificate issuance.

Caddy serves HTTPS, redirects HTTP, renews certificates, and forwards HTTP,
SSE, and WebSocket traffic to the relay on the private Docker network. Caddy
state is stored in `caddy-data`; relay pairing and connector state is stored in
`relay-state`. Back up these volumes before moving hosts.

Inspect logs:

```sh
docker compose logs -f relay caddy
```

Stop or update:

```sh
docker compose down
docker compose pull caddy
docker compose up -d --build
```

Do not publish relay port `8795`; Compose exposes it only to Caddy. Keep
`RELAY_ENROLLMENT_TOKEN`, `RELAY_ADMIN_TOKEN`, APNs keys, and `.env` private.

## Backup and restore

`backup.sh` backs up `relay-state`, `caddy-data`, and `caddy-config`. Each
archive contains metadata and has a `.sha256` sidecar. Metadata records:

- format version
- Compose project name
- logical volume key
- deployed Freebuff version
- UTC creation timestamp

Archives contain pairing state and certificate private keys. Encrypt them and
restrict permissions before storing them off-host.

Run from `docker/relay/`:

```sh
chmod +x backup.sh
FREEBUFF_VERSION=v0.2.0 ./backup.sh backup
```

The script stops services for a consistent snapshot and restarts them on
success or failure. Override `BACKUP_DIR`, `COMPOSE_PROJECT_NAME`, or `STAMP`
when needed. `STAMP` defaults to UTC `YYYYMMDDTHHMMSSZ`.

Run restore dry-run before every restore. It changes no data and does not stop
services. It lists archive contents and verifies archive checksum, metadata
format, source project, volume key, Freebuff version, creation timestamp,
current Compose volume labels, and unsafe archive paths:

```sh
STAMP=20260818T120000Z \
FREEBUFF_VERSION=v0.2.0 \
./backup.sh dry-run
```

Restore requires an existing Compose project and **replaces current volume
contents**. `restore` runs the same dry-run checks before stopping services:

```sh
STAMP=20260818T120000Z \
FREEBUFF_VERSION=v0.2.0 \
./backup.sh restore
```

Older archives created before metadata and checksum support fail dry-run;
create fresh archives before restoring them. Never run restore against a live
stack by bypassing `backup.sh` checks.

## Tailscale fallback

Use private tailnet exposure when every phone and operator already uses
Tailscale and public inbound ports are undesirable:

```sh
cp .env.example .env
$EDITOR .env
docker compose -f docker-compose.tailscale.yml up -d --build
```

Fill `TS_AUTHKEY`, `TS_HOSTNAME`, `RELAY_HTTP_URL`, and `RELAY_WS_URL`. The
Tailscale sidecar uses userspace networking and `tailscale serve` for TLS. Keep
`tailscale-state` persistent. Phones need tailnet reachability to use this
variant.

This variant is optional. Use Caddy for general self-hosting and for mobile
clients that cannot join the operator's tailnet.

## Relay URL wiring

Use the public URL from the selected deployment when installing the desktop
agent:

```sh
freebuff-mobile-connect install \
  --relay-http-url https://relay.example.com \
  --enrollment-token '<relay-bootstrap-token>'
```

For the Tailscale variant, replace the URL with its `https://<host>.ts.net`
address. The corresponding WebSocket URL is derived as `wss://...` when the
installer does not receive one explicitly.
