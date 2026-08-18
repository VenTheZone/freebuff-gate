'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'docker', 'relay', 'backup.sh');

function run(args, options = {}) {
  return childProcess.spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createArchive(root, metadata) {
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'payload.txt'), 'original payload\n');
  fs.writeFileSync(
    path.join(source, 'freebuff-backup-metadata'),
    run(['metadata', metadata.project, metadata.volume, metadata.version, metadata.createdAt]).stdout,
  );
  const archive = path.join(root, `${metadata.createdAt}-${metadata.volume}.tgz`);
  const packed = childProcess.spawnSync('tar', ['-czf', archive, '-C', source, '.'], {
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  fs.writeFileSync(
    `${archive}.sha256`,
    `${sha256(archive)}  ${path.basename(archive)}\n`,
  );
  return { archive, source };
}

test('backup metadata command emits project, volume, version, and creation timestamp', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX backup utility test');
    return;
  }
  const result = run(['metadata', 'freebuff-relay', 'relay-state', 'v0.2.0', '20260818T120000Z']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'format=freebuff-relay-backup-v1\n' +
      'project=freebuff-relay\n' +
      'volume=relay-state\n' +
      'version=v0.2.0\n' +
      'created_at=20260818T120000Z\n',
  );
});

test('archive validation detects payload tampering without metadata changes', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX backup utility test');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-backup-test-'));
  try {
    const metadata = {
      project: 'freebuff-relay',
      volume: 'relay-state',
      version: 'v0.2.0',
      createdAt: '20260818T120000Z',
    };
    const { archive, source } = createArchive(root, metadata);
    const valid = run([
      'validate-archive',
      archive,
      metadata.project,
      metadata.volume,
      metadata.version,
      metadata.createdAt,
    ]);
    assert.equal(valid.status, 0, valid.stderr);

    fs.writeFileSync(path.join(source, 'payload.txt'), 'tampered payload\n');
    const repacked = childProcess.spawnSync('tar', ['-czf', archive, '-C', source, '.'], {
      encoding: 'utf8',
    });
    assert.equal(repacked.status, 0, repacked.stderr);

    const tampered = run([
      'validate-archive',
      archive,
      metadata.project,
      metadata.volume,
      metadata.version,
      metadata.createdAt,
    ]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /checksum mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archive validation rejects project and version mismatches', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX backup utility test');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-backup-test-'));
  try {
    const metadata = {
      project: 'freebuff-relay',
      volume: 'caddy-data',
      version: 'v0.2.0',
      createdAt: '20260818T120000Z',
    };
    const { archive } = createArchive(root, metadata);

    const wrongVersion = run([
      'validate-archive',
      archive,
      metadata.project,
      metadata.volume,
      'v0.2.1',
      metadata.createdAt,
    ]);
    assert.notEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /version/);

    const wrongProject = run([
      'validate-archive',
      archive,
      'other-project',
      metadata.volume,
      metadata.version,
      metadata.createdAt,
    ]);
    assert.notEqual(wrongProject.status, 0);
    assert.match(wrongProject.stderr, /project/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
