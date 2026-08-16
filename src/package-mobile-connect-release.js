'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PRODUCT_NAME = 'freebuff-mobile-connect';
const DEFAULT_REPOSITORY = 'VenTheZone/freebuff-gate';
const RELEASE_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)*$/;
const RELEASE_FILES = Object.freeze([
  'install-mobile-connect.js',
  'mobile-connect-agent.js',
  'mobile-connect-protocol.js',
  'mobile-connect-qr.js',
]);

function normalizeReleaseVersion(value) {
  let version = String(value ?? '').trim();
  if (!version) throw new Error('--version is required');
  if (!version.startsWith('v')) version = `v${version}`;
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error('--version must look like v1.2.3');
  }
  return version;
}

function defaultReleaseBaseUrl(version, repository = DEFAULT_REPOSITORY) {
  return `https://github.com/${repository}/releases/download/${version}`;
}

function validateReleaseBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('--release-base-url must be a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('--release-base-url must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('--release-base-url must not contain credentials');
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function assetName(version, logicalName) {
  if (!RELEASE_FILES.includes(logicalName)) throw new Error(`Unsupported release file: ${logicalName}`);
  return `${PRODUCT_NAME}-${version}-${logicalName}`;
}

function manifestName(version) {
  return `${PRODUCT_NAME}-${version}-manifest.json`;
}

function checksumName(version) {
  return `${PRODUCT_NAME}-${version}-SHA256SUMS`;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeFile(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  try { fs.chmodSync(file, mode); } catch {}
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function renderBootstrap(source, version, releaseBaseUrl) {
  const withVersion = source.replace(
    /^DEFAULT_VERSION=.*$/m,
    `DEFAULT_VERSION=${shellSingleQuote(version)}`,
  );
  const rendered = withVersion.replace(
    /^DEFAULT_RELEASE_BASE_URL=.*$/m,
    `DEFAULT_RELEASE_BASE_URL=${shellSingleQuote(releaseBaseUrl)}`,
  );
  if (!rendered.includes(`DEFAULT_VERSION=${shellSingleQuote(version)}`)) {
    throw new Error('Bootstrap template is missing DEFAULT_VERSION marker');
  }
  if (!rendered.includes(`DEFAULT_RELEASE_BASE_URL=${shellSingleQuote(releaseBaseUrl)}`)) {
    throw new Error('Bootstrap template is missing DEFAULT_RELEASE_BASE_URL marker');
  }
  return rendered;
}

function ensureEmptyOrManagedDirectory(directory, force) {
  if (!fs.existsSync(directory)) return;
  const entries = fs.readdirSync(directory);
  if (entries.length > 0 && !force) {
    throw new Error(`Output directory is not empty; use --force: ${directory}`);
  }
}

function createArchive(outputDir, archivePath) {
  const absoluteOutput = path.resolve(outputDir);
  const absoluteArchive = path.resolve(archivePath);
  fs.mkdirSync(path.dirname(absoluteArchive), { recursive: true });
  const result = childProcess.spawnSync(
    'tar',
    ['-czf', absoluteArchive, '-C', path.dirname(absoluteOutput), path.basename(absoluteOutput)],
    { encoding: 'utf8' },
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error('tar is required when --archive is used');
  }
  if (result.status !== 0) {
    throw new Error(`tar failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return absoluteArchive;
}

function packageRelease(options = {}) {
  const version = normalizeReleaseVersion(options.version);
  const sourceDir = path.resolve(options.sourceDir || path.join(__dirname));
  const bootstrapSourceFile = path.resolve(
    options.bootstrapSource || path.join(sourceDir, '..', 'install-mobile-connect.sh'),
  );
  const outputDir = path.resolve(
    options.outputDir || path.join(sourceDir, '..', 'dist', `${PRODUCT_NAME}-${version}`),
  );
  const releaseBaseUrl = validateReleaseBaseUrl(
    options.releaseBaseUrl || defaultReleaseBaseUrl(version, options.repository || DEFAULT_REPOSITORY),
  );

  ensureEmptyOrManagedDirectory(outputDir, Boolean(options.force));
  fs.mkdirSync(outputDir, { recursive: true });
  const bootstrapSource = fs.readFileSync(bootstrapSourceFile, 'utf8');
  const bootstrap = renderBootstrap(bootstrapSource, version, releaseBaseUrl);
  const records = [];

  for (const logicalName of RELEASE_FILES) {
    const sourceFile = path.join(sourceDir, logicalName);
    if (!fs.existsSync(sourceFile)) throw new Error(`Missing release source file: ${sourceFile}`);
    const content = fs.readFileSync(sourceFile);
    const remoteName = assetName(version, logicalName);
    const target = path.join(outputDir, remoteName);
    fs.writeFileSync(target, content, { mode: 0o644 });
    records.push({
      logicalName,
      assetName: remoteName,
      bytes: content.length,
      sha256: sha256(content),
    });
  }

  const manifest = {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    version,
    requiredNodeMajor: 22,
    bootstrapAsset: 'install-mobile-connect.sh',
    files: records,
  };
  const manifestFileName = manifestName(version);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFile(path.join(outputDir, manifestFileName), manifestContent);

  const checksumEntries = [
    { name: manifestFileName, content: Buffer.from(manifestContent) },
    ...records.map((record) => ({
      name: record.assetName,
      content: fs.readFileSync(path.join(outputDir, record.assetName)),
    })),
  ];
  const checksums = `${checksumEntries.map((entry) => `${sha256(entry.content)}  ${entry.name}`).join('\n')}\n`;
  const checksumFileName = checksumName(version);
  writeFile(path.join(outputDir, checksumFileName), checksums);
  writeFile(path.join(outputDir, 'install-mobile-connect.sh'), bootstrap, 0o755);

  let archive = null;
  if (options.archive) {
    archive = createArchive(
      outputDir,
      options.archivePath || path.join(path.dirname(outputDir), `${path.basename(outputDir)}.tar.gz`),
    );
  }

  return {
    version,
    outputDir,
    releaseBaseUrl,
    manifest: path.join(outputDir, manifestFileName),
    checksums: path.join(outputDir, checksumFileName),
    bootstrap: path.join(outputDir, 'install-mobile-connect.sh'),
    assets: records.map((record) => path.join(outputDir, record.assetName)),
    archive,
  };
}

function usage() {
  console.log(`Package Freebuff Desktop mobile-connect release assets

Usage:
  node src/package-mobile-connect-release.js --version v0.1.0 [options]

Options:
  --version <v>              Release tag (v1.2.3; leading v is optional)
  --output <directory>      Output directory (default: dist/${PRODUCT_NAME}-<version>)
  --source-dir <directory>  Source directory (default: src)
  --release-base-url <url>  HTTPS URL used by generated bootstrap
  --archive                 Also create a .tar.gz archive (requires tar)
  --archive-path <file>     Archive destination
  --force                   Allow a non-empty output directory
  --help                    Show this help

Output includes versioned JavaScript assets, JSON manifest, SHA-256 sidecar,
and a version-pinned install-mobile-connect.sh bootstrap.`);
}

function parseArgs(argv) {
  const options = { archive: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--version': options.version = next(); break;
      case '--output': options.outputDir = next(); break;
      case '--source-dir': options.sourceDir = next(); break;
      case '--release-base-url': options.releaseBaseUrl = next(); break;
      case '--archive': options.archive = true; break;
      case '--archive-path': options.archivePath = next(); options.archive = true; break;
      case '--force': options.force = true; break;
      case '--help':
      case '-h':
        usage();
        return { help: true };
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return 0;
  const result = packageRelease(options);
  console.log(`Packaged ${result.version}`);
  console.log(`Directory: ${result.outputDir}`);
  if (result.archive) console.log(`Archive: ${result.archive}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_REPOSITORY,
  PRODUCT_NAME,
  RELEASE_FILES,
  assetName,
  checksumName,
  defaultReleaseBaseUrl,
  manifestName,
  normalizeReleaseVersion,
  packageRelease,
  parseArgs,
  renderBootstrap,
  sha256,
  validateReleaseBaseUrl,
};
