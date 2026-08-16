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
    assert.equal(fs.statSync(result.bootstrap).mode & 0o111, 0o111);

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
