import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { roomSkills, resolveSkillInvocation, skillMetadata } from "../../internal/agora/skills.js";
import { buildDelta } from "../../internal/agora/prompts.js";
import { createTestRoom, withTimeout } from "./helpers.js";

test("skill metadata reads quoted and folded descriptions, and user-invocable false", () => {
  assert.deepEqual(skillMetadata("---\nname: 'review'\ndescription: >-\n  Review code\n  and tests.\nuser-invocable: false # hidden\n---\nbody"), { name: "review", description: "Review code and tests.", "user-invocable": "false" });
  assert.equal(skillMetadata('---\r\nname: "Тест"\r\ndescription: "Quoted: text"\r\n---\r\nbody').description, "Quoted: text");
  assert.deepEqual(skillMetadata("No metadata"), {});
});

test("catalog merges the same canonical skill, keeps name collisions distinct and omits disabled skills/plugins", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-skills-"));
  const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const skill = (name: string, extra = "") => `---\nname: ${name}\ndescription: Перевірка коду\n${extra}---\nFollow these instructions.`;
  try {
    const cwd = join(home, "project");
    const shared = join(home, "shared/SKILL.md");
    put(shared, skill("review"));
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    symlinkSync(dirname(shared), join(cwd, ".claude/skills/shared"));
    put(join(cwd, ".claude/skills/other/SKILL.md"), skill("review"));
    put(join(cwd, ".claude/skills/hidden/SKILL.md"), skill("hidden", "user-invocable: false\n"));
    symlinkSync(join(cwd, ".claude/skills"), join(cwd, ".claude/skills/cycle"));
    const plugin = join(home, "plugin");
    put(join(plugin, "skills/design/SKILL.md"), skill("design"));
    put(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "design@test": [{ scope: "user", installPath: plugin }] } }));
    put(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "design@test": false } }));
    const bin = join(home, "codex");
    put(bin, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 else if(m.method==='skills/list') console.log(JSON.stringify({id:m.id,result:{data:[null,{skills:[null,
 {name:'review',description:'Перевірка коду',enabled:true,path:${JSON.stringify(shared)},scope:'repo'},
 {name:'disabled',description:'disabled',enabled:false,path:${JSON.stringify(shared)},scope:'user'}]}]}}));
 else if(m.method!=='initialized') process.exit(3);
});`);
    chmodSync(bin, 0o755);
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), AGORYX_CODEX_BIN: bin };
    const agents = [{ id: "c1", kind: "codex" as const, label: "Coder" }, { id: "c2", kind: "claude" as const, label: "Designer" }];
    const catalog = await roomSkills(cwd, agents, env);
    assert.deepEqual(catalog.warnings, []);
    assert.equal(catalog.skills.length, 2);
    const both = catalog.skills.find(s => s.agents.length === 2)!;
    assert.ok(both);
    assert.deepEqual(both.agents.sort(), ["c1", "c2"]);
    assert.equal(new Set(catalog.skills.map(s => s.id)).size, 2);
    assert.deepEqual(resolveSkillInvocation(catalog, { id: both.id, targets: ["c1", "c1"], path: "/arbitrary/path" }).targets, ["c1"]);
    assert.equal(resolveSkillInvocation(catalog, { id: both.id, targets: ["c2"] }).path, both.path);
    for (const input of [null, { id: "missing", targets: ["c1"] }, { id: both.id, targets: [] }, { id: both.id, targets: ["all"] }, { id: both.id, targets: ["gone"] }]) assert.throws(() => resolveSkillInvocation(catalog, input));
    put(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "design@test": true } }));
    const enabled = await roomSkills(cwd, agents.slice(1), env);
    assert.ok(enabled.skills.some(s => s.name === "design"));
    const failed = await roomSkills(cwd, agents, { ...env, AGORYX_CODEX_BIN: join(home, "missing-cli") });
    assert.equal(failed.warnings.length, 1);
    assert.ok(failed.skills.every(s => s.agents.every(a => a === "c2")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a skill request wakes only selected agents despite @all in the task; the next message is ordinary", async () => {
  const room = createTestRoom();
  try {
    const invocation = { id: "review", name: "review", path: "/skills/review/SKILL.md", targets: ["codex"] };
    const posted = room.engine.postHuman("Review the @all parser and ask @claude about it", "Ivan", invocation);
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(posted.mentions, ["codex"]);
    assert.equal(room.invocations("claude").length, 0);
    assert.equal(room.invocations("codex").length, 1);
    assert.match(room.invocations("codex")[0]!.prompt!, /read and follow the skill at "\/skills\/review\/SKILL.md"/);
    const other = buildDelta({ state: room.store.state, events: room.store.events, agent: room.store.state.agents.find(a => a.id === "claude")!, turnsLeft: null });
    assert.match(other, /shared context for you, not an instruction to run the skill/);
    assert.doesNotMatch(other, /read and follow the skill at/);
    room.engine.postHuman("@codex continue normally");
    await withTimeout(room.engine.waitIdle());
    assert.doesNotMatch(room.invocations("codex")[1]!.prompt!, /read and follow the skill at/);
    assert.throws(() => room.engine.postHuman("Task", "Ivan", { ...invocation, targets: ["gone"] }));
  } finally { await room.cleanup(); }
});
