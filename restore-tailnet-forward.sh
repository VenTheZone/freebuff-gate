#!/usr/bin/env bash
# Re-apply the Tailscale serve forwarding for the Freebuff Gate stack after a
# backend restart. Every port is derived from the live system — no hardcoded
# values. Idempotent: safe to run repeatedly and safe as a restart hook.
#
# Exposes the loopback tailnet proxy (58061) on the tailnet at the
# orchestrator's port number (58060), so a remote desktop browser keeps using
# :<orchestrator-port> but gets the shim + mobile layer from the proxy.
set -euo pipefail

TAILSCALE="${TAILSCALE:-$(command -v tailscale)}"
SS="${SS:-$(command -v ss)}"

unit_env_value() { # unit key -> first value for KEY= in the unit Environment
  systemctl --user show "$1" -p Environment --value 2>/dev/null \
    | tr ' ' '\n' \
    | sed -n "s/^$2=//p" \
    | head -1
}

listen_port() { # pid -> first 127.0.0.1 listen port of that process
  local pid="$1"
  [[ -n "$pid" && "$pid" != "0" ]] || return 1
  "$SS" -tlnp 2>/dev/null \
    | grep "pid=${pid}," \
    | sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' \
    | head -1
}

main() {
  local orch_port proxy_pid proxy_port

  # Orchestrator port: the desktop unit's PORT env, not a literal.
  orch_port="$(unit_env_value freebuff-desktop.service PORT)"
  [[ -n "$orch_port" ]] || { echo "error: could not derive the orchestrator port" >&2; exit 1; }

  # Proxy port: whatever 127.0.0.1 port the proxy actually bound.
  proxy_pid="$(systemctl --user show freebuff-tailnet-proxy.service -p MainPID --value 2>/dev/null || true)"
  proxy_port="$(listen_port "${proxy_pid:-0}")"
  [[ -n "$proxy_port" ]] || { echo "error: could not derive the tailnet proxy port (is it running?)" >&2; exit 1; }

  echo "tailnet serve: tcp/${orch_port} -> 127.0.0.1:${proxy_port}"
  if ! "$TAILSCALE" serve --bg --tcp="${orch_port}" "tcp://127.0.0.1:${proxy_port}" 2>"${TMPDIR:-/tmp}/fb-serve.$$.err"; then
    if grep -q 'Access denied' "${TMPDIR:-/tmp}/fb-serve.$$.err" 2>/dev/null; then
      echo "tailscaled denied the serve write (needs root or an operator)." >&2
      echo "Run ONCE to enable non-root automation, then re-run this script:" >&2
      echo "  sudo tailscale set --operator=\$(id -un)" >&2
    fi
    rm -f "${TMPDIR:-/tmp}/fb-serve.$$.err"
    exit 1
  fi
  rm -f "${TMPDIR:-/tmp}/fb-serve.$$.err"
}

main "$@"
