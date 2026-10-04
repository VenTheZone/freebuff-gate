"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");

test("panel binds loopback, serves management pages, and rejects unauthorized actions", async () => {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "freebuff-panel.js")],
    {
      env: { ...process.env, FREEBUFF_PANEL_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Panel startup timed out")),
        5000,
      );
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = /Painel local: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Panel exited: ${code}`));
      });
    });
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "freebuff-panel");
    const html = await (await fetch(origin)).text();
    assert.match(html, /id="list-page"/);
    assert.match(html, /id="detail-page"/);
    assert.match(html, /id="new-page"/);
    assert.equal((await fetch(`${origin}/brand.png`)).status, 200);
    const badHost = await new Promise((resolve, reject) => {
      http
        .get(
          `${origin}/api/health`,
          { headers: { host: "other.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
        .on("error", reject);
    });
    assert.equal(badHost, 403);
    const unauthorized = await fetch(`${origin}/api/reconnect`, {
      method: "POST",
      headers: { origin },
    });
    assert.equal(unauthorized.status, 403);
    const { csrf } = await (await fetch(`${origin}/api/bootstrap`)).json();
    const invalidRevoke = await fetch(`${origin}/api/revoke`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-freebuff-panel-token": csrf,
      },
      body: JSON.stringify({ deviceId: "../other", confirm: "REVOGAR" }),
    });
    assert.equal(invalidRevoke.status, 400);
  } finally {
    child.kill();
  }
});
