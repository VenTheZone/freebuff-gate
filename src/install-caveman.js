#!/usr/bin/env node
/**
 * Install the project-scoped Caveman profile for Freebuff Desktop and CLI.
 *
 * Freebuff reads AGENTS.md instruction files. The same file is used by both
 * products, so no binary patch or provider proxy is required for the concise
 * communication layer.
 *
 * Usage:
 *   node src/install-caveman.js                 # update ./AGENTS.md
 *   node src/install-caveman.js --global        # update ~/.AGENTS.md
 *   node src/install-caveman.js --dry-run      # show target and change only
 *   node src/install-caveman.js --global --remove
 *   node src/install-caveman.js --file path/to/AGENTS.md
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const START = "<!-- freebuff-caveman:start -->";
const END = "<!-- freebuff-caveman:end -->";

function usage() {
  console.log(`Usage: node src/install-caveman.js [options]

Options:
  --global          target ~/.AGENTS.md instead of ./AGENTS.md
  --file <path>     target an explicit AGENTS.md path
  --remove          remove the managed Caveman block
  --dry-run         report the change without writing
  --help            show this help`);
}

function parseArgs(argv) {
  const options = {
    target: null,
    remove: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--global":
        if (options.target) throw new Error("--global and --file cannot be combined");
        options.target = path.join(os.homedir(), ".AGENTS.md");
        break;
      case "--file": {
        if (options.target) throw new Error("--global and --file cannot be combined");
        const value = argv[++i];
        if (!value) throw new Error("--file needs a path");
        options.target = path.resolve(value);
        break;
      }
      case "--remove":
        options.remove = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${argv[i]}`);
    }
  }

  options.target ??= path.resolve("AGENTS.md");
  return options;
}

function readManagedBlock() {
  const sourcePath = path.join(__dirname, "..", "AGENTS.md");
  const source = fs.readFileSync(sourcePath, "utf8");
  const start = source.indexOf(START);
  const end = source.indexOf(END, start + START.length);
  if (start === -1 || end === -1) {
    throw new Error(`Managed Caveman block missing from ${sourcePath}`);
  }
  return source.slice(start, end + END.length).trim();
}

function replaceManagedBlock(document, block) {
  const pattern = new RegExp(
    `${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`,
  );
  if (pattern.test(document)) {
    return document.replace(pattern, block).replace(/\n{3,}/g, "\n\n");
  }

  const base = document.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

function removeManagedBlock(document) {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\n?`,
  );
  return document.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trimEnd() + (document.trim() ? "\n" : "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeAtomically(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, content, "utf8");
    fs.renameSync(temp, target);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const block = readManagedBlock();
  const existed = fs.existsSync(options.target);
  const current = existed ? fs.readFileSync(options.target, "utf8") : "";
  const next = options.remove
    ? removeManagedBlock(current)
    : replaceManagedBlock(current, block);
  const changed = next !== current;

  console.log(`${options.remove ? "Remove" : "Install"} Caveman profile`);
  console.log(`Target: ${options.target}`);
  console.log(`Status: ${changed ? "would change" : "already current"}`);

  if (options.target === path.join(os.homedir(), ".AGENTS.md")) {
    const higherPriorityFile = path.join(os.homedir(), ".knowledge.md");
    if (fs.existsSync(higherPriorityFile)) {
      console.warn(`Warning: ${higherPriorityFile} takes precedence over ~/.AGENTS.md.`);
    }
  }

  if (changed && !options.dryRun) {
    writeAtomically(options.target, next);
    console.log("Written. Restart Freebuff Desktop/CLI sessions to reload instructions.");
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
