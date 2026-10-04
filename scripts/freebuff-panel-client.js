let csrf;
let currentState;
let pairingUrl;
let actionRunning = false;
let refreshRunning = false;
const $ = (id) => document.getElementById(id);

function notice(message, error = false) {
  const box = $("notice");
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function time(value) {
  if (!value) return "Nunca";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Desconhecido"
    : date.toLocaleString("pt-BR");
}
function availability(device, state) {
  if (device.status === "revoked")
    return { label: "Revogada", kind: "revoked" };
  if (device.status === "expired")
    return { label: "Expirada", kind: "expired" };
  if (device.status !== "paired")
    return { label: device.status || "Desconhecida", kind: "offline" };
  return state?.accessReady && device.connectorOnline === true
    ? { label: "Caminho pronto", kind: "ready" }
    : { label: "Indisponível · possível 503", kind: "offline" };
}
function route() {
  const hash = decodeURIComponent(location.hash || "#/");
  if (hash === "#/new") return { page: "new" };
  if (hash.startsWith("#/connections/"))
    return { page: "detail", id: hash.slice("#/connections/".length) };
  return { page: "list" };
}
function showRoute() {
  const target = route();
  for (const page of ["list", "detail", "new"])
    $(`${page}-page`).hidden = page !== target.page;
  if (target.page === "detail") renderDetail();
  document.title = `${target.page === "new" ? "Nova conexão" : target.page === "detail" ? "Detalhes" : "Conexões"} · Freebuff Remoto`;
}
function navigate() {
  $("notice").hidden = true;
  showRoute();
}
function renderList() {
  const state = currentState;
  const good = !!state.accessReady;
  $("summary").className = `summary ${good ? "ok" : "bad"}`;
  $("summary-dot").className = `dot ${good ? "ok" : "bad"}`;
  $("summary-title").textContent = good
    ? "Serviços prontos"
    : "Acesso remoto indisponível";
  $("summary-text").textContent = good
    ? "Freebuff, relay e conector responderam. APK ainda precisa confirmar acesso."
    : state.problem || "Verifique detalhes de conexão.";
  $("checked-at").textContent = `Última verificação: ${time(state.checkedAt)}`;
  const active = state.devices.filter((device) => device.status === "paired");
  const devices = active.sort(
    (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0),
  );
  $("device-count").textContent = String(active.length);
  const list = $("devices");
  list.replaceChildren();
  if (state.devicesError) {
    const error = document.createElement("p");
    error.className = "empty";
    error.textContent = state.devicesError;
    list.append(error);
    return;
  }
  if (!devices.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "Nenhum celular cadastrado. Use “Nova conexão” para criar primeiro QR.";
    list.append(empty);
    return;
  }
  for (const device of devices) {
    const status = availability(device, state);
    const card = document.createElement("a");
    card.className = "device";
    card.href = `#/connections/${encodeURIComponent(device.id)}`;
    const info = document.createElement("span");
    info.className = "device-info";
    const name = document.createElement("strong");
    name.className = "device-name";
    name.textContent = device.name || "Celular sem nome";
    const meta = document.createElement("span");
    meta.className = "device-meta";
    meta.textContent = `Último acesso: ${time(device.lastSeenAt)}`;
    info.append(name, meta);
    const side = document.createElement("span");
    side.className = "device-side";
    const badge = document.createElement("span");
    badge.className = `status ${status.kind}`;
    badge.textContent = status.label;
    const arrow = document.createElement("span");
    arrow.className = "chevron";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    side.append(badge, arrow);
    card.append(info, side);
    list.append(card);
  }
}
function renderDetail() {
  const id = route().id;
  if (!id || !currentState) return;
  const device = currentState.devices.find((item) => item.id === id);
  if (!device) {
    $("detail-name").textContent = "Conexão não encontrada";
    $("detail-id").textContent = id;
    $("detail-alert").hidden = false;
    $("detail-alert").textContent = "Atualize lista ou crie nova conexão.";
    $("reconnect").disabled =
      $("repair").disabled =
      $("revoke").disabled =
        true;
    return;
  }
  const state = currentState;
  const status = availability(device, state);
  $("detail-name").textContent = device.name || "Celular sem nome";
  $("detail-id").textContent = `ID: ${device.id}`;
  $("detail-status").className = `status ${status.kind}`;
  $("detail-status").textContent = status.label;
  $("detail-paired").textContent = time(device.createdAt);
  $("detail-seen").textContent = time(device.lastSeenAt);
  $("detail-credential").textContent =
    device.status === "paired" ? "Pareada" : status.label;
  $("detail-connector").textContent = device.connectorOnline
    ? "Online"
    : "Offline";
  $("detail-alert").hidden = status.kind === "ready";
  $("detail-alert").className = "summary bad";
  $("detail-alert").textContent =
    device.status === "paired"
      ? state.problem || "Conexão indisponível. APK pode retornar HTTP 503."
      : "Credencial sem acesso. Crie novo pareamento.";
  $("reconnect").disabled = $("repair").disabled =
    device.status !== "paired" || actionRunning;
  $("revoke").disabled = device.status !== "paired" || actionRunning;
  const checks = [
    ["Tailscale Serve", state.tailscale],
    ["Endereço remoto", state.remoteRelay],
    ["Docker e relay", state.docker && state.relay],
    ["Conector Desktop", state.connectorCount > 0],
    ["API Freebuff", state.desktopApi],
    ["Ponte após atualização", state.installation?.bridgePresent],
  ];
  $("checks").replaceChildren();
  for (const [name, good] of checks) {
    const row = document.createElement("div");
    row.className = `check ${good ? "ok" : "bad"}`;
    const title = document.createElement("strong");
    title.textContent = name;
    const result = document.createElement("span");
    result.textContent = good ? "OK" : "Indisponível";
    row.append(title, result);
    $("checks").append(row);
  }
  $("installation").textContent =
    `Freebuff ${state.installation?.version || "não identificado"} · atualização: ${time(state.installation?.updatedAt)}`;
  $("watchdog").textContent = state.watchdog
    ? `Monitor: ${state.watchdog.detail || "ativo"} · ${time(state.watchdog.checkedAt)}`
    : "Monitor sem verificação recente";
}
async function refresh() {
  if (actionRunning || refreshRunning) return;
  refreshRunning = true;
  $("poll-indicator").textContent = "Verificando...";
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    currentState = await response.json();
    renderList();
    showRoute();
    $("poll-indicator").textContent = time(currentState.checkedAt);
  } catch (error) {
    $("poll-indicator").textContent = "Falha na verificação";
    $("summary").className = "summary bad";
    $("summary-title").textContent = "Painel sem resposta";
    $("summary-text").textContent = "Execute freebuff-painel.bat novamente.";
    notice(
      `Estado indisponível: ${error.message}. Execute freebuff-painel.bat novamente.`,
      true,
    );
  } finally {
    refreshRunning = false;
  }
}
async function post(route, body = {}) {
  const response = await fetch(route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-freebuff-panel-token": csrf,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function run(button, path, label) {
  if (actionRunning) return;
  actionRunning = true;
  button.disabled = true;
  const old = button.textContent;
  button.textContent = "Executando...";
  try {
    const result = await post(path);
    notice(`${label} concluída. ${result.output || ""}`.trim());
  } catch (error) {
    notice(`${label} falhou: ${error.message}`, true);
  } finally {
    button.textContent = old;
    actionRunning = false;
    await refresh();
  }
}
function drawQr(rows) {
  const canvas = $("qr"),
    scale = 6,
    border = 4;
  canvas.width = canvas.height = (rows.length + border * 2) * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === "1")
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
  });
}
async function pair() {
  if (actionRunning) return;
  actionRunning = true;
  $("pair").disabled = true;
  try {
    const result = await post("/api/pair");
    pairingUrl = result.pairingUrl;
    drawQr(result.rows);
    $("expires").textContent =
      `Expira: ${time(result.expiresAt)}. QR de uso único.`;
    $("pairing").hidden = false;
    notice("QR criado. Leia pelo APK Freebuff Gate.");
  } catch (error) {
    notice(`Falha ao criar QR: ${error.message}`, true);
  } finally {
    $("pair").disabled = false;
    actionRunning = false;
  }
}
async function revoke() {
  if (actionRunning) return;
  const device = currentState?.devices.find((item) => item.id === route().id);
  if (
    !device ||
    !window.confirm(
      `Revogar acesso de "${device.name || device.id}"? Celular precisará de novo pareamento.`,
    )
  )
    return;
  actionRunning = true;
  try {
    await post("/api/revoke", { deviceId: device.id, confirm: "REVOGAR" });
    notice("Acesso revogado.");
  } catch (error) {
    notice(`Revogação falhou: ${error.message}`, true);
  } finally {
    actionRunning = false;
    await refresh();
  }
}
async function init() {
  window.addEventListener("hashchange", navigate);
  $("refresh").addEventListener("click", refresh);
  $("reconnect").addEventListener("click", () =>
    run($("reconnect"), "/api/reconnect", "Reconexão"),
  );
  $("repair").addEventListener("click", () =>
    run($("repair"), "/api/repair", "Reparo"),
  );
  $("revoke").addEventListener("click", revoke);
  $("pair").addEventListener("click", pair);
  $("copy-url").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pairingUrl);
      notice("Link copiado.");
    } catch {
      notice("Não foi possível copiar link.", true);
    }
  });
  showRoute();
  const response = await fetch("/api/bootstrap", { cache: "no-store" });
  if (!response.ok) throw new Error("Painel indisponível");
  csrf = (await response.json()).csrf;
  await refresh();
  setInterval(refresh, 15000);
}
init().catch((error) =>
  notice(
    `Painel indisponível: ${error.message}. Execute freebuff-painel.bat novamente.`,
    true,
  ),
);
