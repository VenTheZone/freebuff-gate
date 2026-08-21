# Skill name conflicts: Pi skills vs Freebuff built-ins

Status: implemented. Scope: the Freebuff skill discovery layer — proxy skill
injection (`src/freebuff-skill-loader.js`), the chat server
(`src/chat-server.mjs`), and the orchestrator SkillStore (`.agents`/`.pi`
scan in the on-disk `orchestrator.js` patch). All three must resolve the
same way.

## The collision

Freebuff ships built-in skills (managed): `autorun`, `preview`,
`apply-locally`, `brainstorm`, `explain`, `learn`, `overhaul`, `derisk`,
`simplify`, `review`, `test`, `commit`, `open-pr`, `merge-pr`,
`merge-local`, ... A user's Pi skills (`.pi/skills`, `~/.pi/agent/skills`)
or other agent skills (`.agents/skills`, `.claude/skills`) can use the same
name, e.g. a community `simplify`.

## Policy

1. **User skill wins over built-in.** A valid skill from any user directory
   (`~/.pi/agent/skills`, `~/.agents/skills`, `.pi/skills`,
   `.agents/skills`, `.claude/skills`, or a settings-listed path) shadows a
   Freebuff managed skill of the same name. User intent beats a shipped
   default; this already holds for `.agents`/`.claude` skills and extends to
   Pi paths unchanged. Deduplicate by skill `name`.
2. **Closer to the project wins.** Within user directories, precedence goes
   project-level over home-level: `<project>/.pi/skills` and
   `<project>/.agents/skills` beat `~/.pi/agent/skills` and
   `~/.agents/skills` on a name clash. (Matches the orchestrator SkillStore
   merge, where later `agentSkillsDirs` entries override earlier ones.)
3. **Project overrides beat everything user.** `.freebuff/skills` (the
   orchestrator's project override dir) resolves first in the SkillStore, so
   a project-pinned Freebuff skill is intentionally not shadowed by agent
   skills.
4. **`autorun` is reserved.** The Auto-tab decision agent reads the
   `autorun` skill as standing instructions; a user `autorun` would hijack
   engine behavior. The orchestrator already refuses to resolve it
   (`get()` returns null for `AUTORUN_SKILL_NAME`) — user skills named
   `autorun` are ignored everywhere.
5. **First source wins in list contexts.** When the loader emits the skill
   catalog (`buildSkillSystemPrompt`) or the orchestrator lists available
   skills, a name appears once, from the highest-precedence source that has
   it. No duplicate entries, no per-name mixing.

### Decision-skill note (auto-run)

`review`, `simplify`, `test`, `brainstorm`, `overhaul`, `derisk`, `commit`,
`open-pr`, `merge-pr`, `merge-local` are enqueued by the Auto tab by name.
If a user skill shadows one, the auto-run's hardcoded skill notes describe
the managed behavior while the queued run executes the user skill. This is
accepted: the user installed the skill, and the shadowing behavior is
identical to today's `.agents/skills` override. Users who want the managed
version back remove or rename the user skill.

## Resolution order (highest to lowest)

1. `<project>/.freebuff/skills` (project override, orchestrator only)
2. settings-listed skill roots (`~/.pi/agent/settings.json`,
   `<project>/.pi/settings.json`)
3. `<project>/.pi/skills`
4. `<project>/.agents/skills`
5. `<project>/.claude/skills`
6. `~/.pi/agent/skills`
7. `~/.agents/skills`
8. `~/.claude/skills`
9. Freebuff managed built-ins (fallback)

`disable-model-invocation: true` skills and malformed `SKILL.md` files are
dropped at parse time and never participate.

## Test coverage

- `src/freebuff-skill-loader.test.js` — loader precedence (project beats
  home, user beats built-in naming, dedupe by name).
- `src/chat-server.test.mjs` — injected system prompt contains the winning
  skill's instructions and only one entry per name.
- `src/freebuff-tailnet-proxy.test.js` — native `/api/chat` injection uses
  the same precedence.
