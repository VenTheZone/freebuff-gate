'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { checkFile } = require('./check-doc-links');

test('checks local files and Markdown heading anchors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-doc-links-'));
  try {
    fs.writeFileSync(path.join(root, 'target.md'), '# Target page\n');
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, '[target](target.md#target-page)\n');
    assert.deepEqual(checkFile(source), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports missing files and anchors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-doc-links-'));
  try {
    fs.writeFileSync(path.join(root, 'target.md'), '# Existing heading\n');
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, '[missing](missing.md)\n[bad anchor](target.md#missing)\n');
    const errors = checkFile(source);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /missing target missing\.md/);
    assert.match(errors[1], /missing anchor target\.md#missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignores external links and links inside fenced code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-doc-links-'));
  try {
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, [
      '[external](https://example.com/missing)',
      '',
      '```text',
      '[fenced](missing.md)',
      '```',
      '',
    ].join('\n'));
    assert.deepEqual(checkFile(source), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
