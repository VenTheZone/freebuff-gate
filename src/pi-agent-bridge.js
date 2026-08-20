'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_SESSIONS = 6;
const MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PI_IDLE_TIMEOUT_MS = 0;
const PI_IDLE_TIMEOUT_ENV = 'FB_PI_IDLE_TIMEOUT_MS';

function defaultPiPaths(home = os.homedir()) {
  const root = path.join(home, '.local', 'share', 'pi-node', 'current');
  return {
    node: process.env.FB_PI_NODE || path.join(root, 'bin', 'node'),
    cli: process.env.FB_PI_CLI || path.join(
      root,
      'lib',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    ),
  };
}

function sessionRoot(agentDir) {
  return path.join(agentDir, 'sessions');
}

const builtinAuthProviderCache = new Map();

async function builtinAuthProviders(cliPath) {
  const key = String(cliPath || '');
  if (builtinAuthProviderCache.has(key)) return builtinAuthProviderCache.get(key);
  const promise = (async () => {
    try {
      const packagePath = path.join(path.dirname(key), '..', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js');
      const module = await import(pathToFileURL(packagePath).href);
      return module.builtinProviders().map((provider) => ({
        id: provider.id,
        name: provider.name || provider.id,
        authTypes: [provider.auth && provider.auth.apiKey ? 'api_key' : null, provider.auth && provider.auth.oauth ? 'oauth' : null].filter(Boolean),
      }));
    } catch (error) {
      return [];
    }
  })();
  builtinAuthProviderCache.set(key, promise);
  return promise;
}

function safeProjectPath(value, allowedRoot = process.env.FB_PI_ALLOWED_ROOT || os.homedir()) {
  const requested = String(value || '').trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw new Error('pi_project_required');
  }
  const resolved = path.resolve(requested);
  const root = path.resolve(allowedRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('pi_project_forbidden');
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? 'pi_project_missing' : 'pi_project_unavailable');
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('pi_project_forbidden');
  if (!fs.statSync(real).isDirectory()) throw new Error('pi_project_not_directory');
  return real;
}

function textFromMessage(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function parseSessionSummary(file) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return null;
  } catch (error) {
    return null;
  }
  const size = stat.size;
  let raw;
  try {
    const fd = fs.openSync(file, 'r');
    const firstSize = Math.min(size, 16 * 1024);
    const first = Buffer.alloc(firstSize);
    fs.readSync(fd, first, 0, firstSize, 0);
    const tailSize = Math.min(size, 128 * 1024);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, Math.max(0, size - tailSize));
    fs.closeSync(fd);
    raw = size <= 128 * 1024
      ? first.toString('utf8')
      : first.toString('utf8') + '\n' + tail.toString('utf8');
  } catch (error) {
    return null;
  }
  let header = null;
  let title = '';
  let name = '';
  let messageCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (error) { continue; }
    if (!header && entry.type === 'session') header = entry;
    if (entry.type === 'session_name' && entry.name) name = String(entry.name);
    if (entry.type === 'message') {
      messageCount += 1;
      if (entry.message && entry.message.role === 'user') {
        const text = textFromMessage(entry.message).replace(/\s+/g, ' ').trim();
        if (text) title = text.slice(0, 120);
      }
    }
  }
  if (!header || !header.id || !header.cwd) return null;
  return {
    id: String(header.id),
    cwd: String(header.cwd),
    name: name || null,
    title: title || name || 'Untitled Pi session',
    updatedAt: stat.mtimeMs,
    timestamp: header.timestamp || null,
    messageCount,
    file,
  };
}

