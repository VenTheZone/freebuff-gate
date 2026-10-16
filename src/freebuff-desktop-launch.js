#!/usr/bin/env node
'use strict';

// Freebuff Desktop launcher for Gate-patched AppImage installs (Linux).
//
// Gate patches an extracted copy of the AppImage (<desktop-dir>/squashfs-root)
// because the AppImage itself is read-only. Desktop's own updater does not
// know about that copy: it downloads the new AppImage next to the old one,
// deletes the old one, and on "restart to update" launches the new AppImage
// directly, bypassing the patches. This launcher closes that gap:
//
// - Before launching, a newer Freebuff-X.Y.Z-*.AppImage in the desktop dir is
//   extracted to a staging dir, patched, verified, then swapped in. The
//   previous copy is kept as squashfs-root-<version>-gate-backup (only the
//   newest such backup is kept). Any failure leaves the current copy alone.
// - Desktop runs with APPIMAGE pointing at the newest AppImage, so its
//   updater keeps working.
// - After Desktop exits, if the updater just launched the new AppImage
//   directly, that unpatched instance is stopped and the patched copy is
//   upgraded and relaunched instead.
//
//   node freebuff-desktop-launch.js [Desktop args...]
//
// Use it as the Exec= of the Freebuff menu entry (see docs/install.md).

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = 'squashfs-root';
const APPIMAGE_NAME = /^Freebuff-(\d+)\.(\d+)\.(\d+)-linux-[\w-]+\.AppImage$/;
const GATE_BACKUP = /^squashfs-root-.+-gate-backup$/;
const STOP_TIMEOUT_MS = 10_000;
const UPDATER_SPAWN_WAIT_MS = 5_000;
const LOCK_TIMEOUT_MS = 5 * 60_000;

function log(desktopDir, message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try { fs.appendFileSync(path.join(desktopDir, 'gate-launch.log'), `${line}\n`); } catch {}
}

function notify(message) {
  try {
    childProcess.spawn('notify-send', ['Freebuff Gate', message], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {}
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  return match ? match.slice(1, 4).map(Number) : null;
}

function newestAppImage(desktopDir) {
  let newest = null;
  for (const name of fs.readdirSync(desktopDir)) {
    const match = APPIMAGE_NAME.exec(name);
    if (!match) continue;
    const version = match.slice(1, 4).map(Number);
    if (!newest || compareVersions(version, newest.version) > 0) {
      newest = { file: path.join(desktopDir, name), version };
    }
  }
  return newest;
}

// Reads package.json out of resources/app.asar: an 8-byte size pickle, a
// JSON header (length at byte 12, text at 16), then file data starting at
// 8 + header size.
function installedVersion(appRoot) {
  let fd;
  try {
    fd = fs.openSync(path.join(appRoot, 'resources', 'app.asar'), 'r');
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    fs.readSync(fd, header, 0, header.length, 16);
    const entry = JSON.parse(header.toString('utf8')).files['package.json'];
    const data = Buffer.alloc(entry.size);
    fs.readSync(fd, data, 0, entry.size, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    return JSON.parse(data.toString('utf8')).version || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function processes() {
  const list = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let argv0 = '';
    let exe = '';
    let pgid = pid;
    try { argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]; } catch {}
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}
    try {
      // Fields after the parenthesized command name: state ppid pgrp ...
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) || pid;
    } catch {}
    list.push({ pid, pgid, argv0, exe });
  }
  return list;
}

function readMounts() {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(Boolean).map((line) => {
      const [, point, type] = line.split(' ');
      return { point: point.replace(/\\040/g, ' '), type };
    });
  } catch {
    return [];
  }
}

