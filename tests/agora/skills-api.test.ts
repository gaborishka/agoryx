import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { agentKey } from "../../internal/agora/actor.js";

test("skill API resolves identities server-side, persists routing, and rejects stale/agent-supplied invocations", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-skills-api-"));
  const workspace = join(home, "workspace");
  const file = join(workspace, ".claude/skills/review/SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "---\nname: review\ndescription: Review changes\n---\nReview the task.");
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), AGORYX_HOME: join(home, "state"), AGORYX_LIVE: "0" };
  const daemon = new AgoraDaemon({ env, port: 0, advertise: false, watchDays: 0,
    runners: { claude: { kind: "claude", resumeCommand: () => "", run: async () => ({ status: "ok", text: "::pass::", sessionId: null }) } },
  });
  try {
    const { port } = await daemon.start();
    const call = async (method: string, path: string, body?: unknown, token = daemon.token) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "x-agoryx-token": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json() as any };
    };
    const created = await call("POST", "/api/rooms", { name: "Skills", dir: workspace, autoCommit: false, agents: [{ id: "claude", kind: "claude", label: "Claude" }, { id: "reviewer", kind: "claude", label: "Reviewer" }] });
    assert.equal(created.status, 201);
    const id = created.body.room.id;
    const url = `/api/rooms/${id}`;
    const catalog = await call("GET", `${url}/skills`);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.skills.length, 1);
    const skill = catalog.body.skills[0];
    const posted = await call("POST", `${url}/messages`, { text: "Check @all mentions", skill: { id: skill.id, targets: ["reviewer"], path: "/forged/SKILL.md" } });
    assert.equal(posted.status, 201);
    assert.deepEqual(posted.body.message.mentions, ["reviewer"]);
    assert.equal(posted.body.message.skill.path, skill.path);
    const snapshot = await call("GET", url);
    assert.equal(snapshot.body.state.messages[0].skill.name, "review");
    const copy = readFileSync(join(workspace, ".agoryx/messages", id, "m1.md"), "utf8");
    assert.match(copy, /Only reviewer should read and follow/);
    assert.match(copy, /Check @all mentions/);
    assert.equal((await call("POST", `${url}/messages`, { text: "Test", skill: { id: skill.id, targets: ["gone"] } })).status, 400);
    const key = agentKey(daemon.token, id, "claude");
    assert.equal((await call("GET", `${url}/skills`, undefined, key)).status, 403);
    assert.equal((await call("POST", `${url}/messages`, { text: "Test", skill: { id: skill.id, targets: ["claude"] } }, key)).status, 403);
    rmSync(file);
    assert.equal((await call("POST", `${url}/messages`, { text: "Test", skill: { id: skill.id, targets: ["reviewer"] } })).status, 400);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});
