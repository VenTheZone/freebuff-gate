'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { appImageProcesses, installedVersion, newestAppImage, runningFrom, upgrade } = require('./freebuff-desktop-launch');

// Minimal asar: size pickle, JSON header pickle, then package.json bytes.
function writeAsar(file, version) {
  const data = Buffer.from(JSON.stringify({ name: 'freebuff-desktop', version }));
  const json = Buffer.from(JSON.stringify({ files: { 'package.json': { size: data.length, offset: '0' } } }));
  const header = Buffer.alloc(8 + json.length);
  header.writeUInt32LE(4 + json.length, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([size, header, data]));
}

function fakeDesktop(installed, images) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-desktop-launch-'));
  writeAsar(path.join(dir, 'squashfs-root', 'resources', 'app.asar'), installed);
  for (const version of images) fs.writeFileSync(path.join(dir, `Freebuff-${version}-linux-x86_64.AppImage`), '');
  return dir;
}

// Stands in for --appimage-extract: unpacks a squashfs-root for the version in the file name.
function fakeExtract(appImage, staging) {
  const version = /Freebuff-([\d.]+)-linux/.exec(path.basename(appImage))[1];
  writeAsar(path.join(staging, 'squashfs-root', 'resources', 'app.asar'), version);
}

test('installedVersion reads package.json from app.asar and newestAppImage compares numerically', () => {
  const dir = fakeDesktop('0.0.162', ['0.0.151', '0.0.176', '0.0.99']);
  assert.equal(installedVersion(path.join(dir, 'squashfs-root')), '0.0.162');
  assert.equal(path.basename(newestAppImage(dir).file), 'Freebuff-0.0.176-linux-x86_64.AppImage');
});

test('upgrade swaps in the patched newer AppImage and keeps one launcher backup', () => {
  const dir = fakeDesktop('0.0.162', ['0.0.176']);
  fs.mkdirSync(path.join(dir, 'squashfs-root-0.0.100-gate-backup'));
  fs.mkdirSync(path.join(dir, 'squashfs-root-0.0.151-backup'));
  const patched = [];
  const result = upgrade(dir, { extract: fakeExtract, patch: (staging) => patched.push(staging), verify: () => [] });
  assert.deepEqual(result, { upgraded: true, from: '0.0.162', to: '0.0.176' });
  assert.equal(patched.length, 1);
  assert.equal(installedVersion(path.join(dir, 'squashfs-root')), '0.0.176');
  assert.equal(installedVersion(path.join(dir, 'squashfs-root-0.0.162-gate-backup')), '0.0.162');
  assert.equal(fs.existsSync(path.join(dir, 'squashfs-root-0.0.100-gate-backup')), false, 'older launcher backup pruned');
  assert.equal(fs.existsSync(path.join(dir, 'squashfs-root-0.0.151-backup')), true, 'hand-made backup kept');
  assert.equal(fs.existsSync(path.join(dir, '.gate-staging')), false);
  assert.equal(upgrade(dir, { extract: fakeExtract, patch() {}, verify: () => [] }).upgraded, false, 'already current');
});

test('upgrade keeps the current copy when the new version fails Gate verification', () => {
  const dir = fakeDesktop('0.0.162', ['0.0.176']);
  const result = upgrade(dir, { extract: fakeExtract, patch() {}, verify: () => ['bundle: anchors moved'] });
  assert.equal(result.upgraded, false);
  assert.equal(result.error, 'bundle: anchors moved');
  assert.equal(installedVersion(path.join(dir, 'squashfs-root')), '0.0.162');
  assert.equal(fs.existsSync(path.join(dir, '.gate-staging')), false);
});

test('runningFrom matches processes whose executable lives inside the app dir', () => {
  const procs = [{ pid: 1, argv0: '', exe: '/d/squashfs-root/@codebufffreebuff-desktop' }];
  assert.equal(runningFrom('/d/squashfs-root', procs), true);
  assert.equal(runningFrom('/d/squashfs-root-0.0.162-gate-backup', [{ pid: 1, argv0: '', exe: '/d/squashfs-root/x' }]), false);
  assert.equal(runningFrom('/d/squashfs', procs), false);
});

test('appImageProcesses finds the updater-started app by its FUSE mount and runtime argv0', () => {
  const image = '/d/Freebuff-0.0.177-linux-x86_64.AppImage';
  const mounts = [
    { point: '/tmp/.mount_FreebuA', type: 'fuse.Freebuff-0.0.177-linux-x86_64.AppImage' },
    { point: '/tmp/.mount_FreebuB', type: 'fuse.Freebuff-0.0.176-linux-x86_64.AppImage' },
  ];
  const list = [
    { pid: 10, pgid: 10, argv0: '/tmp/.mount_FreebuA/@codebufffreebuff-desktop', exe: '/tmp/.mount_FreebuA/@codebufffreebuff-desktop' },
    { pid: 11, pgid: 11, argv0: image, exe: image },
    { pid: 12, pgid: 10, argv0: '/tmp/.mount_FreebuA/AppRun', exe: '/usr/bin/bash' },
    { pid: 20, pgid: 20, argv0: '/tmp/.mount_FreebuB/@codebufffreebuff-desktop', exe: '/tmp/.mount_FreebuB/@codebufffreebuff-desktop' },
    { pid: 30, pgid: 30, argv0: '/usr/bin/bash', exe: '/usr/bin/bash' },
  ];
  assert.deepEqual(appImageProcesses(image, list, mounts).map((proc) => proc.pid), [10, 11, 12]);
});
