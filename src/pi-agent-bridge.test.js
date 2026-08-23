'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createPiAgentController, listPiSessions, parseSessionSummary, safeProjectPath } = require('./pi-agent-bridge');
const { createProxyServer } = require('./freebuff_tailnet_proxy');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeChild(sessionId = 'session-1') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.requests = [];
  child.stdin.write = (line) => {
    const request = JSON.parse(line);
    child.requests.push(request);
    if (request.type === 'get_state') {
      queueMicrotask(() => child.stdout.write(JSON.stringify({
        id: request.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId,
          sessionFile: '/tmp/session-1.jsonl',
          model: { provider: 'test', id: 'model-1', name: 'Test model' },
          thinkingLevel: 'medium',
        },
      }) + '\n'));
    } else if (request.type === 'get_messages') {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, type: 'response', success: true, data: { messages: [] } }) + '\n'));
    } else if (request.type === 'get_available_models') {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, type: 'response', success: true, data: { models: [
        { provider: 'ready-provider', id: 'ready-model', name: 'Ready model' },
        { provider: 'locked-provider', id: 'locked-model', name: 'Locked model' },
        { provider: 'freebuff', id: 'freebuff-model', name: 'Freebuff runtime model' },
      ] } }) + '\n'));
    } else {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, type: 'response', success: true, data: {} }) + '\n'));
    }
    return true;
  };
  child.kill = () => { child.killed = true; child.emit('close', 0); };
  return child;
}

