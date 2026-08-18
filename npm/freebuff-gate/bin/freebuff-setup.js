#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const PLATFORM = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
const ARCH = { x64: 'x64', arm64: 'arm64' }[process.arch];
const pkgName = PLATFORM && ARCH ? `freebuff-gate-${PLATFORM}-${ARCH}` : null;

if (!pkgName) {
  console.error(
    `freebuff-gate: unsupported platform ${process.platform}-${process.arch}; ` +
      'supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64',
  );
  process.exit(1);
}

let binaryPath;
try {
  // Platform packages set "main" to the SEA binary itself, so resolving the
  // package name yields the executable path (esbuild pattern).
  binaryPath = require.resolve(pkgName);
} catch {
  console.error(
    `freebuff-gate: optional dependency ${pkgName} is not installed. ` +
      'Install without --no-optional and retry.',
  );
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`freebuff-gate: failed to launch ${binaryPath}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
