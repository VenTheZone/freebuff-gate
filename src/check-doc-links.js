'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target']);

function collectMarkdownFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectMarkdownFiles(entryPath, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(entryPath);
  }
  return files;
}

function markdownFiles() {
  const files = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const entryPath = path.join(ROOT, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'docs' || entry.name === 'docker') collectMarkdownFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.toLowerCase() === 'readme.md') {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function withoutFencedCode(markdown) {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

function splitTarget(target) {
  const queryIndex = target.indexOf('?');
  const fragmentIndex = target.indexOf('#');
  let end = target.length;
  if (queryIndex >= 0) end = Math.min(end, queryIndex);
  if (fragmentIndex >= 0) end = Math.min(end, fragmentIndex);
  return {
    path: target.slice(0, end),
    fragment: fragmentIndex >= 0 ? target.slice(fragmentIndex + 1).split('?')[0] : '',
  };
}

function isExternal(target) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

function githubSlug(text) {
  return text
    .replace(/[`*_~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function headingFragments(markdown) {
  const fragments = new Set();
  const counts = new Map();
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = githubSlug(match[1]);
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    fragments.add(count ? `${base}-${count}` : base);
  }
  for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/g)) fragments.add(match[1]);
  return fragments;
}

function checkFile(file) {
  const markdown = fs.readFileSync(file, 'utf8');
  const scanText = withoutFencedCode(markdown);
  const errors = [];
  for (const match of scanText.matchAll(MARKDOWN_LINK)) {
    const target = match[1] || match[2];
    if (!target || isExternal(target)) continue;
    const { path: targetPath, fragment } = splitTarget(decodeURIComponent(target));
    const resolved = targetPath
      ? targetPath.startsWith('/')
        ? path.resolve(ROOT, `.${targetPath}`)
        : path.resolve(path.dirname(file), targetPath)
      : file;
    const relativeSource = path.relative(ROOT, file) || path.basename(file);
    const line = scanText.slice(0, match.index).split('\n').length;
    if (!fs.existsSync(resolved)) {
      errors.push(`${relativeSource}:${line}: missing target ${target}`);
      continue;
    }
    if (fragment && fs.statSync(resolved).isFile() && resolved.toLowerCase().endsWith('.md')) {
      const fragments = headingFragments(fs.readFileSync(resolved, 'utf8'));
      if (!fragments.has(fragment)) {
        errors.push(`${relativeSource}:${line}: missing anchor ${target}`);
      }
    }
  }
  return errors;
}

function checkLinks() {
  const errors = markdownFiles().flatMap(checkFile);
  if (errors.length) {
    console.error(errors.join('\n'));
    return false;
  }
  console.log(`Checked local Markdown links in ${markdownFiles().length} files.`);
  return true;
}

if (require.main === module && !checkLinks()) process.exitCode = 1;

module.exports = {
  checkFile,
  checkLinks,
  collectMarkdownFiles,
  githubSlug,
  headingFragments,
  markdownFiles,
  splitTarget,
  withoutFencedCode,
};
