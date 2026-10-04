#!/usr/bin/env node
// Local-only control panel for the Freebuff Gate installation on this PC.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { QrCode, MEDIUM_ECC } = require("../src/mobile-connect-qr");

const runFile = promisify(execFile);
const root = path.resolve(__dirname, "..");
const relayEnv = path.join(root, "docker", "relay", ".env");
const localFreebuff = path.join(process.env.LOCALAPPDATA || "", "Freebuff");
const wrapper = path.join(
  localFreebuff,
  "mobile-connect",
  "freebuff-mobile-connect.js",
);
const gateTokenFile = path.join(
  process.env.USERPROFILE || "",
  ".config",
  "freebuff",
  "gate-proxy.token",
);
const watchdogFile = path.join(localFreebuff, "gate-watchdog-status.json");
const eventsFile = path.join(localFreebuff, "gate-panel-events.json");
const desktopDir =
  process.env.FREEBUFF_DESKTOP_DIR ||
  path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "@codebufffreebuff-desktop",
  );
const desktopExe = path.join(desktopDir, "Freebuff.exe");
const orchestrator = path.join(
  desktopDir,
  "resources",
  "orchestrator",
  "orchestrator.js",
);
const tailscale = fs.existsSync("C:\\Program Files\\Tailscale\\tailscale.exe")
  ? "C:\\Program Files\\Tailscale\\tailscale.exe"
  : "tailscale.exe";
const powershell =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const csrf = crypto.randomBytes(32).toString("hex");
let origin;
let busy = false;
let lastStateKey;
let installCache;

