'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildSkillSystemPrompt,
  discoverSkills,
} = require('./freebuff-skill-loader');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-skills-conflict-'));
}

function writeSkill(dir, name, description = `Description of ${name}.`) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    `Body of ${name}.`,
  ].join('\n'));
  return skillDir;
}

test('project skill beats same-named home skill (closer to project wins)', () => {
  const root = tempRoot();
  try {
    const project = path.join(root, 'proj');
    const home = path.join(root, 'home');
    fs.mkdirSync(project, { recursive: true });
    writeSkill(path.join(project, '.agents', 'skills'), 'ship-safe', 'Project ship-safe');
    writeSkill(path.join(home, '.agents', 'skills'), 'ship-safe', 'Home ship-safe');

    const skills = discoverSkills({ cwd: project, home });
    const ship = skills.find((s) => s.name === 'ship-safe');
    assert.ok(ship, 'ship-safe discovered');
    assert.equal(ship.description, 'Project ship-safe');
    assert.match(ship.file, /proj/, 'winner comes from project dir');
    assert.equal(skills.filter((s) => s.name === 'ship-safe').length, 1, 'deduped by name');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project .pi skill beats home .pi agent skill and project .agents skill', () => {
  const root = tempRoot();
  try {
    const project = path.join(root, 'proj');
    const home = path.join(root, 'home');
    fs.mkdirSync(project, { recursive: true });
    writeSkill(path.join(project, '.pi', 'skills'), 'simplify', 'Pi project simplify');
    writeSkill(path.join(project, '.agents', 'skills'), 'simplify', 'Agents project simplify');
    writeSkill(path.join(home, '.pi', 'agent', 'skills'), 'simplify', 'Pi home simplify');

    const skills = discoverSkills({
      cwd: project,
      home,
      agentDir: path.join(home, '.pi', 'agent'),
    });
    const simplify = skills.find((s) => s.name === 'simplify');
    assert.ok(simplify, 'simplify discovered');
    assert.equal(simplify.description, 'Pi project simplify');
    assert.match(simplify.file, /proj.*\.pi/, 'project .pi wins');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('user skill shadows a Freebuff managed built-in name', () => {
  const root = tempRoot();
  try {
    const project = path.join(root, 'proj');
    fs.mkdirSync(project, { recursive: true });
    writeSkill(path.join(project, '.pi', 'skills'), 'simplify', 'User-custom simplify');

    const skills = discoverSkills({ cwd: project, home: path.join(root, 'home') });
    const simplify = skills.find((s) => s.name === 'simplify');
    assert.ok(simplify, 'user simplify present');
    assert.equal(simplify.description, 'User-custom simplify');
    assert.match(simplify.file, /\.pi/, 'from pi dir');
    // No duplicate simplify entry from any other source in the default scan.
    assert.equal(skills.filter((s) => s.name === 'simplify').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabled skill never shadows and never appears', () => {
  const root = tempRoot();
  try {
    const project = path.join(root, 'proj');
    fs.mkdirSync(project, { recursive: true });
    const dir = writeSkill(path.join(project, '.pi', 'skills'), 'simplify', 'Disabled simplify');
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'name: simplify',
        'description: Disabled simplify.',
        'disable-model-invocation: true',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );

    const skills = discoverSkills({ cwd: project, home: path.join(root, 'home') });
    assert.equal(skills.some((s) => s.name === 'simplify'), false, 'disabled skill dropped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system prompt carries only the winning skill instructions', () => {
  const root = tempRoot();
  try {
    const project = path.join(root, 'proj');
    const home = path.join(root, 'home');
    fs.mkdirSync(project, { recursive: true });
    writeSkill(path.join(project, '.pi', 'skills'), 'release-safe', 'Project release-safe');
    writeSkill(path.join(home, '.agents', 'skills'), 'release-safe', 'Home release-safe');

    const skills = discoverSkills({ cwd: project, home });
    const prompt = buildSkillSystemPrompt(skills);
    const matches = prompt.match(/<skill name="release-safe">/g);
    assert.equal(matches ? matches.length : 0, 1, 'one catalog entry per name');
    assert.match(prompt, /Project release-safe/);
    assert.doesNotMatch(prompt, /Home release-safe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
