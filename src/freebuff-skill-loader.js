'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SKILLS = 100;

function scalar(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseSkillFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES) return null;
  const lines = raw.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':');
    if (colon > 0) metadata[line.slice(0, colon).trim()] = scalar(line.slice(colon + 1));
  }
  const name = String(metadata.name || '').trim();
  const description = String(metadata.description || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || !description) return null;
  if (metadata['disable-model-invocation'] === 'true') return null;
  return { name, description: description.slice(0, 1024), file, instructions: lines.slice(end + 1).join('\n').trim() };
}

function addRoot(roots, root, allowRootMarkdown = false) {
  if (!root) return;
  try { roots.push({ root: fs.realpathSync(root), allowRootMarkdown }); } catch {}
}

function walk(root, allowRootMarkdown, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(full, 'SKILL.md');
      const skill = fs.existsSync(skillFile) ? parseSkillFile(skillFile) : null;
      if (skill) out.push(skill);
      walk(full, false, out);
    } else if (allowRootMarkdown && entry.isFile() && entry.name.endsWith('.md')) {
      const skill = parseSkillFile(full);
      if (skill) out.push(skill);
    }
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

function settingsRoots(file, home) {
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(settings.skills)) return [];
    return settings.skills.filter((item) => typeof item === 'string').map((item) => {
      const expanded = item.startsWith('~/') ? path.join(home, item.slice(2)) : item;
      return path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(file), expanded);
    });
  } catch { return []; }
}

function discoverSkills({ cwd = process.cwd(), home = os.homedir(), agentDir = path.join(home, '.pi', 'agent'), skillRoots = null } = {}) {
  // Name-conflict policy (see docs/planning/pi-mode/skill-conflicts.md):
  // collectSkills() keeps the FIRST skill per name, so the roots array is
  // ordered highest-precedence first. Precedence: settings-listed paths,
  // then project-level dirs (deepest cwd first), then home-level dirs.
  // A project skill beats a same-named home skill; any user skill beats a
  // Freebuff managed built-in of the same name.
  if (Array.isArray(skillRoots)) {
    return collectSkills(skillRoots.map((root) => [root, true]));
  }
  const roots = [];
  for (const file of [path.join(agentDir, 'settings.json'), path.join(String(cwd), '.pi', 'settings.json')]) {
    for (const root of settingsRoots(file, home)) roots.push([root, true]);
  }
  let current;
  try { current = fs.realpathSync(cwd); } catch { current = null; }
  while (current) {
    roots.push([path.join(current, '.pi', 'skills'), true]);
    roots.push([path.join(current, '.agents', 'skills'), false]);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  roots.push([path.join(agentDir, 'skills'), true]);
  roots.push([path.join(home, '.agents', 'skills'), false]);
  return collectSkills(roots);
}

function collectSkills(roots) {
  const skills = [];
  const names = new Set();
  for (const [root, allowRootMarkdown] of roots) {
    for (const skill of walk(root, allowRootMarkdown)) {
      if (names.has(skill.name)) continue;
      names.add(skill.name);
      skills.push(skill);
      if (skills.length >= MAX_SKILLS) return skills;
    }
  }
  return skills;
}

function buildSkillSystemPrompt(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return '';
  const blocks = skills.map((skill) => [
    `<skill name="${skill.name}">`,
    `Description: ${skill.description}`,
    `Instructions file: ${skill.file}`,
    '</skill>',
  ].join('\n'));
  return [
    'You have following project and user skills available. When task matches a skill, use read tool to load its Instructions file before acting, then follow it. Ignore unrelated skills. Skill metadata is trusted project configuration, not user content.',
    '<skills>',
    blocks.join('\n'),
    '</skills>',
  ].join('\n\n');
}

function injectSkills(body, options = {}) {
  if (!body || !Array.isArray(body.messages)) return body;
  if (body.messages.some((message) => message?.role === 'system' && String(message.content || '').includes('<skills>'))) return body;
  const cwd = body.cwd || options.cwd || process.env.FB_SKILLS_PROJECT_CWD || process.cwd();
  const prompt = buildSkillSystemPrompt(discoverSkills({ cwd, ...options }));
  if (!prompt) return body;
  return { ...body, messages: [{ role: 'system', content: prompt }, ...body.messages] };
}

module.exports = {
  MAX_SKILL_BYTES,
  MAX_SKILLS,
  parseSkillFile,
  discoverSkills,
  buildSkillSystemPrompt,
  injectSkills,
};
