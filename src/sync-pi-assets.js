#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ASSET_DIR = path.join(__dirname, '..', 'pi-assets');

function agentDirFromArgs(argv) {
  const index = argv.indexOf('--agent-dir');
  return path.resolve(index >= 0 ? argv[index + 1] : process.env.FB_PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
}

function writeJson(file, value, mode = 0o600) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, mode); } catch {}
}

function copyDirectory(source, target) {
  if (!fs.existsSync(source)) return 0;
  let copied = 0;
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copied += copyDirectory(from, to);
    else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

function mergeSettings(agentDir, assetDir = ASSET_DIR) {
  const source = path.join(assetDir, 'settings.json');
  if (!fs.existsSync(source)) return;
  const target = path.join(agentDir, 'settings.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(target, 'utf8')); } catch {}
  const bundled = JSON.parse(fs.readFileSync(source, 'utf8'));
  const packages = Array.from(new Set([
    ...(Array.isArray(current.packages) ? current.packages : []),
    ...(Array.isArray(bundled.packages) ? bundled.packages : []),
  ]));
  writeJson(target, { ...current, packages }, 0o600);
}

function installNpmAssets(agentDir, dryRun, assetDir = ASSET_DIR, installDependencies = false) {
  const source = path.join(assetDir, 'npm');
  if (!fs.existsSync(source)) return;
  const target = path.join(agentDir, 'npm');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  if (dryRun || !installDependencies) return;
  const result = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: target,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`npm install failed with status ${result.status}`);
  }
}

function syncPiAssets({ agentDir, assetDir = ASSET_DIR, dryRun = false, installDependencies = false } = {}) {
  if (!fs.existsSync(assetDir)) throw new Error(`Missing Pi asset directory: ${assetDir}`);
  if (dryRun) console.log(`Would sync Pi assets to ${agentDir}`);
  else fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const extensionCount = dryRun ? 0 : copyDirectory(path.join(assetDir, 'extensions'), path.join(agentDir, 'extensions'));
  if (!dryRun) mergeSettings(agentDir, assetDir);
  installNpmAssets(agentDir, dryRun, assetDir, installDependencies);
  return { agentDir, extensionCount, dryRun };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const result = syncPiAssets({
    agentDir: agentDirFromArgs(argv),
    dryRun: argv.includes('--dry-run'),
    installDependencies: argv.includes('--install-dependencies'),
  });
  console.log(result.dryRun ? 'Pi asset sync planned.' : `Pi assets synced (${result.extensionCount} extension file(s)).`);
}

module.exports = { ASSET_DIR, syncPiAssets };
