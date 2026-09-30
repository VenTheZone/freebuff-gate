'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RELEASE_FILES,
  assetName,
  packageRelease,
  sha256,
} = require('./package-mobile-connect-release');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-mobile-release-'));
}

test('release package contains pinned versioned files and verifiable checksums', () => {
  const root = tempRoot();
  try {
    const outputDir = path.join(root, 'freebuff-mobile-connect-v2.3.4');
    const result = packageRelease({
      version: '2.3.4',
      sourceDir: __dirname,
      bootstrapSource: path.join(__dirname, '..', 'install-mobile-connect.sh'),
      outputDir,
      archive: true,
    });

    assert.equal(result.version, 'v2.3.4');
    assert.equal(fs.existsSync(result.archive), true);
    assert.equal(fs.existsSync(result.bootstrap), true);
    if (process.platform !== 'win32') {
      // Unix permission bits are not tracked by NTFS/FAT.
      assert.equal(fs.statSync(result.bootstrap).mode & 0o111, 0o111);
    }

    const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
    assert.equal(manifest.product, 'freebuff-mobile-connect');
    assert.equal(manifest.version, 'v2.3.4');
    assert.equal(manifest.requiredNodeMajor, 22);
    assert.deepEqual(
      manifest.files.map((file) => file.logicalName),
      [...RELEASE_FILES],
    );

    for (const file of manifest.files) {
      const target = path.join(outputDir, file.assetName);
      assert.equal(file.assetName, assetName('v2.3.4', file.logicalName));
      assert.equal(fs.existsSync(target), true);
      const content = fs.readFileSync(target);
      assert.equal(file.bytes, content.length);
      assert.equal(file.sha256, sha256(content));
      if (file.logicalName.endsWith('.js')) {
        childProcess.execFileSync(process.execPath, ['--check', target]);
      }
    }

    const checksums = fs.readFileSync(result.checksums, 'utf8').trim().split('\n');
    assert.equal(checksums.length, RELEASE_FILES.length + 1);
    for (const line of checksums) {
      const [checksum, file] = line.split(/\s{2}/);
      assert.match(checksum, /^[a-f0-9]{64}$/);
      assert.equal(checksum, sha256(fs.readFileSync(path.join(outputDir, file))));
    }

    const bootstrap = fs.readFileSync(result.bootstrap, 'utf8');
    assert.match(bootstrap, /DEFAULT_VERSION='v2\.3\.4'/);
    assert.match(bootstrap, /releases\/download\/v2\.3\.4/);
    childProcess.execFileSync('bash', ['-n', result.bootstrap]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every local module a shipped file requires is shipped too', () => {
  const { SEA_ASSETS } = require('./freebuff-setup-sea-entry');
  for (const [label, shipped] of [['release', RELEASE_FILES], ['setup binary', SEA_ASSETS]]) {
    for (const name of shipped.filter((file) => file.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      for (const match of source.matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) {
        assert.ok(shipped.includes(`${match[1]}.js`), `${label}: ${name} requires ./${match[1]} but it is not shipped`);
      }
    }
  }
});

test('packaged bootstrap downloads, verifies and launches the whole release', { skip: process.platform === 'win32' }, () => {
  const root = tempRoot();
  try {
    const outputDir = path.join(root, 'release');
    packageRelease({
      version: '2.3.4',
      sourceDir: __dirname,
      bootstrapSource: path.join(__dirname, '..', 'install-mobile-connect.sh'),
      outputDir,
    });
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      'out=""; url=""',
      'while (($#)); do case "$1" in --output) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done',
      `f=${JSON.stringify(outputDir)}/"\${url##*/}"`,
      '[[ -f "$f" ]] || exit 22',
      'if [[ -n "$out" ]]; then cp "$f" "$out"; else cat "$f"; fi',
    ].join('\n'), { mode: 0o755 });
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const output = childProcess.execFileSync('bash', [path.join(outputDir, 'install-mobile-connect.sh'), '--skip-checks', '--dry-run'], {
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
      encoding: 'utf8',
    });
    assert.match(output, /Launching verified installer/);
    for (const name of RELEASE_FILES) assert.match(output, new RegExp(`v2\\.3\\.4-${name.replace(/\./g, '\\.')}: OK`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release package refuses unsafe or incomplete output inputs', () => {
  assert.throws(
    () => packageRelease({
      version: 'main',
      sourceDir: __dirname,
      bootstrapSource: path.join(__dirname, '..', 'install-mobile-connect.sh'),
      outputDir: path.join(tempRoot(), 'release'),
    }),
    /--version must look like v1\.2\.3/,
  );

  const root = tempRoot();
  const outputDir = path.join(root, 'release');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'unmanaged.txt'), 'keep me');
  try {
    assert.throws(
      () => packageRelease({
        version: 'v2.3.4',
        sourceDir: __dirname,
        bootstrapSource: path.join(__dirname, '..', 'install-mobile-connect.sh'),
        outputDir,
      }),
      /Output directory is not empty/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
