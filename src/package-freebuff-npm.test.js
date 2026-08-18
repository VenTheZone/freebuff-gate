'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  METAPACKAGE,
  NPM_DIR,
  TARGETS,
  artifactFileName,
  distributeNpmPackages,
  normalizeNpmTag,
  normalizeVersion,
  parseArgs,
  sha256,
  verifyArtifacts,
} = require('./package-freebuff-npm');

function runCommand(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fakeArtifacts(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-gate-artifacts-'));
  for (const spec of TARGETS) {
    const name = `freebuff-setup-v${version}-${spec.target}${spec.binary === 'freebuff-setup.exe' ? '.exe' : ''}`;
    fs.writeFileSync(path.join(dir, name), `fake-binary:${spec.target}`);
  }
  return dir;
}

function tarPackageJson(tarball) {
  return JSON.parse(runCommand('tar', ['-xOf', tarball, 'package/package.json']));
}

function tarEntries(tarball) {
  return runCommand('tar', ['-tf', tarball]).split('\n').filter(Boolean);
}

test('npm stubs carry expected names, os/cpu fields, main, and bin wiring', () => {
  for (const spec of TARGETS) {
    const stub = JSON.parse(fs.readFileSync(path.join(NPM_DIR, spec.package, 'package.json'), 'utf8'));
    assert.equal(stub.name, spec.package);
    assert.equal(stub.main, spec.binary);
    assert.ok(Array.isArray(stub.os) && stub.os.length === 1, `${spec.package} needs os field`);
    assert.ok(Array.isArray(stub.cpu) && stub.cpu.length === 1, `${spec.package} needs cpu field`);
    assert.equal(stub.version, '0.0.0', 'stubs start at placeholder version');
  }
  const meta = JSON.parse(fs.readFileSync(path.join(NPM_DIR, METAPACKAGE, 'package.json'), 'utf8'));
  assert.equal(meta.name, METAPACKAGE);
  assert.equal(meta.bin['freebuff-setup'], 'bin/freebuff-setup.js');
  for (const spec of TARGETS) {
    assert.equal(meta.optionalDependencies[spec.package], '0.0.0');
  }
});

test('distributeNpmPackages stamps versions and packs six tarballs with the right binaries', () => {
  const version = '1.2.3';
  const artifactsDir = fakeArtifacts(version);
  const packDestination = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-gate-pack-'));
  try {
    const result = distributeNpmPackages({ version: `v${version}`, artifactsDir, packDestination });
    assert.equal(result.version, version);
    assert.equal(result.records.length, TARGETS.length + 1);
    const byName = Object.fromEntries(result.records.map((record) => [record.package, record]));
    for (const spec of TARGETS) {
      const record = byName[spec.package];
      assert.ok(record, `missing tarball for ${spec.package}`);
      assert.ok(fs.existsSync(record.tarball), `tarball missing: ${record.tarball}`);
      const pkg = tarPackageJson(record.tarball);
      assert.equal(pkg.version, version);
      assert.equal(pkg.name, spec.package);
      const entries = tarEntries(record.tarball);
      assert.ok(entries.includes(`package/${spec.binary}`), `${spec.package} tarball must embed ${spec.binary}`);
    }
    const meta = byName[METAPACKAGE];
    const metaPkg = tarPackageJson(meta.tarball);
    assert.equal(metaPkg.version, version);
    for (const spec of TARGETS) {
      assert.equal(metaPkg.optionalDependencies[spec.package], version);
    }
    const metaEntries = tarEntries(meta.tarball);
    assert.ok(metaEntries.includes('package/bin/freebuff-setup.js'), 'metapackage tarball must embed the launcher');
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    fs.rmSync(packDestination, { recursive: true, force: true });
  }
});

test('packager validates versions and missing artifacts', () => {
  assert.equal(normalizeVersion('v0.2.0'), '0.2.0');
  assert.equal(normalizeVersion('0.2.0'), '0.2.0');
  assert.throws(() => normalizeVersion('banana'), /version must look like/);
  assert.throws(() => normalizeVersion(''), /version is required/);

  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-gate-empty-'));
  try {
    assert.throws(
      () => distributeNpmPackages({ version: 'v1.2.3', artifactsDir }),
      /missing build artifact/,
    );
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('verifyArtifacts guards against stale or corrupted binaries', () => {
  const version = '9.9.9';
  const dir = fakeArtifacts(version);
  try {
    // No SHA256SUMS -> warn, do not block.
    verifyArtifacts(dir, version);

    // Correct sidecar -> verifies clean.
    const sums = TARGETS.map((spec) => {
      const file = artifactFileName(spec, version);
      return `${sha256(path.join(dir, file))}  ${file}`;
    }).join('\n');
    fs.writeFileSync(path.join(dir, `freebuff-setup-v${version}-SHA256SUMS`), `${sums}\n`);
    verifyArtifacts(dir, version);

    // Corrupted binary -> aborts.
    fs.writeFileSync(path.join(dir, artifactFileName(TARGETS[0], version)), 'tampered');
    assert.throws(
      () => verifyArtifacts(dir, version),
      /checksum mismatch/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm publish tags and parseArgs handle prerelease options', () => {
  assert.equal(normalizeNpmTag('next'), 'next');
  assert.equal(normalizeNpmTag(undefined), 'latest');
  assert.throws(() => normalizeNpmTag('1.2.3'), /npm tag must be/);
  assert.deepEqual(parseArgs(['--version', 'v0.2.0', '--publish', '--npm-tag', 'next']), {
    version: 'v0.2.0',
    publish: true,
    npmTag: 'next',
  });
});

test('parseArgs handles flags and unknown options', () => {
  assert.deepEqual(parseArgs(['--version', 'v0.2.0', '--publish']), {
    version: 'v0.2.0',
    publish: true,
  });
  assert.deepEqual(parseArgs(['--version', 'v0.2.0', '--artifacts-dir', 'x', '--pack-destination', 'y']), {
    version: 'v0.2.0',
    artifactsDir: 'x',
    packDestination: 'y',
  });
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['--version']), /needs a value/);
});
