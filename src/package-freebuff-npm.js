#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NPM_DIR = path.join(__dirname, '..', 'npm');
const METAPACKAGE = 'freebuff-gate';
const BINARY_FILE = 'freebuff-setup';
const VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)*$/;
// Mirrors the packager target matrix (src/package-freebuff-setup.js TARGETS).
const TARGETS = Object.freeze([
  Object.freeze({ target: 'linux-x64', package: 'freebuff-gate-linux-x64', binary: BINARY_FILE }),
  Object.freeze({ target: 'linux-arm64', package: 'freebuff-gate-linux-arm64', binary: BINARY_FILE }),
  Object.freeze({ target: 'darwin-x64', package: 'freebuff-gate-darwin-x64', binary: BINARY_FILE }),
  Object.freeze({ target: 'darwin-arm64', package: 'freebuff-gate-darwin-arm64', binary: BINARY_FILE }),
  Object.freeze({ target: 'windows-x64', package: 'freebuff-gate-windows-x64', binary: `${BINARY_FILE}.exe` }),
]);

function normalizeVersion(value) {
  let version = String(value ?? '').trim();
  if (!version) throw new Error('version is required');
  if (!version.startsWith('v')) version = `v${version}`;
  if (!VERSION_PATTERN.test(version)) throw new Error('version must look like v1.2.3');
  // npm semver has no leading "v".
  return version.slice(1);
}

function normalizeNpmTag(value) {
  const tag = String(value ?? 'latest').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag) || VERSION_PATTERN.test(`v${tag}`)) {
    throw new Error('npm tag must be a non-semver word');
  }
  return tag;
}

