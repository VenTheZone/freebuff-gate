#!/usr/bin/env node
// Freebuff Desktop clears FREEBUFF_LAUNCH_ID at startup. On Windows the Gate
// proxy cannot recover it from the orchestrator process after that point.
// Record the current process ID and launch identity in a user-protected file.
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = process.argv[2];
if (!desktopDir) throw new Error('Usage: node patch-windows-launch-bridge.js <desktop-dir>');
const file = path.join(desktopDir, 'resources', 'orchestrator', 'orchestrator.js');
const original = fs.readFileSync(file, 'utf8');
const marker = '/* freebuff-gate-windows-launch-bridge */';
if (original.includes(marker)) {
  console.log('Windows launch bridge already present');
  process.exit(0);
}
const anchor = 'var LAUNCH_ID = bootstrap?.launchId ?? ENV_LAUNCH_ID;';
if (original.split(anchor).length !== 2) throw new Error('Launch identity anchor changed; refusing to patch');
const bridge = `${anchor}\n${marker}\ntry {
  if (process.platform === "win32" && LAUNCH_ID) {
    const gateFs = await import("node:fs");
    const gatePath = await import("node:path");
    const gateFile = gatePath.join(process.env.LOCALAPPDATA, "Freebuff", "gate-launch-id.json");
    gateFs.writeFileSync(gateFile, JSON.stringify({ pid: process.pid, launchId: LAUNCH_ID }));
  }
} catch (gateError) {
  console.error("[freebuff gate] launch bridge failed:", gateError.message);
}`;
const updated = original.replace(anchor, bridge);
const temp = `${file}.gate-tmp-${process.pid}`;
fs.writeFileSync(temp, updated, 'utf8');
try { fs.renameSync(temp, file); }
catch (error) { fs.rmSync(temp, { force: true }); throw error; }
console.log('Windows launch bridge installed');
