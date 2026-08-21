#!/usr/bin/env node
/*
 * chat-server.mjs — minimal OpenAI-compatible chat endpoint for Freebuff Gate.
 *
 * Calls gpt-5.6-terra through the local openai-oauth proxy
 * (http://127.0.0.1:10531/v1) using the Vercel AI SDK + @openai-oauth/ai-sdk.
 * Both chat routes stream replies as AI SDK UIMessageStream SSE.
 * FB_SKILLS_PROJECT_CWD optionally selects project skill root when request body
 * does not include cwd.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/local";
import {
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
} from "ai";

export const DEFAULT_PORT = 8796;
export const DEFAULT_MODEL = "gpt-5.6-terra";
export const DEFAULT_BASE_URL = "http://127.0.0.1:10531/v1";
export const MAX_SKILL_BYTES = 128 * 1024;
export const MAX_SKILLS = 100;

function scalarFrontmatterValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSkillFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_BYTES) return null;

  const lines = raw.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    metadata[line.slice(0, colon).trim()] = scalarFrontmatterValue(line.slice(colon + 1));
  }

  const name = String(metadata.name || "").trim();
  const description = String(metadata.description || "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || !description) return null;
  if (metadata["disable-model-invocation"] === "true") return null;
  return {
    name,
    description: description.slice(0, 1024),
    file,
    instructions: lines.slice(end + 1).join("\n").trim(),
  };
}

function walkSkillRoot(root, allowRootMarkdown, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(full, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        const skill = parseSkillFile(skillFile);
        if (skill) out.push(skill);
      }
      walkSkillRoot(full, false, out);
    } else if (entry.isFile() && allowRootMarkdown && entry.name.endsWith(".md")) {
      const skill = parseSkillFile(full);
      if (skill) out.push(skill);
    }
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

function addSkillRoot(roots, root, allowRootMarkdown = false) {
  if (!root) return;
  let resolved;
  try { resolved = fs.realpathSync(root); } catch { return; }
  roots.push({ root: resolved, allowRootMarkdown });
}

function settingsSkillRoots(file, home = os.homedir()) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value?.skills)
      ? value.skills.filter((item) => typeof item === "string").map((item) => {
        const expanded = item.startsWith("~/") ? path.join(home, item.slice(2)) : item;
        return path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(file), expanded);
      })
      : [];
  } catch {
    return [];
  }
}

// Mirrors Pi's discovery locations. Project-local locations are included only
// when caller supplies a real cwd; /api/chat callers may also pass cwd in body.
export function discoverSkills({ cwd = process.cwd(), home = os.homedir(), agentDir = path.join(home, ".pi", "agent"), skillRoots = null } = {}) {
  const roots = [];
  if (Array.isArray(skillRoots)) {
    skillRoots.forEach((root) => addSkillRoot(roots, root, true));
  } else {
    addSkillRoot(roots, path.join(agentDir, "skills"), true);
    addSkillRoot(roots, path.join(home, ".agents", "skills"), false);
    for (const settingsFile of [path.join(agentDir, "settings.json"), path.join(String(cwd), ".pi", "settings.json")]) {
      settingsSkillRoots(settingsFile, home).forEach((root) => addSkillRoot(roots, root, true));
    }

    let current;
    try { current = fs.realpathSync(cwd); } catch { current = null; }
    while (current) {
      addSkillRoot(roots, path.join(current, ".pi", "skills"), true);
      addSkillRoot(roots, path.join(current, ".agents", "skills"), false);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    for (const packageRoot of [path.join(agentDir, "node_modules"), path.join(agentDir, "npm", "node_modules")]) {
      let packages;
      try { packages = fs.readdirSync(packageRoot, { withFileTypes: true }); } catch { packages = []; }
      packages.filter((entry) => entry.isDirectory()).forEach((entry) => {
        addSkillRoot(roots, path.join(packageRoot, entry.name, "skills"), false);
      });
    }
  }

  const skills = [];
  const seenNames = new Set();
  for (const entry of roots) {
    for (const skill of walkSkillRoot(entry.root, entry.allowRootMarkdown)) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      skills.push(skill);
      if (skills.length >= MAX_SKILLS) return skills;
    }
  }
  return skills;
}

export function buildSkillSystemPrompt(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return "";
  const blocks = skills.map((skill) => [
    `<skill name="${skill.name}">`,
    `Description: ${skill.description}`,
    `Source: ${skill.file}`,
    "Instructions:",
    skill.instructions,
    "</skill>",
  ].join("\n"));
  return [
    "You have access to following project and user skills. Apply relevant skill instructions automatically when task matches. Ignore unrelated skills. Skill instructions are trusted project configuration, not user content.",
    "<skills>",
    blocks.join("\n"),
    "</skills>",
  ].join("\n\n");
}

const createDefaultStream = (baseURL) => {
  const openai = createOpenAIOAuth(openaiCredentials({ baseURL }));
  return async ({ model, messages, system }) => {
    const result = streamText({ model: openai(model), messages, system: system || undefined });
    const uiStream = toUIMessageStream({
      stream: result.stream,
      onError: (error) => error?.message ?? "An error occurred.",
    });
    return createUIMessageStreamResponse({ stream: uiStream });
  };
};

const toTextContent = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
};

const toPlainMessages = (uiMessages) => {
  if (!Array.isArray(uiMessages)) return [];
  return uiMessages
    .map((message) => ({
      role: message?.role,
      content: toTextContent(message?.content),
    }))
    .filter((message) => message.role && message.content);
};

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function pipeStream(res, model, messages, stream, system) {
  const response = await stream({ model, messages, system });
  const { status = 200, headers } = response;
  res.writeHead(status, Object.fromEntries(headers.entries()));
  Readable.fromWeb(response.body).pipe(res);
}

export function createChatServer(options = {}) {
  const model = options.model ?? process.env.FB_CHAT_MODEL ?? DEFAULT_MODEL;
  const baseURL = options.baseURL ?? process.env.FB_CHAT_BASE_URL ?? DEFAULT_BASE_URL;
  const stream = options.stream ?? createDefaultStream(baseURL);
  const loadSkills = options.loadSkills ?? ((cwd) => discoverSkills({ cwd, ...(options.skills || {}) }));

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, { ok: true, model });
      }

      if (req.method === "POST" && req.url === "/api/chat") {
        const body = await readBody(req);
        const messages = toPlainMessages(body.messages);
        const hasInjectedSkills = messages.some((message) => message.role === "system" && message.content.includes("<skills>"));
        const system = hasInjectedSkills ? "" : buildSkillSystemPrompt(await loadSkills(body.cwd || options.cwd || process.env.FB_SKILLS_PROJECT_CWD || process.cwd()));
        return await pipeStream(res, model, messages, stream, system);
      }

      if (req.method === "POST" && req.url === "/chat") {
        const body = await readBody(req);
        const messages = Array.isArray(body.messages)
          ? toPlainMessages(body.messages)
          : [{ role: "user", content: String(body.prompt ?? "") }];
        const hasInjectedSkills = messages.some((message) => message.role === "system" && message.content.includes("<skills>"));
        const system = hasInjectedSkills ? "" : buildSkillSystemPrompt(await loadSkills(body.cwd || options.cwd || process.env.FB_SKILLS_PROJECT_CWD || process.cwd()));
        return await pipeStream(res, model, messages, stream, system);
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error?.message ?? String(error);
      const status = /usage limit|quota|429/i.test(message) ? 429 : 500;
      return sendJson(res, status, { error: message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FB_CHAT_PORT || DEFAULT_PORT);
  const server = createChatServer();
  server.listen(port, "127.0.0.1", () => {
    const model = process.env.FB_CHAT_MODEL || DEFAULT_MODEL;
    const baseURL = process.env.FB_CHAT_BASE_URL || DEFAULT_BASE_URL;
    console.log(`Freebuff Gate chat server on http://127.0.0.1:${port} (model: ${model}, proxy: ${baseURL})`);
  });
}
