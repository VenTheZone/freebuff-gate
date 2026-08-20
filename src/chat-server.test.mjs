import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSkillSystemPrompt,
  createChatServer,
  DEFAULT_MODEL,
  discoverSkills,
} from "./chat-server.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Records the model + messages handed to a fake stream, then returns a canned
// SSE response. Keeps the test hermetic: no SDK, no proxy, no network.
function recordingStream(calls, body = "data: {\"type\":\"text-delta\",\"delta\":\"hello\"}\n\n") {
  return async ({ model, messages, system }) => {
    calls.push({ model, messages, system });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

test("skill discovery loads valid SKILL.md files from configured roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fb-skills-"));
  const skillDir = path.join(root, "review");
  fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: code-review",
    "description: Review code for correctness and security.",
    "---",
    "# Review",
    "Always inspect error handling.",
  ].join("\n"));
  try {
    const skills = discoverSkills({ skillRoots: [root] });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "code-review");
    assert.match(buildSkillSystemPrompt(skills), /Always inspect error handling/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("chat server injects discovered skills into model system prompt", async () => {
  const calls = [];
  const server = createChatServer({
    loadSkills: () => [{
      name: "ship-safe",
      description: "Use when preparing a release.",
      file: "/tmp/ship-safe/SKILL.md",
      instructions: "Run release checks before publishing.",
    }],
    stream: recordingStream(calls),
  });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "prepare release" }),
    });
    assert.equal(res.status, 200);
    assert.match(calls[0].system, /<skill name="ship-safe">/);
    assert.match(calls[0].system, /Run release checks before publishing/);
  } finally {
    await close(server);
  }
});

test("GET /health reports ok and the configured model", async () => {
  const calls = [];
  const server = createChatServer({ stream: recordingStream(calls) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, model: DEFAULT_MODEL });
  } finally {
    await close(server);
  }
});

test("POST /chat turns a prompt into a user message and streams the reply", async () => {
  const calls = [];
  const server = createChatServer({ stream: recordingStream(calls) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.match(await res.text(), /text-delta.*hello/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, DEFAULT_MODEL);
    assert.deepEqual(calls[0].messages, [{ role: "user", content: "hi" }]);
  } finally {
    await close(server);
  }
});

test("POST /chat passes an explicit messages array through and streams", async () => {
  const calls = [];
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
  ];
  const server = createChatServer({ stream: recordingStream(calls) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.deepEqual(calls[0].messages, messages);
    assert.match(await res.text(), /text-delta/);
  } finally {
    await close(server);
  }
});

test("POST /chat maps quota errors to 429", async () => {
  const stream = async () => {
    throw new Error("The usage limit has been reached");
  };
  const server = createChatServer({ stream });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), {
      error: "The usage limit has been reached",
    });
  } finally {
    await close(server);
  }
});

test("POST /chat maps other failures to 500", async () => {
  const stream = async () => {
    throw new Error("upstream exploded");
  };
  const server = createChatServer({ stream });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "upstream exploded" });
  } finally {
    await close(server);
  }
});

test("POST /chat with a malformed body returns an error", async () => {
  const server = createChatServer({ stream: recordingStream([]) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.ok(payload.error, "malformed body surfaces an error message");
  } finally {
    await close(server);
  }
});

test("POST /api/chat normalizes UI messages and streams the response", async () => {
  const streamCalls = [];
  const fakeStream = async ({ model, messages }) => {
    streamCalls.push({ model, messages });
    return new Response("data: {\"type\":\"text-delta\",\"delta\":\"hi\"}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const server = createChatServer({ stream: fakeStream });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "thread-1",
        messages: [
          {
            id: "m1",
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", image: "data:image/png;base64,AA==" },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.match(await res.text(), /text-delta/);
    assert.equal(streamCalls.length, 1);
    assert.equal(streamCalls[0].model, DEFAULT_MODEL);
    assert.deepEqual(streamCalls[0].messages, [
      { role: "user", content: "hello" },
    ]);
  } finally {
    await close(server);
  }
});

test("POST /api/chat surfaces stream failures as a JSON error", async () => {
  const server = createChatServer({
    stream: async () => {
      throw new Error("The usage limit has been reached");
    },
  });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "thread-1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), {
      error: "The usage limit has been reached",
    });
  } finally {
    await close(server);
  }
});

test("unknown routes return 404", async () => {
  const server = createChatServer({ stream: recordingStream([]) });
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  } finally {
    await close(server);
  }
});
