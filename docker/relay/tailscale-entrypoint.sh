#!/bin/sh
# Tailscale sidecar entrypoint: run tailscaled in userspace-networking mode,
# bring the node up, derive the tailnet HTTPS name, and configure
# `tailscale serve` to terminate TLS for the relay container. Runs inside the
# tailscale/tailscale image (entrypoint overridden, so tailscaled is started
# here).

set -eu

SOCKET=/tmp/tailscaled.sock
STATE_DIR="${TS_STATE_DIR:-/var/lib/tailscale}"

# Userspace networking: no TUN device or NET_ADMIN needed; `tailscale serve`
# proxies from the tailnet inside the daemon to http://relay:8795.
tailscaled --socket="$SOCKET" --state="$STATE_DIR/tailscaled.state" \
  --tun=userspace-networking &
TS_PID=$!
trap 'kill "$TS_PID" 2>/dev/null || true' EXIT

i=0
while ! tailscale --socket="$SOCKET" status > /dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 30 ] && { echo "tailscale: daemon did not start" >&2; exit 1; }
  sleep 0.5
done

tailscale --socket="$SOCKET" up \
  --authkey="${TS_AUTHKEY:?TS_AUTHKEY is required}" \
  --hostname="${TS_HOSTNAME:-freebuff-relay}" \
  ${TS_EXTRA_UP_FLAGS:-}

# Wait for the tailnet identity to resolve (serve needs the DNS name).
name=""
i=0
while [ -z "$name" ] && [ "$i" -lt 30 ]; do
  name=$(tailscale --socket="$SOCKET" status --json 2>/dev/null \
    | grep -o '"DNSName":"[^"]*\.ts\.net\.' | head -n1 | sed 's/"DNSName":"//; s/\.$//')
  [ -z "$name" ] && sleep 2
  i=$((i + 1))
done
[ -n "$name" ] || { echo "tailscale: could not resolve tailnet DNS name" >&2; exit 1; }

# Override with an explicit name when the operator pinned one.
if [ -n "${TS_HTTPS_HOSTNAME:-}" ]; then
  name="$TS_HTTPS_HOSTNAME"
fi

# Serve the relay container's plain-HTTP port as https://<name>.ts.net/.
cat > /tmp/serve.json <<EOF
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${name}:443": {
      "Handlers": { "/": { "Proxy": "http://relay:8795" } }
    }
  }
}
EOF

tailscale --socket="$SOCKET" serve --bg --set-raw "$(cat /tmp/serve.json)"
echo "tailscale serve ready: https://${name}/ -> http://relay:8795"

# Keep the container alive; tailscaled + serve run as part of this process.
wait "$TS_PID"