test('parseSessionSummary reads bounded session metadata and latest user title', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-session-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 3, id: 'abc', cwd: dir, timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'message', id: '1', message: { role: 'user', content: [{ type: 'text', text: 'Fix mobile UI' }] } }),
  ].join('\n') + '\n');
  try {
    assert.deepEqual(parseSessionSummary(file), {
      id: 'abc', cwd: dir, name: null, title: 'Fix mobile UI', updatedAt: fs.statSync(file).mtimeMs,
      timestamp: '2026-01-01T00:00:00Z', messageCount: 1, file,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeProjectPath rejects paths outside allowed root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-root-'));
  const child = path.join(dir, 'project');
  fs.mkdirSync(child);
  try {
    assert.equal(safeProjectPath(child, dir), child);
    assert.throws(() => safeProjectPath('/tmp', dir), /pi_project_forbidden/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi controller opens a session and forwards RPC commands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-project-'));
  let child;
  let piArgs;
  const controller = createPiAgentController({
    allowedRoot: path.dirname(dir),
    nodePath: process.execPath,
    cliPath: __filename,
    spawnCommand: (_node, args) => { piArgs = args; child = fakeChild(); return child; },
    authSpawn: (_node, args) => {
      const auth = new EventEmitter();
      auth.stdout = new PassThrough();
      auth.kill = () => {};
      const provider = args[args.indexOf('--provider') + 1];
      queueMicrotask(() => {
        auth.stdout.write(JSON.stringify(provider === 'ready-provider'
          ? { status: 'ready', provider }
          : { status: 'not_ready', provider, reason: 'missing_credentials' }) + '\n');
        auth.emit('close', 0);
      });
      return auth;
    },
  });
  try {
    const opened = await controller.open({ cwd: dir });
    assert.equal(opened.id, 'session-1');
    assert.equal(opened.model.id, 'model-1');
    assert.deepEqual(piArgs.slice(1, 4), ['--mode', 'rpc', '--approve']);
    const messages = await controller.messages('session-1');
    assert.deepEqual(messages, { messages: [] });
    const catalog = await controller.models('session-1');
    assert.deepEqual(catalog.models.map((model) => model.id), ['ready-model']);
    assert.deepEqual(catalog.authenticatedProviders, ['ready-provider']);
    await controller.sendPrompt('session-1', 'hello');
    await controller.sendPrompt('session-1', 'follow-up while running');
    await controller.setThinking('session-1', 'high');
    assert.equal(child.requests.find((request) => request.type === 'prompt' && request.message === 'follow-up while running').streamingBehavior, 'followUp');
    assert.equal(child.killed, false);
  } finally {
    controller.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi controller keeps runtime/extension providers whose CLI auth check is unknown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-runtime-provider-'));
  let child;
  const controller = createPiAgentController({
    allowedRoot: path.dirname(dir),
    nodePath: process.execPath,
    cliPath: __filename,
    spawnCommand: () => { child = fakeChild(); return child; },
    // 'freebuff' is a custom provider registered by an extension at runtime.
    // The CLI auth check does not enumerate it (provider_not_found), but pi's
    // runtime already returned its models via get_available_models.
    authSpawn: (_node, args) => {
      const auth = new EventEmitter();
      auth.stdout = new PassThrough();
      auth.kill = () => {};
      const provider = args[args.indexOf('--provider') + 1];
      queueMicrotask(() => {
        // freebuff is a runtime/extension provider the CLI does not enumerate.
        // ready-provider is ready; locked-provider truly lacks credentials.
        const status = provider === 'freebuff'
          ? { status: 'not_ready', provider, reason: 'provider_not_found' }
          : provider === 'ready-provider'
            ? { status: 'ready', provider }
            : { status: 'not_ready', provider, reason: 'missing_credentials' };
        auth.stdout.write(JSON.stringify(status) + '\n');
        auth.emit('close', 0);
      });
      return auth;
    },
  });
  try {
    await controller.open({ cwd: dir });
    const catalog = await controller.models('session-1');
    // The runtime provider's models survive the auth filter; a truly
    // unauthenticated builtin provider (locked-provider) is still dropped.
    assert.deepEqual(catalog.models.map((model) => model.id), ['ready-model', 'freebuff-model']);
    assert.ok(catalog.authenticatedProviders.includes('freebuff'));
  } finally {
    controller.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi controller closes idle processes but keeps running work alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-idle-'));
  let child;
  const controller = createPiAgentController({
    allowedRoot: path.dirname(dir),
    nodePath: process.execPath,
    cliPath: __filename,
    idleTimeoutMs: 30,
    spawnCommand: () => { child = fakeChild(); return child; },
  });
  try {
    await controller.open({ cwd: dir });
    child.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\n');
    await wait(50);
    assert.equal(child.killed, false);
    child.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');
    await wait(50);
    assert.equal(child.killed, true);
  } finally {
    controller.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi controller reopens an idle session for the next prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-idle-resume-'));
  const project = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(agentDir, 'sessions', 'bucket');
  fs.mkdirSync(project);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session-1.jsonl'), JSON.stringify({
    type: 'session', id: 'session-1', cwd: project,
  }) + '\n');
  const children = [];
  const controller = createPiAgentController({
    agentDir,
    allowedRoot: root,
    nodePath: process.execPath,
    cliPath: __filename,
    idleTimeoutMs: 20,
    spawnCommand: () => {
      const child = fakeChild('session-1');
      children.push(child);
      return child;
    },
  });
  try {
    await controller.open({ cwd: project, sessionId: 'session-1' });
    await wait(40);
    assert.equal(children[0].killed, true);
    await controller.sendPrompt('session-1', 'resume work', project);
    assert.equal(children.length, 2);
    assert.equal(children[1].requests.find((request) => request.type === 'prompt').message, 'resume work');
  } finally {
    controller.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Pi controller keeps up to 5 live sessions, evicting oldest when over limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-single-process-'));
  const children = [];
  const controller = createPiAgentController({
    allowedRoot: path.dirname(dir),
    nodePath: process.execPath,
    cliPath: __filename,
    spawnCommand: () => {
      const child = fakeChild(`session-${children.length + 1}`);
      children.push(child);
      return child;
    },
  });
  try {
    await controller.open({ cwd: dir });
    await controller.open({ cwd: dir });
    assert.equal(children.length, 2);
    assert.equal(children[0].killed, false);
    assert.equal(children[1].killed, false);
    // Fill to limit (5) then exceed — oldest should be evicted
    await controller.open({ cwd: dir });
    await controller.open({ cwd: dir });
    await controller.open({ cwd: dir });
    assert.equal(children.length, 5);
    assert.equal(children[0].killed, false);
    await controller.open({ cwd: dir });
    assert.equal(children.length, 6);
    assert.equal(children[0].killed, true);
    assert.equal(children[5].killed, false);
  } finally {
    controller.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi session history supports rename and safe delete', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-history-'));
  const project = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(agentDir, 'sessions', 'bucket');
  const file = path.join(sessionDir, 'one.jsonl');
  fs.mkdirSync(project);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', version: 3, id: 'one', cwd: project }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'History item' }] } }),
  ].join('\n') + '\n');
  let child;
  const controller = createPiAgentController({
    agentDir,
    allowedRoot: root,
    nodePath: process.execPath,
    cliPath: __filename,
    spawnCommand: () => { child = fakeChild('one'); return child; },
  });
  try {
    const listed = await controller.list(project);
    assert.equal(listed[0].id, 'one');
    const renamed = await controller.renameSession('one', project, 'Renamed session');
    assert.equal(renamed.name, 'Renamed session');
    assert.equal(child.requests.find((request) => request.type === 'set_session_name').name, 'Renamed session');
    assert.deepEqual(await controller.deleteSession('one', project), { ok: true, id: 'one' });
    assert.equal(fs.existsSync(file), false);
  } finally {
    controller.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('proxy exposes Pi session RPC routes over the same HTTP origin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-proxy-project-'));
  let child;
  const proxy = createProxyServer({
    upstream: 'http://127.0.0.1:1',
    pi: {
      allowedRoot: path.dirname(dir),
      nodePath: process.execPath,
      cliPath: __filename,
      spawnCommand: () => { child = fakeChild(); return child; },
    },
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;
  try {
    const opened = await fetch(`http://127.0.0.1:${port}/api/fb/pi/session/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir }),
    });
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).session.id, 'session-1');
    const messages = await fetch(`http://127.0.0.1:${port}/api/fb/pi/session/session-1/messages`);
    assert.equal(messages.status, 200);
    assert.deepEqual(await messages.json(), { messages: [] });
    assert.equal(child.killed, false);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi controller and proxy default empty cwd to home for list and open', async () => {
  let child;
  const controller = createPiAgentController({
    nodePath: process.execPath,
    cliPath: __filename,
    spawnCommand: () => { child = fakeChild('home-session'); return child; },
  });
  try {
    const listed = await controller.list('');
    assert.ok(Array.isArray(listed));
    const opened = await controller.open({ cwd: '' });
    assert.equal(opened.id, 'home-session');
    assert.equal(opened.cwd, os.homedir());
  } finally {
    controller.close();
  }
  const proxy = createProxyServer({
    upstream: 'http://127.0.0.1:1',
    pi: {
      nodePath: process.execPath,
      cliPath: __filename,
      spawnCommand: () => { child = fakeChild(); return child; },
    },
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/fb/pi/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions));
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test('listPiSessions filters exact project cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pi-agent-'));
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  fs.mkdirSync(path.join(agentDir, 'sessions', 'bucket'), { recursive: true });
  const make = (id, cwd) => fs.writeFileSync(path.join(agentDir, 'sessions', 'bucket', `${id}.jsonl`), JSON.stringify({ type: 'session', id, cwd }) + '\n');
  make('one', project);
  make('two', other);
  try {
    assert.deepEqual(listPiSessions(project, { agentDir, allowedRoot: root }).map((item) => item.id), ['one']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