function readStub(packageName) {
  const file = path.join(NPM_DIR, packageName, 'package.json');
  if (!fs.existsSync(file)) throw new Error(`missing npm stub: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runCommand(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    cwd: options.cwd,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function artifactFileName(spec, version) {
  return `freebuff-setup-v${version}-${spec.target}${spec.binary === `${BINARY_FILE}.exe` ? '.exe' : ''}`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function artifactPath(artifactsDir, spec, version) {
  const file = artifactFileName(spec, version);
  const candidate = path.join(artifactsDir, file);
  if (!fs.existsSync(candidate)) throw new Error(`missing build artifact: ${candidate}`);
  return candidate;
}

/**
 * Verify every artifact against the sidecar SHA256SUMS before packing, so a
 * stale or corrupted binary (e.g. a pre-fix build left in dist/) can never
 * be published. Missing SHA256SUMS warns but does not block (prerelease
 * tolerance); a mismatch aborts.
 */
function verifyArtifacts(artifactsDir, version) {
  const sumsFile = path.join(artifactsDir, `freebuff-setup-v${version}-SHA256SUMS`);
  if (!fs.existsSync(sumsFile)) {
    console.warn(`WARNING: no ${path.basename(sumsFile)} in ${artifactsDir}; skipping checksum verification`);
    return;
  }
  const expected = new Map();
  for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
    const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    if (match) expected.set(match[2], match[1]);
  }
  for (const spec of TARGETS) {
    const file = artifactFileName(spec, version);
    const candidate = path.join(artifactsDir, file);
    if (!fs.existsSync(candidate)) throw new Error(`missing build artifact: ${candidate}`);
    const want = expected.get(file);
    if (!want) throw new Error(`${path.basename(sumsFile)} has no entry for ${file}`);
    const actual = sha256(candidate);
    if (actual !== want) {
      throw new Error(`checksum mismatch for ${file}: expected ${want}, got ${actual}`);
    }
  }
  console.log(`Verified ${TARGETS.length} artifacts against ${path.basename(sumsFile)}`);
}

function packPackage(dir, packDestination) {
  const result = runCommand('npm', ['pack', '--json', '--pack-destination', packDestination], { cwd: dir });
  const parsed = JSON.parse(result.stdout);
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || !record.filename) throw new Error(`npm pack returned no tarball for ${dir}`);
  return { name: record.name, version: record.version, tarball: path.join(packDestination, record.filename) };
}

function stagePlatformPackage({ spec, version, artifactsDir, stagingRoot }) {
  const dir = fs.mkdtempSync(path.join(stagingRoot, `${spec.package}-`));
  const stub = readStub(spec.package);
  stub.version = version;
  writeJson(path.join(dir, 'package.json'), stub);
  const source = artifactPath(artifactsDir, spec, version);
  const target = path.join(dir, spec.binary);
  fs.copyFileSync(source, target);
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows binaries do not need (or support) POSIX modes.
  }
  return dir;
}

function stageMetapackage({ version, stagingRoot }) {
  const dir = fs.mkdtempSync(path.join(stagingRoot, `${METAPACKAGE}-`));
  const stub = readStub(METAPACKAGE);
  stub.version = version;
  stub.optionalDependencies = Object.fromEntries(
    TARGETS.map((spec) => [spec.package, version]),
  );
  writeJson(path.join(dir, 'package.json'), stub);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(path.join(NPM_DIR, METAPACKAGE, 'bin', 'freebuff-setup.js'), path.join(dir, 'bin', 'freebuff-setup.js'));
  return dir;
}

/**
 * Pack (or publish) the six freebuff-gate packages for one version.
 * Platform packages are packed/published before the metapackage so a
 * consumer install can always resolve the optionalDependencies it pins.
 */
function distributeNpmPackages(options = {}) {
  const version = normalizeVersion(options.version);
  const artifactsDir = path.resolve(options.artifactsDir || path.join(__dirname, '..', 'dist', `freebuff-setup-v${version}`));
  const packDestination = path.resolve(options.packDestination || fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-gate-tarballs-')));
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-gate-staging-'));
  const publish = Boolean(options.publish);
  const npmTag = normalizeNpmTag(options.npmTag);
  const records = [];
  try {
    verifyArtifacts(artifactsDir, version);
    fs.mkdirSync(packDestination, { recursive: true });
    for (const spec of TARGETS) {
      const dir = stagePlatformPackage({ spec, version, artifactsDir, stagingRoot });
      if (publish) runCommand('npm', ['publish', '--tag', npmTag], { cwd: dir });
      records.push({ package: spec.package, ...packPackage(dir, packDestination) });
    }
    const metaDir = stageMetapackage({ version, stagingRoot });
    if (publish) runCommand('npm', ['publish', '--tag', npmTag], { cwd: metaDir });
    records.push({ package: METAPACKAGE, ...packPackage(metaDir, packDestination) });
    return { version, publish, npmTag, records };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function usage() {
  console.log(`Package freebuff-gate npm distribution

Usage:
  node src/package-freebuff-npm.js --version v0.2.0 [--publish] [--artifacts-dir <dir>]

Options:
  --version <v>        Release version (v1.2.3; leading v optional)
  --publish            npm publish each package (default: npm pack only)
  --npm-tag <tag>      npm dist-tag for published packages (default: latest)
  --artifacts-dir <d>  Directory with the built freebuff-setup binaries
                       (default: dist/freebuff-setup-v<version>)
  --pack-destination <d> Where npm pack writes tarballs (default: temp dir)
  --help               Show this help`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--version': options.version = next(); break;
      case '--artifacts-dir': options.artifactsDir = next(); break;
      case '--pack-destination': options.packDestination = next(); break;
      case '--publish': options.publish = true; break;
      case '--npm-tag': options.npmTag = next(); break;
      case '--help': options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) usage();
    else console.log(JSON.stringify(distributeNpmPackages(options), null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BINARY_FILE,
  METAPACKAGE,
  NPM_DIR,
  TARGETS,
  VERSION_PATTERN,
  artifactFileName,
  artifactPath,
  distributeNpmPackages,
  normalizeNpmTag,
  normalizeVersion,
  packPackage,
  parseArgs,
  readStub,
  runCommand,
  sha256,
  stageMetapackage,
  stagePlatformPackage,
  verifyArtifacts,
  writeJson,
};
