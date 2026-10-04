# Windows host with Docker relay and Tailscale

This setup keeps relay private to your tailnet. Freebuff Desktop and Gate
connector run in your Windows user session; Docker runs relay. Phone must
also be connected to same tailnet. No public domain or port forwarding.

## Requirements

Windows 10/11, Freebuff Desktop, Node.js 22+, Docker Desktop with Compose v2,
Tailscale on PC and phone, and a checkout of this repository. Run commands
below in PowerShell from repository root. Install Android app from verified
release described in [install guide](../install.md#1-install-the-gate-app-on-the-phone).

## 1. Configure private relay

~~~powershell
Copy-Item docker/relay/.env.example docker/relay/.env
notepad docker/relay/.env
~~~

Set RELAY_ENROLLMENT_TOKEN and RELAY_ADMIN_TOKEN to **different** random
secrets. Generate each with:

~~~powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
~~~

Set RELAY_HTTP_URL to https://YOUR-PC.YOUR-TAILNET.ts.net and
RELAY_WS_URL to wss://YOUR-PC.YOUR-TAILNET.ts.net. Find exact name with
tailscale status. Replace placeholders. Keep docker/relay/.env private;
never put tokens in a PR, screenshot, or support log.

~~~powershell
docker compose --env-file docker/relay/.env -f docker/relay/docker-compose.host-tailnet.yml up -d --build
docker compose --env-file docker/relay/.env -f docker/relay/docker-compose.host-tailnet.yml ps
tailscale serve --bg --https=443 http://127.0.0.1:8795
tailscale serve status
~~~

Compose publishes port 8795 only on 127.0.0.1. Tailscale Serve supplies
private HTTPS/WSS. If HTTPS port 443 already serves another app, use an
unused Tailscale Serve port and include it in both relay URLs.

## 2. Install Desktop connector

Load enrollment secret into current PowerShell process without adding it to
command history:

~~~powershell
$settings = @{}
Get-Content docker/relay/.env | ForEach-Object {
    if ($_ -match '^([A-Z_]+)=(.*)$') { $settings[$matches[1]] = $matches[2] }
}
$env:FB_MOBILE_RELAY_ENROLLMENT_TOKEN = $settings.RELAY_ENROLLMENT_TOKEN
try {
    node src/install-mobile-connect.js install --no-auto-start `
      --relay-http-url $settings.RELAY_HTTP_URL `
      --relay-ws-url $settings.RELAY_WS_URL
} finally {
    Remove-Item Env:FB_MOBILE_RELAY_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue
}
~~~

Installer provisions connector, proxy, and Desktop UI integration. Install
Windows launch bridge and login watchdog:

~~~powershell
.\repair-freebuff-gate.cmd
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-freebuff-gate-watchdog.ps1
~~~

Repair backs up original orchestrator and validates patched file before
restarting Desktop. Watchdog starts missing proxy/connector after user login
when Desktop is open, then checks relay registration every 30 seconds.
Docker Desktop, Tailscale, and Freebuff Desktop must also start after login.

For a non-default Desktop install, set FREEBUFF_DESKTOP_DIR to directory
containing Freebuff.exe before repair or opening panel.

## 3. Pair phone and manage connections

Double-click freebuff-painel.bat. Panel opens at http://127.0.0.1:8796/
on this PC only. Choose **New connection**, then scan one-use QR in Gate app
with **Pair device → Scan QR**. Normal reconnects use existing phone
credential; no new QR is needed.

Panel lists active paired phones. Open card for connector status, diagnostics,
and actions. **Reconnect** restarts proxy and connector without revoking
phone. **Repair after update** checks Desktop bridge and may restart Desktop.
**Revoke** removes that phone's access after confirmation.

Panel reports whether relay, tailnet route, Desktop API, and connector
respond. **Path ready is not a live test inside phone app.** If app still
shows HTTP 503 after recovery, fully close and reopen it.

## Updates and checks

After a Freebuff Desktop update, run repair-freebuff-gate.cmd again. No need
to run it for every Docker restart. Relay/device data remain in Docker
relay-state volume; do not delete that volume during updates.

~~~powershell
docker compose --env-file docker/relay/.env -f docker/relay/docker-compose.host-tailnet.yml ps
tailscale serve status
Invoke-RestMethod http://127.0.0.1:8795/healthz
Invoke-RestMethod http://127.0.0.1:8796/api/health
Get-Content (Join-Path $env:LOCALAPPDATA 'Freebuff/gate-watchdog-status.json')
~~~

Panel uses loopback binding, Host/Origin checks, per-process CSRF token,
and no-store responses. Administrative relay token stays in ignored
docker/relay/.env. Anyone controlling your signed-in Windows session can
use pairing and revoke controls.

If relay is healthy but connectors=0, open Freebuff Desktop and use
**Reconnect** in panel. If Desktop bridge is missing after update, run
repair. See [installation troubleshooting](../install.md#troubleshooting).
