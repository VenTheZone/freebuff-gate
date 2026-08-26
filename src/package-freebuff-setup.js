#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SEA_ASSETS } = require('./freebuff-setup-sea-entry');

const BINARY_NAME = 'freebuff-setup';
const POSTJECT_VERSION = '1.0.0-alpha.6';
const SEA_SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const TARGETS = Object.freeze({
  'linux-x64': Object.freeze({ platform: 'linux', arch: 'x64', extension: '' }),
  'linux-arm64': Object.freeze({ platform: 'linux', arch: 'arm64', extension: '' }),
  'darwin-x64': Object.freeze({ platform: 'darwin', arch: 'x64', extension: '' }),
  'darwin-arm64': Object.freeze({ platform: 'darwin', arch: 'arm64', extension: '' }),
  'windows-x64': Object.freeze({ platform: 'win32', arch: 'x64', extension: '.exe' }),
});
const VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)*$/;

function normalizeVersion(value) {
  let version = String(value ?? '').trim();
  if (!version) throw new Error('version is required');
  if (!version.startsWith('v')) version = `v${version}`;
  if (!VERSION_PATTERN.test(version)) throw new Error('version must look like v1.2.3');
  return version;
}

function targetFor(target) {
  const value = TARGETS[target];
  if (!value) throw new Error(`unsupported setup binary target: ${target}`);
  return value;
}

function artifactName(version, target) {
  const normalized = normalizeVersion(version);
  const spec = targetFor(target);
  return `${BINARY_NAME}-${normalized}-${target}${spec.extension}`;
}

function renderSeaConfig({ main, output, sourceDir, version }) {
  const assets = Object.fromEntries([
    ...SEA_ASSETS.map((name) => [name, path.join(sourceDir, name)]),
  ]);
  return {
    main: path.resolve(main),
    output: path.resolve(output),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets,
  };
}

function runCommand(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeReleaseMetadata({ version, outputDir, artifacts }) {
  const normalized = normalizeVersion(version);
  const directory = path.resolve(outputDir);
  fs.mkdirSync(directory, { recursive: true });
  const records = artifacts.map(({ target, artifact }) => {
    targetFor(target);
    const file = path.resolve(artifact);
    const stat = fs.statSync(file);
    return {
      target,
      assetName: path.basename(file),
      bytes: stat.size,
      sha256: sha256File(file),
    };
  });
  const manifestName = `${BINARY_NAME}-${normalized}-manifest.json`;
  const checksumName = `${BINARY_NAME}-${normalized}-SHA256SUMS`;
  const manifestContent = `${JSON.stringify({
    schemaVersion: 1,
    product: BINARY_NAME,
    version: normalized,
    artifacts: records,
  }, null, 2)}\n`;
  const manifestFile = path.join(directory, manifestName);
  fs.writeFileSync(manifestFile, manifestContent);
  const checksumEntries = [
    { name: manifestName, hash: crypto.createHash('sha256').update(manifestContent).digest('hex') },
    ...records.map((record) => ({ name: record.assetName, hash: record.sha256 })),
  ];
  const checksumFile = path.join(directory, checksumName);
  fs.writeFileSync(checksumFile, `${checksumEntries.map(({ hash, name }) => `${hash}  ${name}`).join('\n')}\n`);
  return { version: normalized, manifest: manifestFile, checksums: checksumFile, records };
}

function writeReleaseMetadataFromDirectory({ version, outputDir }) {
  const normalized = normalizeVersion(version);
  const directory = path.resolve(outputDir);
  const artifacts = Object.keys(TARGETS)
    .map((target) => {
      const file = path.join(directory, artifactName(normalized, target));
      return fs.existsSync(file) ? { target, artifact: file } : null;
    })
    .filter(Boolean);
  if (artifacts.length === 0) throw new Error(`no setup binaries found in ${directory}`);
  return writeReleaseMetadata({ version: normalized, outputDir: directory, artifacts });
}

function copyAssets(sourceDir, stagingDir, version) {
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  for (const name of SEA_ASSETS) {
    const target = path.join(stagingDir, name);
    if (name === 'freebuff-setup.version') {
      fs.writeFileSync(target, `${normalizeVersion(version)}\n`, { mode: 0o600 });
      continue;
    }
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) throw new Error(`missing SEA asset: ${source}`);
    fs.copyFileSync(source, target);
  }
}

