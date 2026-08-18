# Freebuff mobile-connect relay — Node 22 Alpine, stdlib-only runtime.
FROM node:22-alpine

# Run as the image's unprivileged user; state lives on mounted volumes.
USER node
WORKDIR /app

# Pre-create the relay's state dir owned by `node` so a fresh named volume
# (which is populated copy-on-first-use from the image, preserving ownership)
# is writable by the unprivileged user.
RUN mkdir -p /home/node/.config/freebuff && chown node:node /home/node/.config/freebuff

# The relay and its four sibling modules use only Node builtins — no npm
# install step, no lockfile needed. Tests and dev tooling stay out of the
# image. mobile-connect-qr is required transitively by the gateway (pairing
# QR rendering).
COPY --chown=node:node src/mobile-connect-relay.js \
                    src/mobile-connect-gateway.js \
                    src/mobile-connect-protocol.js \
                    src/mobile-connect-websocket.js \
                    src/mobile-connect-qr.js \
                    src/mobile-push-apns.js \
                    ./src/

# Healthz probe: busybox wget ships with Alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8795/healthz > /dev/null || exit 1

EXPOSE 8795

# All configuration is environment-driven (parseArgs reads FB_MOBILE_RELAY_*).
CMD ["node", "src/mobile-connect-relay.js"]