function walkJsonl(root, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (error) { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function listPiSessions(cwd, options = {}) {
  const agentDir = options.agentDir || path.join(os.homedir(), '.pi', 'agent');
  const requested = safeProjectPath(cwd || os.homedir(), options.allowedRoot);
  return walkJsonl(sessionRoot(agentDir))
    .map(parseSessionSummary)
    .filter((session) => session && session.cwd === requested)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100);
}

function readJsonBody(req, limit = MAX_PROMPT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) {
        reject(new Error('pi_request_too_large'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(new Error('pi_invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function configuredCredentialProviders(agentDir) {
  const providers = new Set();
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
    Object.keys(auth || {}).forEach((provider) => {
      if (auth[provider]) providers.add(provider);
    });
  } catch (error) {}
  try {
    const free = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'free.json'), 'utf8'));
    Object.keys(free || {}).forEach((key) => {
      if (/_api_key$/.test(key) && free[key]) providers.add(key.replace(/_api_key$/, ''));
    });
  } catch (error) {}
  for (const key of Object.keys(process.env)) {
    if (/_API_KEY$/.test(key) && process.env[key]) providers.add(key.replace(/_API_KEY$/, '').toLowerCase().replace(/_/g, '-'));
  }
  return providers;
}

function createPiAgentController(options = {}) {
  const agentDir = options.agentDir || process.env.FB_PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const allowedRoot = options.allowedRoot || process.env.FB_PI_ALLOWED_ROOT || os.homedir();
  const paths = defaultPiPaths();
  const nodePath = options.nodePath || paths.node;
  const cliPath = options.cliPath || paths.cli;
  const spawnCommand = options.spawnCommand || spawn;
  const authSpawn = options.authSpawn || spawn;
  const configuredIdleTimeout = options.idleTimeoutMs ?? Number(process.env[PI_IDLE_TIMEOUT_ENV]);
  const idleTimeoutMs = Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout >= 0
    ? configuredIdleTimeout
    : DEFAULT_PI_IDLE_TIMEOUT_MS;
  const sessions = new Map();
  const authCache = new Map();
  let requestNumber = 0;

  function fail(code, detail) {
    const error = new Error(code);
    error.code = code;
    if (detail) error.detail = String(detail);
    return error;
  }

  function sessionSnapshot(session) {
    return {
      id: session.id,
      cwd: session.cwd,
      name: session.name || null,
      state: session.state,
      model: session.model || null,
      thinkingLevel: session.thinkingLevel || null,
      sessionFile: session.file || null,
    };
  }

  function broadcast(session, value) {
    const line = JSON.stringify(value).slice(0, MAX_EVENT_BYTES);
    for (const listener of session.listeners) {
      try { listener(line); } catch (error) { session.listeners.delete(listener); }
    }
  }

  function removeSession(session) {
    if (sessions.get(session.id) === session) sessions.delete(session.id);
  }

  function clearIdleTimer(session) {
    if (session && session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  function closeLiveSession(session, reason = null, signal = 'SIGKILL') {
    if (!session || session.closed) return;
    clearIdleTimer(session);
    session.closed = true;
    session.state = 'closed';
    session.error = reason;
    for (const pending of session.pending.values()) pending.reject(fail('pi_process_closed'));
    session.pending.clear();
    if (reason) {
      broadcast(session, {
        type: 'pi_session_state',
        state: 'closed',
        error: reason,
        session: sessionSnapshot(session),
      });
      session.listeners.clear();
    }
    try { session.child.kill(signal); } catch (error) {}
    removeSession(session);
  }

  function scheduleIdleClose(session) {
    clearIdleTimer(session);
    if (idleTimeoutMs === 0 || session.closed || session.state !== 'idle') return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (!session.closed && session.state === 'idle') {
        closeLiveSession(session, 'pi_idle_timeout', 'SIGTERM');
      }
    }, idleTimeoutMs);
    session.idleTimer.unref();
  }

  function markRunning(session) {
    clearIdleTimer(session);
    if (!session.closed) session.state = 'running';
  }

  function markIdle(session) {
    if (session.closed) return;
    session.state = 'idle';
    scheduleIdleClose(session);
  }

  function closeOtherSessions() {
    for (const session of [...sessions.values()]) closeLiveSession(session);
  }

  function finish(session, state, error) {
    if (session.closed) return;
    clearIdleTimer(session);
    session.closed = true;
    session.state = state;
    session.error = error || null;
    for (const pending of session.pending.values()) pending.reject(fail('pi_process_closed'));
    session.pending.clear();
    broadcast(session, {
      type: 'pi_session_state',
      state,
      error: error || null,
      session: sessionSnapshot(session),
    });
    if (session.listeners.size === 0) removeSession(session);
  }

  function handleLine(session, line) {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch (error) { return; }
    if (value && value.type === 'response' && value.data && value.command === 'get_state') {
      session.model = value.data.model || session.model;
      session.thinkingLevel = value.data.thinkingLevel || session.thinkingLevel;
      session.name = value.data.sessionName || session.name;
      session.file = value.data.sessionFile || session.file;
      if (value.data.sessionId && session.id.startsWith('opening-')) {
        const oldId = session.id;
        session.id = value.data.sessionId;
        sessions.delete(oldId);
        sessions.set(session.id, session);
      }
    }
    if (value && value.id && session.pending.has(value.id)) {
      const pending = session.pending.get(value.id);
      session.pending.delete(value.id);
      if (value.type === 'response' && value.success === false) {
        pending.reject(fail('pi_rpc_failed', value.error || value.data && value.data.error));
      } else pending.resolve(value);
      return;
    }
    if (
      value.type === 'agent_start' ||
      value.type === 'turn_start' ||
      value.type === 'tool_execution_start' ||
      value.type === 'message_update'
    ) markRunning(session);
    if (value.type === 'agent_settled' || value.type === 'agent_end') markIdle(session);
    broadcast(session, value);
  }

  function rpc(session, command, timeout = DEFAULT_TIMEOUT_MS) {
    if (!session || session.closed || !session.child.stdin || session.child.stdin.destroyed) {
      return Promise.reject(fail('pi_session_closed'));
    }
    const id = `fb-pi-${++requestNumber}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(fail('pi_rpc_timeout'));
      }, timeout);
      session.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        session.child.stdin.write(JSON.stringify({ id, ...command }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(fail('pi_write_failed'));
      }
    });
  }

  async function open(input = {}) {
    const cwd = safeProjectPath(input.cwd || allowedRoot, allowedRoot);
    const requested = input.sessionId ? String(input.sessionId) : '';
    const active = requested ? sessions.get(requested) : null;
    if (active && !active.closed) return sessionSnapshot(active);
    if (active) removeSession(active);
    closeOtherSessions();
    let summary = null;
    if (requested) summary = listPiSessions(cwd, { agentDir, allowedRoot }).find((item) => item.id === requested);
    if (requested && !summary) throw fail('pi_session_not_found');
    if (sessions.size >= MAX_SESSIONS) throw fail('pi_too_many_sessions');
    if (!fs.existsSync(nodePath) || !fs.existsSync(cliPath)) throw fail('pi_cli_missing');
    const openingId = `opening-${crypto.randomUUID()}`;
    // RPC mode never shows Pi's interactive project-trust prompt. Approve
    // project resources explicitly so .pi/.agents skills, project settings,
    // and package-provided skills are loaded instead of silently ignored.
    const args = [cliPath, '--mode', 'rpc', '--approve'];
    if (summary) args.push('--session', summary.file);
    let child;
    try {
      child = spawnCommand(nodePath, args, {
        cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (error) {
      throw fail(error && error.code === 'ENOENT' ? 'pi_cli_missing' : 'pi_spawn_failed');
    }
    const session = {
      id: summary ? summary.id : openingId,
      cwd,
      file: summary ? summary.file : null,
      child,
      state: 'starting',
      name: summary ? summary.name : null,
      model: null,
      thinkingLevel: null,
      error: null,
      closed: false,
      listeners: new Set(),
      pending: new Map(),
      idleTimer: null,
    };
    sessions.set(session.id, session);
    let stdout = '';
    const consume = (chunk) => {
      stdout += String(chunk || '');
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';
      for (const line of lines) handleLine(session, line);
    };
    if (child.stdout) child.stdout.on('data', consume);
    if (child.stderr) child.stderr.on('data', () => {});
    child.once('error', (error) => finish(session, 'failed', error && error.code === 'ENOENT' ? 'pi_cli_missing' : 'pi_process_error'));
    child.once('close', (code) => finish(session, code === 0 ? 'closed' : 'failed', code === 0 ? null : 'pi_process_error'));
    try {
      await rpc(session, { type: 'get_state' });
    } catch (error) {
      try { child.kill('SIGKILL'); } catch (ignored) {}
      removeSession(session);
      throw error;
    }
    markIdle(session);
    return sessionSnapshot(session);
  }

  function find(id) {
    const session = sessions.get(String(id || ''));
    if (!session || session.closed) throw fail('pi_session_closed');
    return session;
  }

  function resolveProject(cwd) {
    return safeProjectPath(cwd || allowedRoot, allowedRoot);
  }

  async function list(cwd) {
    const project = resolveProject(cwd || allowedRoot);
    const items = listPiSessions(project, { agentDir, allowedRoot });
    for (const item of items) {
      const active = sessions.get(item.id);
      if (active) Object.assign(item, sessionSnapshot(active));
    }
    return items;
  }

  function sessionSummary(cwd, id) {
    const project = safeProjectPath(cwd, allowedRoot);
    const item = listPiSessions(project, { agentDir, allowedRoot }).find((entry) => entry.id === String(id || ''));
    if (!item) throw fail('pi_session_not_found');
    const root = path.resolve(sessionRoot(agentDir));
    const file = path.resolve(item.file);
    if (file !== root && !file.startsWith(root + path.sep)) throw fail('pi_session_file_invalid');
    return { project, item, file };
  }

  async function renameSession(id, cwd, name) {
    const value = String(name ?? '').trim();
    if (value.length > 120) throw fail('pi_session_name_invalid');
    const summary = sessionSummary(cwd, id);
    let session = sessions.get(String(id));
    if (session && session.cwd !== summary.project) throw fail('pi_session_not_found');
    if (!session) {
      await open({ cwd: summary.project, sessionId: summary.item.id });
      session = find(id);
    }
    await rpc(session, { type: 'set_session_name', name: value });
    session.name = value || null;
    return { ok: true, name: session.name, session: sessionSnapshot(session) };
  }

  async function deleteSession(id, cwd) {
    const summary = sessionSummary(cwd, id);
    const active = sessions.get(String(id));
    if (active && active.state === 'running') throw fail('pi_session_busy');
    if (active) {
      removeSession(active);
      try { active.child.kill('SIGKILL'); } catch (error) {}
    }
    try {
      fs.unlinkSync(summary.file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('pi_session_delete_failed');
    }
    return { ok: true, id: String(id) };
  }

  async function sendPrompt(id, message, cwd) {
    const text = String(message || '').trim();
    if (!text || Buffer.byteLength(text) > MAX_PROMPT_BYTES) throw fail('pi_prompt_invalid');
    let session;
    try {
      session = find(id);
    } catch (error) {
      if (error.code !== 'pi_session_closed' || !cwd) throw error;
      await open({ cwd, sessionId: id });
      session = find(id);
    }
    const command = { type: 'prompt', message: text };
    if (session.state === 'running') command.streamingBehavior = 'followUp';
    markRunning(session);
    await rpc(session, command, 30_000);
    return sessionSnapshot(session);
  }

  async function messages(id) {
    const value = await rpc(find(id), { type: 'get_messages' });
    return value.data || { messages: [] };
  }

  function checkProviderAuth(provider) {
    const key = String(provider || '');
    const cached = authCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const configured = configuredCredentialProviders(agentDir);
    const promise = new Promise((resolve) => {
      if (!fs.existsSync(nodePath) || !fs.existsSync(cliPath)) {
        resolve(configured.has(key));
        return;
      }
      let child;
      try {
        child = authSpawn(nodePath, [cliPath, 'auth', 'check', '--provider', key, '--json', '--no-refresh'], {
          cwd: process.cwd(),
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, NO_COLOR: '1' },
        });
      } catch (error) {
        resolve(configured.has(key));
        return;
      }
      let output = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (error) {}
        resolve(false);
      }, 5_000);
      timer.unref();
      if (child.stdout) child.stdout.on('data', (chunk) => { output = (output + String(chunk || '')).slice(-16 * 1024); });
      child.once('error', () => { clearTimeout(timer); resolve(configured.has(key)); });
      child.once('close', () => {
        clearTimeout(timer);
        try {
          const status = JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
          if (status.status === 'ready') resolve(true);
          else if (status.reason === 'provider_not_found') resolve(configured.has(key));
          else resolve(false);
        } catch (error) {
          resolve(configured.has(key));
        }
      });
    });
    authCache.set(key, { promise, expiresAt: Date.now() + 15_000 });
    return promise;
  }

  async function setApiKey(provider, key) {
    const id = String(provider || '').trim();
    const value = String(key || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw fail('pi_provider_invalid');
    const builtin = (await builtinAuthProviders(cliPath)).find((entry) => entry.id === id);
    if (builtin && !builtin.authTypes.includes('api_key')) throw fail('pi_provider_oauth_only');
    if (!value || value.length > 4096 || /[\r\n]/.test(value)) throw fail('pi_api_key_invalid');
    const authPath = path.join(agentDir, 'auth.json');
    let auth = {};
    try {
      if (fs.existsSync(authPath)) auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('invalid auth');
    } catch (error) {
      throw fail('pi_auth_unavailable');
    }
    auth[id] = { type: 'api_key', key: value };
    fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
    const temp = `${authPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, authPath);
      try { fs.chmodSync(authPath, 0o600); } catch {}
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw fail('pi_auth_write_failed');
    }
    authCache.delete(id);
    return { ok: true, provider: id };
  }

  async function models(id) {
    const value = await rpc(find(id), { type: 'get_available_models' }, 30_000);
    const all = value.data && Array.isArray(value.data.models) ? value.data.models : [];
    const modelProviders = [...new Set(all.map((model) => model && model.provider).filter(Boolean))];
    const authProviders = (await builtinAuthProviders(cliPath)).map((provider) => ({ ...provider, authTypes: provider.authTypes.slice() }));
    const knownAuthProviders = new Set(authProviders.map((provider) => provider.id));
    modelProviders.forEach((provider) => {
      if (!knownAuthProviders.has(provider)) authProviders.push({ id: provider, name: provider, authTypes: ['api_key'] });
    });
    // Surface providers the user has configured a key for (env *_API_KEY,
    // ~/.pi/free.json, or agent auth.json) even before the Pi CLI reports
    // models for them, so they appear in the UI to authenticate/select.
    configuredCredentialProviders(agentDir).forEach((provider) => {
      if (!knownAuthProviders.has(provider)) {
        authProviders.push({ id: provider, name: provider, authTypes: ['api_key'] });
        knownAuthProviders.add(provider);
      }
    });
    const providers = Array.from(new Set(modelProviders.concat(authProviders.map((provider) => provider.id))));
    const ready = new Set();
    await Promise.all(modelProviders.map(async (provider) => {
      if (await checkProviderAuth(provider)) ready.add(provider);
    }));
    return {
      models: all.filter((model) => model && ready.has(model.provider)),
      providers,
      authProviders,
      authenticatedProviders: [...ready],
      filtered: true,
    };
  }

  async function setModel(id, provider, modelId) {
    if (!provider || !modelId) throw fail('pi_model_invalid');
    const value = await rpc(find(id), { type: 'set_model', provider: String(provider), modelId: String(modelId) });
    return value.data || {};
  }

  async function setThinking(id, level) {
    const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (!allowed.has(String(level))) throw fail('pi_thinking_invalid');
    const value = await rpc(find(id), { type: 'set_thinking_level', level: String(level) });
    return value.data || {};
  }

  async function compact(id, instructions) {
    const value = await rpc(find(id), {
      type: 'compact',
      customInstructions: String(instructions || '').trim() || undefined,
    }, 60_000);
    return value.data || {};
  }

  function abort(id) {
    rpc(find(id), { type: 'abort' }).catch(() => {});
    return { ok: true };
  }

  function subscribe(id, listener) {
    const session = find(id);
    session.listeners.add(listener);
    listener(JSON.stringify({ type: 'pi_session_state', state: session.state, session: sessionSnapshot(session) }));
    return () => session.listeners.delete(listener);
  }

  function close() {
    for (const session of sessions.values()) {
      clearIdleTimer(session);
      try { session.child.kill('SIGTERM'); } catch (error) {}
    }
    sessions.clear();
  }

  return {
    list,
    resolveProject,
    open,
    messages,
    models,
    setApiKey,
    setModel,
    setThinking,
    compact,
    sendPrompt,
    renameSession,
    deleteSession,
    abort,
    subscribe,
    close,
    readJsonBody,
    safeProjectPath,
  };
}

module.exports = {
  MAX_PROMPT_BYTES,
  DEFAULT_PI_IDLE_TIMEOUT_MS,
  PI_IDLE_TIMEOUT_ENV,
  defaultPiPaths,
  parseSessionSummary,
  listPiSessions,
  readJsonBody,
  safeProjectPath,
  createPiAgentController,
};