function readJson(filename, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function events() {
  const saved = readJson(eventsFile, []);
  return Array.isArray(saved) ? saved.slice(-25) : [];
}

function recordEvent(kind, message) {
  const saved = events();
  saved.push({ at: new Date().toISOString(), kind, message });
  fs.mkdirSync(localFreebuff, { recursive: true });
  fs.writeFileSync(eventsFile, JSON.stringify(saved.slice(-25)), {
    mode: 0o600,
  });
}

function envValue(name) {
  const line = fs
    .readFileSync(relayEnv, "utf8")
    .split(/\r?\n/)
    .find((item) => item.startsWith(`${name}=`));
  if (!line || !line.slice(name.length + 1))
    throw new Error(`${name} is not configured`);
  return line.slice(name.length + 1).trim();
}

function headers(type) {
  return {
    "content-type": type,
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, headers("application/json; charset=utf-8"));
  res.end(JSON.stringify(data));
}

function sendFile(res, filename, type) {
  res.writeHead(200, headers(type));
  res.end(fs.readFileSync(path.join(__dirname, filename)));
}

async function relayFetch(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:8795${route}`, {
    ...options,
    headers: {
      authorization: `Bearer ${envValue("RELAY_ADMIN_TOKEN")}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Relay HTTP ${response.status}`);
  return response.json();
}

async function command(exe, args, timeout = 8000) {
  const result = await runFile(exe, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  });
  return (result.stdout || "").trim();
}

async function dockerRelayHealth() {
  const compose = path.join(
    root,
    "docker",
    "relay",
    "docker-compose.host-tailnet.yml",
  );
  const id = await command("docker.exe", [
    "compose",
    "--env-file",
    relayEnv,
    "-f",
    compose,
    "ps",
    "-q",
    "relay",
  ]);
  return id
    ? command("docker.exe", ["inspect", "-f", "{{.State.Health.Status}}", id])
    : "";
}

async function installation() {
  try {
    const exeStat = fs.statSync(desktopExe);
    const bridgeStat = fs.statSync(orchestrator);
    const key = `${exeStat.mtimeMs}:${bridgeStat.mtimeMs}`;
    if (installCache?.key === key) return installCache.value;
    const escaped = desktopExe.replace(/'/g, "''");
    const version = await command(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
    ]);
    const bridgePresent = fs
      .readFileSync(orchestrator, "utf8")
      .includes("/* freebuff-gate-windows-launch-bridge */");
    const value = {
      version,
      bridgePresent,
      updatedAt: exeStat.mtime.toISOString(),
    };
    installCache = { key, value };
    return value;
  } catch {
    return { version: null, bridgePresent: false, updatedAt: null };
  }
}

async function state() {
  const checks = await Promise.allSettled([
    relayFetch("/healthz"),
    relayFetch("/v1/devices"),
    (async () => {
      const token = fs.readFileSync(gateTokenFile, "utf8").trim();
      const response = await fetch("http://127.0.0.1:58061/api/projects", {
        headers: { "x-fb-gate": token },
        signal: AbortSignal.timeout(5000),
      });
      return response.status === 200;
    })(),
    command(tailscale, ["serve", "status"]),
    dockerRelayHealth(),
    (async () => {
      const response = await fetch(
        `${envValue("RELAY_HTTP_URL").replace(/\/$/, "")}/healthz`,
        {
          signal: AbortSignal.timeout(5000),
        },
      );
      return response.ok && (await response.json()).ok === true;
    })(),
    installation(),
  ]);
  const value = (index, fallback) =>
    checks[index].status === "fulfilled" ? checks[index].value : fallback;
  const health = value(0, null);
  const listing = value(1, null);
  const serve = value(3, "");
  const watchdog = readJson(watchdogFile, null);
  const watchdogFresh =
    watchdog?.checkedAt && Date.now() - Date.parse(watchdog.checkedAt) < 90000;
  const devices = listing?.devices || [];
  const result = {
    relay: health?.ok === true,
    connectorCount: Number(health?.connectors || 0),
    lastConnectorChangeAt: health?.lastConnectorChangeAt || null,
    connectorDisconnects: Number(health?.connectorDisconnects || 0),
    desktopApi: value(2, false),
    tailscale:
      /tailnet only/.test(serve) &&
      /proxy http:\/\/127\.0\.0\.1:8795/.test(serve),
    remoteRelay: value(5, false),
    docker: value(4, "") === "healthy",
    devices,
    devicesError: listing
      ? null
      : "Lista indisponivel. Confira relay e token administrativo.",
    watchdog: watchdogFresh ? watchdog : null,
    installation: value(6, {
      version: null,
      bridgePresent: false,
      updatedAt: null,
    }),
    checkedAt: new Date().toISOString(),
  };
  result.accessReady =
    result.docker &&
    result.relay &&
    result.tailscale &&
    result.remoteRelay &&
    result.desktopApi &&
    devices.some(
      (device) => device.status === "paired" && device.connectorOnline === true,
    );
  result.problem = result.accessReady
    ? null
    : !result.docker
      ? "Docker relay indisponivel."
      : !result.relay
        ? "Relay local indisponivel."
        : !result.tailscale
          ? "Tailscale Serve nao esta configurado."
          : !result.remoteRelay
            ? "Endereco da tailnet nao responde."
            : !result.desktopApi
              ? "API local do Freebuff nao responde."
              : !result.connectorCount
                ? "Conector Desktop offline. App pode retornar HTTP 503."
                : devices.some(
                      (device) =>
                        device.status === "paired" && !device.connectorOnline,
                    )
                  ? "Aparelho pareado com conector offline. App pode retornar HTTP 503."
                  : !devices.some((device) => device.status === "paired")
                    ? "Nenhum aparelho com acesso valido."
                    : null;
  const stateKey = `${result.accessReady}:${result.problem || "ok"}`;
  if (stateKey !== lastStateKey) {
    lastStateKey = stateKey;
    recordEvent(
      result.accessReady ? "ok" : "error",
      result.accessReady ? "Acesso remoto pronto." : result.problem,
    );
  }
  result.events = events();
  return result;
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sameToken(candidate) {
  if (typeof candidate !== "string" || candidate.length !== csrf.length)
    return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(csrf));
}

async function action(script, timeout) {
  const output = await command(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, script),
    ],
    timeout,
  );
  return { ok: true, output: output.slice(-4000) };
}

async function handle(req, res) {
  if (
    req.headers.host !== new URL(origin).host ||
    !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
  ) {
    sendJson(res, 403, { error: "Local access only" });
    return;
  }
  const url = new URL(req.url || "/", origin);
  if (req.method === "GET" && url.pathname === "/")
    return sendFile(res, "freebuff-panel.html", "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/panel.css")
    return sendFile(res, "freebuff-panel.css", "text/css; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/panel.js")
    return sendFile(
      res,
      "freebuff-panel-client.js",
      "text/javascript; charset=utf-8",
    );
  if (req.method === "GET" && url.pathname === "/brand.png") {
    res.writeHead(200, headers("image/png"));
    res.end(
      fs.readFileSync(path.join(root, "assets", "freebuff-gate-icon.png")),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204, headers("text/plain"));
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/bootstrap")
    return sendJson(res, 200, { csrf });
  if (req.method === "GET" && url.pathname === "/api/health")
    return sendJson(res, 200, { ok: true, service: "freebuff-panel" });
  if (req.method === "GET" && url.pathname === "/api/state")
    return sendJson(res, 200, await state());

  if (
    req.method !== "POST" ||
    req.headers.origin !== origin ||
    !sameToken(req.headers["x-freebuff-panel-token"])
  ) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  if (busy) {
    sendJson(res, 409, { error: "Outra operacao em andamento" });
    return;
  }

  if (url.pathname === "/api/reconnect" || url.pathname === "/api/repair") {
    busy = true;
    try {
      const result =
        url.pathname === "/api/repair"
          ? await action("repair-freebuff-gate.ps1", 150000)
          : await action("reconnect-freebuff-gate.ps1", 60000);
      recordEvent(
        "action",
        url.pathname === "/api/repair"
          ? "Reparo concluido."
          : "Reconexao manual concluida.",
      );
      sendJson(res, 200, result);
    } catch (error) {
      recordEvent(
        "error",
        url.pathname === "/api/repair"
          ? "Reparo falhou."
          : "Reconexao manual falhou.",
      );
      throw error;
    } finally {
      busy = false;
    }
    return;
  }
  if (url.pathname === "/api/pair") {
    const output = await command(
      process.execPath,
      [wrapper, "pair", "--json"],
      20000,
    );
    const pairing = JSON.parse(output);
    if (
      !pairing.pairingUrl?.includes("#pairingId=") ||
      !pairing.pairingUrl.includes("&token=")
    )
      throw new Error("Pairing response invalid");
    const qr = QrCode.encodeText(pairing.pairingUrl, MEDIUM_ECC);
    const rows = Array.from({ length: qr.size }, (_, y) =>
      Array.from({ length: qr.size }, (_, x) =>
        qr.getModule(x, y) ? "1" : "0",
      ).join(""),
    );
    sendJson(res, 200, {
      rows,
      pairingUrl: pairing.pairingUrl,
      expiresAt: pairing.expiresAt,
    });
    return;
  }
  if (url.pathname === "/api/revoke") {
    const body = await bodyJson(req);
    if (
      body.confirm !== "REVOGAR" ||
      typeof body.deviceId !== "string" ||
      !/^d_[A-Za-z0-9_-]{1,100}$/.test(body.deviceId)
    ) {
      sendJson(res, 400, { error: "Confirmacao invalida" });
      return;
    }
    const result = await relayFetch(
      `/v1/devices/${encodeURIComponent(body.deviceId)}/revoke`,
      { method: "POST" },
    );
    sendJson(res, 200, result);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent)
      sendJson(res, 500, { error: error.message || "Operation failed" });
  });
});
const port =
  process.env.FREEBUFF_PANEL_PORT === undefined
    ? 8796
    : Number(process.env.FREEBUFF_PANEL_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid FREEBUFF_PANEL_PORT");
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Painel local: ${origin}`);
});