// Processes started from one AppImage. Its runtime execs AppRun and then
// Electron from a FUSE mount whose type names the AppImage file, while a
// FUSE helper (in its own process group) keeps the AppImage path as argv0.
function appImageProcesses(appImage, list = processes(), mounts = readMounts()) {
  const type = `fuse.${path.basename(appImage)}`;
  const points = mounts.filter((mount) => mount.type === type).map((mount) => `${mount.point}${path.sep}`);
  return list.filter((proc) => proc.argv0 === appImage
    || points.some((point) => proc.exe.startsWith(point) || proc.argv0.startsWith(point)));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Stops every process group the matched processes belong to (the updater
// spawns the AppImage detached, so the app leads its own group).
function stopProcesses(procs) {
  const own = processes().find((proc) => proc.pid === process.pid);
  const groups = [...new Set(procs.map((proc) => proc.pgid))]
    .filter((group) => group > 1 && (!own || group !== own.pgid));
  const signal = (name) => {
    for (const group of groups) {
      try { process.kill(-group, name); } catch {}
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (procs.some((proc) => alive(proc.pid)) && Date.now() < deadline) sleep(200);
  if (procs.some((proc) => alive(proc.pid))) signal('SIGKILL');
}

// The updater spawns the new AppImage just before the old Desktop exits, and
// its mount appears asynchronously, so look for a few seconds.
function waitForAppImageProcesses(appImage, timeoutMs = UPDATER_SPAWN_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const procs = appImageProcesses(appImage);
    if (procs.length > 0 || Date.now() >= deadline) return procs;
    sleep(200);
  }
}

// One upgrade at a time per desktop dir. A second launcher waits for the
// first instead of launching a half-swapped copy; a lock left by a dead
// process is taken over.
function withLock(desktopDir, fn) {
  const lock = path.join(desktopDir, '.gate-launch.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(lock, 'utf8')) || 0;
      if (!holder || !alive(holder) || Date.now() > deadline) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      sleep(500);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function defaultExtract(appImage, stagingDir) {
  fs.chmodSync(appImage, 0o755);
  childProcess.execFileSync(appImage, ['--appimage-extract'], { cwd: stagingDir, stdio: 'ignore', timeout: 5 * 60_000 });
}

// Extracts, patches and verifies the newest AppImage in a staging dir, then
// swaps it in. Returns { upgraded, from, to, error }.
function upgrade(desktopDir, { extract = defaultExtract, patch, verify }) {
  const image = newestAppImage(desktopDir);
  const live = path.join(desktopDir, APP_ROOT);
  const current = installedVersion(live);
  if (!image) return { upgraded: false, from: current };
  const to = image.version.join('.');
  const currentVersion = parseVersion(current);
  if (currentVersion && compareVersions(currentVersion, image.version) >= 0) {
    return { upgraded: false, from: current, to };
  }

  const staging = path.join(desktopDir, '.gate-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging);
  try {
    extract(image.file, staging);
    patch(staging);
    const problems = verify(staging);
    if (problems.length > 0) throw new Error(problems.join('; '));
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { upgraded: false, from: current, to, error: error.message };
  }

  let backup = null;
  if (fs.existsSync(live)) {
    backup = path.join(desktopDir, `${APP_ROOT}-${current || 'unknown'}-gate-backup`);
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(live, backup);
  }
  try {
    fs.renameSync(path.join(staging, APP_ROOT), live);
  } catch (error) {
    if (backup) fs.renameSync(backup, live);
    fs.rmSync(staging, { recursive: true, force: true });
    return { upgraded: false, from: current, to, error: error.message };
  }
  fs.rmSync(staging, { recursive: true, force: true });
  // Keep only the newest launcher-made backup; hand-made copies are left alone.
  for (const name of fs.readdirSync(desktopDir)) {
    const dir = path.join(desktopDir, name);
    if (GATE_BACKUP.test(name) && dir !== backup) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { upgraded: true, from: current, to };
}

function runningFrom(dir, list = processes()) {
  const prefix = `${dir}${path.sep}`;
  return list.some((proc) => proc.exe.startsWith(prefix));
}

function launch(live, args, appImage) {
  const env = { ...process.env, APPDIR: live };
  if (appImage) env.APPIMAGE = appImage;
  else delete env.APPIMAGE;
  return new Promise((resolve) => {
    const child = childProcess.spawn(path.join(live, 'AppRun'), args, { stdio: 'inherit', env });
    child.on('error', (error) => {
      console.error(`Could not start Freebuff Desktop: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

// The installer modules live in Gate's source dir (recorded in the
// ui-source.json beside the deployed proxy) or next to this file.
function loadInstaller() {
  const dirs = [process.env.FB_GATE_SOURCE_DIR];
  try {
    dirs.push(JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-source.json'), 'utf8')).sourceDir);
  } catch {}
  dirs.push(__dirname);
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(path.join(dir, 'install-mobile-connect.js'))) continue;
    try {
      return require(path.join(dir, 'install-mobile-connect.js'));
    } catch {}
  }
  return null;
}

function upgradeWithInstaller(desktopDir, installer) {
  if (!installer) {
    log(desktopDir, 'Gate installer modules not found; launching without upgrade check');
    return;
  }
  const result = withLock(desktopDir, () => upgrade(desktopDir, {
    patch: (dir) => installer.applyDesktopPatches(dir),
    verify: (dir) => installer.verifyUiStack({ desktopDir: dir }).errors
      .filter((problem) => /^(bundle|shim|orchestrator)/.test(problem.item))
      .map((problem) => `${problem.item}: ${problem.message}`),
  }));
  if (result.upgraded) {
    log(desktopDir, `upgraded Freebuff Desktop ${result.from || '?'} -> ${result.to} with Gate patches`);
  } else if (result.error) {
    // ponytail: a version Gate cannot patch is re-extracted (~10 s) on every launch until Gate is updated; cache failures per Gate version if that gets annoying.
    log(desktopDir, `kept Freebuff Desktop ${result.from || '?'}: ${result.to} failed Gate patching: ${result.error}`);
    notify(`Freebuff Desktop ${result.to} is downloaded but Gate could not patch it, so ${result.from || 'the current version'} keeps running. Update Gate in Settings, then restart Freebuff.`);
  }
}

async function main(args = process.argv.slice(2)) {
  const installer = loadInstaller();
  const desktopDir = path.resolve(process.env.FREEBUFF_DESKTOP_DIR
    || (installer ? installer.findFreebuffDesktop() : path.join(os.homedir(), '.local', 'share', 'freebuff-desktop')));
  const live = path.join(desktopDir, APP_ROOT);
  // Electron helpers can outlive the main process for a moment after exit.
  const settle = () => {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (runningFrom(live) && Date.now() < deadline) sleep(200);
  };
  for (;;) {
    // Never swap the copy a running Desktop is using; this launch then only
    // hands off to that instance (Electron's single-instance lock).
    if (!runningFrom(live)) upgradeWithInstaller(desktopDir, installer);
    const image = newestAppImage(desktopDir);
    const code = await launch(live, args, image && image.file);

    const next = newestAppImage(desktopDir);
    if (!next || (image && next.file === image.file)) return code;
    // Desktop's updater installed a new AppImage while it ran.
    const direct = waitForAppImageProcesses(next.file);
    if (direct.length === 0) {
      // Quit with an update pending: stage it now, but do not relaunch.
      settle();
      if (!runningFrom(live)) upgradeWithInstaller(desktopDir, installer);
      return code;
    }
    log(desktopDir, `stopping unpatched ${path.basename(next.file)} started by Desktop's updater; relaunching the patched copy`);
    stopProcesses(direct);
    settle();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  appImageProcesses,
  compareVersions,
  installedVersion,
  newestAppImage,
  runningFrom,
  upgrade,
};