function injectArgs(target, artifact, blob) {
  const args = [
    '--yes',
    `postject@${POSTJECT_VERSION}`,
    artifact,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    SEA_SENTINEL,
  ];
  if (target.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  return args;
}

function buildBinary(options = {}) {
  const version = normalizeVersion(options.version);
  const targetId = options.target || `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const target = targetFor(targetId);
  const sourceDir = path.resolve(options.sourceDir || __dirname);
  const outputDir = path.resolve(options.outputDir || path.join(sourceDir, '..', 'dist', `freebuff-setup-${version}`));
  const nodeBinary = options.nodeBinary || process.execPath;
  const hostNodeBinary = options.hostNodeBinary || process.execPath;
  const command = options.runCommand || runCommand;
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-setup-sea-'));
  const configFile = path.join(stagingDir, 'sea-config.json');
  const blobFile = path.join(stagingDir, 'sea-prep.blob');
  const artifact = path.join(outputDir, artifactName(version, targetId));
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    copyAssets(sourceDir, stagingDir, version);
    const config = renderSeaConfig({
      main: path.join(sourceDir, 'freebuff-setup-sea-entry.js'),
      output: blobFile,
      sourceDir: stagingDir,
      version,
    });
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    command(hostNodeBinary, ['--experimental-sea-config', configFile], { stdio: 'pipe' });
    fs.copyFileSync(nodeBinary, artifact);
    try { fs.chmodSync(artifact, 0o755); } catch {}
    // Cross-builds on non-macOS hosts cannot run codesign. Native macOS
    // builds still strip Node's existing signature before postject injection.
    if (target.platform === 'darwin' && process.platform === 'darwin' && options.removeSignature !== false) {
      command('codesign', ['--remove-signature', artifact], { stdio: 'pipe' });
    }
    // On Windows the npx shim is npx.cmd, which spawnSync cannot launch
    // directly (EINVAL) — it must run through the shell (cmd.exe). Use the
    // shell for the postject step so npx.cmd resolves on win32.
    const postjectCmd = options.postjectCommand || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
    command(postjectCmd, injectArgs(target, artifact, blobFile), { stdio: 'pipe', shell: true });
    return { version, target: targetId, artifact };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function usage() {
  console.log(`Package Freebuff Setup binary

Usage:
  node src/package-freebuff-setup.js --version v0.2.0 --target linux-x64

Options:
  --version <v>       Version (v1.2.3; leading v optional)
  --target <target>   linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
  --output <dir>      Output directory
  --source-dir <dir>  Source directory (default: src)
  --node-binary <p>   Node binary for target
  --host-node-binary <p> Host Node binary used to prepare the SEA blob
  --postject <p>      Postject command (default: npx postject@${POSTJECT_VERSION})
  --metadata           Write manifest/checksums for binaries already in --output
  --help              Show this help`);
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
      case '--target': options.target = next(); break;
      case '--output': options.outputDir = next(); break;
      case '--source-dir': options.sourceDir = next(); break;
      case '--node-binary': options.nodeBinary = next(); break;
      case '--host-node-binary': options.hostNodeBinary = next(); break;
      case '--postject': options.postjectCommand = next(); break;
      case '--metadata': options.metadata = true; break;
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
    else if (options.metadata) console.log(JSON.stringify(writeReleaseMetadataFromDirectory(options), null, 2));
    else console.log(JSON.stringify(buildBinary(options), null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BINARY_NAME,
  POSTJECT_VERSION,
  SEA_ASSETS,
  SEA_SENTINEL,
  TARGETS,
  artifactName,
  buildBinary,
  injectArgs,
  normalizeVersion,
  parseArgs,
  renderSeaConfig,
  runCommand,
  sha256File,
  targetFor,
  writeReleaseMetadata,
  writeReleaseMetadataFromDirectory,
};
