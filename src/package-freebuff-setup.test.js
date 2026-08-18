'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packager = require('./package-freebuff-setup');

test('setup packager exposes approved target matrix and stable artifact names', () => {
  assert.deepEqual(packager.TARGETS['linux-x64'], { platform: 'linux', arch: 'x64', extension: '' });
  assert.deepEqual(packager.TARGETS['darwin-arm64'], { platform: 'darwin', arch: 'arm64', extension: '' });
  assert.deepEqual(packager.TARGETS['windows-x64'], { platform: 'win32', arch: 'x64', extension: '.exe' });
  assert.equal(
    packager.artifactName('v0.2.0', 'windows-x64'),
    'freebuff-setup-v0.2.0-windows-x64.exe',
  );
});

test('setup packager renders Node 22 SEA config with embedded assets and version', () => {
  const config = packager.renderSeaConfig({
    main: '/tmp/sea-entry.js',
    output: '/tmp/sea-prep.blob',
    sourceDir: '/repo/src',
    version: 'v0.2.0',
  });
  assert.equal(config.main, '/tmp/sea-entry.js');
  assert.equal(config.output, '/tmp/sea-prep.blob');
  assert.equal(config.useCodeCache, false);
  assert.equal(config.assets['freebuff-setup.version'], '/repo/src/freebuff-setup.version');
  assert.equal(config.assets['freebuff-setup.js'], '/repo/src/freebuff-setup.js');
  assert.ok(config.assets['mobile-ui.js']);
});

test('setup packager rejects unsupported targets and malformed versions', () => {
  assert.throws(() => packager.targetFor('freebsd-x64'), /unsupported setup binary target/);
  assert.throws(() => packager.normalizeVersion('release'), /version must look like v1.2.3/);
});

test('setup release metadata records artifact hashes and checksum sidecar', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-setup-metadata-'));
  const artifact = path.join(outputDir, 'freebuff-setup-v0.2.0-linux-x64');
  fs.writeFileSync(artifact, 'binary-fixture');
  const result = packager.writeReleaseMetadata({
    version: 'v0.2.0',
    outputDir,
    artifacts: [{ target: 'linux-x64', artifact }],
  });
  const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, 'freebuff-setup');
  assert.equal(manifest.artifacts[0].assetName, path.basename(artifact));
  assert.equal(manifest.artifacts[0].bytes, 14);
  assert.match(manifest.artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(fs.readFileSync(result.checksums, 'utf8'), new RegExp(`${manifest.artifacts[0].sha256}  ${path.basename(artifact)}`));
});

test('setup release metadata discovers built target files from output directory', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-setup-output-'));
  fs.writeFileSync(path.join(outputDir, 'freebuff-setup-v0.2.0-linux-x64'), 'linux');
  fs.writeFileSync(path.join(outputDir, 'freebuff-setup-v0.2.0-windows-x64.exe'), 'windows');
  const result = packager.writeReleaseMetadataFromDirectory({ version: 'v0.2.0', outputDir });
  assert.deepEqual(result.records.map((record) => record.target), ['linux-x64', 'windows-x64']);
});
