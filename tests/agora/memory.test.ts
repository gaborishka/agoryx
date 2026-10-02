import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { draftFromTable, memoryOrder, memoryPath, noteMemory, promoteToMemory, removeMemory, reviseMemory } from "../../internal/agora/memory.js";
import { projectBriefing, projectHash, readProject } from "../../internal/agora/projects.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { applyTableOp, emptyTable, prepareTableOp } from "../../internal/agora/table.js";
import type { TableState } from "../../internal/agora/types.js";
import { createTestRoom, writeFakeBins, withTimeout } from "./helpers.js";

/** A table where Q1 is still argued over, Q2 was decided, F1 is disputed and S1 is not. */
const arguedTable = (): TableState => {
  const table = emptyTable();
  let seq = 0;
  const play = (by: string, op: Record<string, unknown>) => applyTableOp(table, prepareTableOp(table, op, by, by === "Ivan"), (seq += 1), { human: by === "Ivan" });
  play("claude", { op: "ask", text: "Where do rooms live?" });
  play("claude", { op: "propose", title: "One SQLite file", body: "All rooms in agora.db.", q: "Q1" });
  play("codex", { op: "propose", title: "A JSONL log per room", q: "Q1" });
  play("codex", { op: "object", target: "P1", text: "Two daemons would fight over the file's lock — I saw it in the bench run." });
  play("claude", { op: "object", target: "P2", text: "No queries across rooms." });
  play("claude", { op: "concede", target: "P2", text: "Append-only is enough; nothing queries across rooms." });
  play("codex", { op: "fact", text: "Node 22 ships node:sqlite." });
  play("claude", { op: "object", target: "F1", text: "Still experimental: it prints a warning on every start." });
  play("claude", { op: "settle", text: "tsx for dev, tsc for the build." });
  play("Ivan", { op: "ask", text: "Which port?" });
  play("codex", { op: "propose", title: "7777", q: "Q2" });
  play("Ivan", { op: "decide", target: "P3", note: "easy to remember" });
  return table;
};

test("a table item goes into memory in the table's own words: an open question as a disagreement with every side", () => {
  const table = arguedTable();
  const q1 = draftFromTable(table, "q1");
  assert.equal(q1.kind, "disagreement");
  assert.equal(q1.author, "claude");
  assert.deepEqual(q1.positions, [
    { ref: "P1", by: "claude", text: "One SQLite file\nAll rooms in agora.db.", objections: [{ by: "codex", text: "Two daemons would fight over the file's lock — I saw it in the bench run." }] },
    // claude conceded on P2 after objecting: that objection no longer stands.
    { ref: "P2", by: "codex", text: "A JSONL log per room", objections: [] },
  ]);
  assert.deepEqual(draftFromTable(table, "D1"), { kind: "decision", text: "7777", author: "codex", decidedBy: "Ivan", why: "easy to remember", about: "Q2: Which port?" });
  assert.deepEqual(draftFromTable(table, "F1"), { kind: "fact", text: "Node 22 ships node:sqlite.", author: "codex", objections: [{ by: "claude", text: "Still experimental: it prints a warning on every start." }] });
  assert.deepEqual(draftFromTable(table, "S1"), { kind: "decision", text: "tsx for dev, tsc for the build.", author: "claude" });
  assert.throws(() => draftFromTable(table, "Q2"), /Q2 is decided \(D1\): promote the decision instead/);
  assert.throws(() => draftFromTable(table, "S9"), /not on this room's table/);
  assert.throws(() => draftFromTable(table, "P1"), /promote takes a settled point/);
});

test("memory says who wrote each entry, lists disagreements first, and renders every entry as someone's claim", () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-memory-"));
  const env = { ...process.env, AGORYX_HOME: join(home, "agora") };
  const key = join(home, "repo");
  mkdirSync(key);
  try {
    const room = { id: "r1", name: "Storage", table: arguedTable() };
    const codex = { by: "codex", from: { room: "r1", roomName: "Storage", agent: "codex", label: "Codex", kind: "codex" as const } };
    promoteToMemory(key, room, "D1", codex, env);
    noteMemory(key, { text: "Ask Olena before touching CI.", kind: "person" }, { by: "Ivan" }, env);
    promoteToMemory(key, room, "Q1", { by: "Ivan" }, env);
    assert.throws(() => promoteToMemory(key, room, "q1", { by: "claude" }, env), /already in memory as M3/);
    assert.throws(() => noteMemory(key, { text: "x", kind: "rumour" }, { by: "Ivan" }, env), /not "rumour"/);

    let project = readProject(key, env);
    assert.deepEqual(project.memory.map((entry) => [entry.id, entry.kind, entry.by, entry.author]), [
      ["M1", "decision", "codex", "codex"],
      ["M2", "person", "Ivan", "Ivan"],
      ["M3", "disagreement", "Ivan", "claude"],
    ]);
    assert.equal(project.memory[0]!.from?.room, "r1");
    assert.deepEqual(memoryOrder(project.memory).map((entry) => entry.id), ["M3", "M2", "M1"]);

    const briefing = projectBriefing(project, "agoryx", env);
    const index = briefing.slice(briefing.indexOf("Memory —"));
    assert.match(index, /^Memory — 3 entries, open disagreements first\. Each is someone's claim/);
    assert.ok(index.indexOf("M3 open disagreement") < index.indexOf("M2 person") && index.indexOf("M2 person") < index.indexOf("M1 decision"));
    assert.match(index, /M3 open disagreement — claude's Q1 in "Storage": "Where do rooms live\?"/);
    assert.match(index, /P1 claude holds "One SQLite file All rooms in agora\.db\."; still objected to by codex "Two daemons would fight/);
    assert.match(index, /M1 decision — codex's D1 in "Storage", decided by Ivan: "7777" because "easy to remember"/);
    assert.match(index, /M2 person — noted by Ivan: "Ask Olena before touching CI\."/);
    assert.match(briefing, /agoryx memory promote S3\|F2\|D1\|Q1/);

    const markdown = readFileSync(memoryPath(key, env), "utf8");
    assert.ok(markdown.indexOf("## Open disagreements") < markdown.indexOf("## Decisions"));
    assert.match(markdown, /  - ✗ codex: Two daemons would fight over the file's lock — I saw it in the bench run\./);
    assert.match(markdown, /_written by codex in "Storage", /);

    // Revising the same text appends nothing; a revision says who made it.
    const before = project.seq;
    assert.equal(reviseMemory(key, "m2", { text: "Ask Olena before touching CI." }, { by: "claude" }, env).seq, before);
    project = reviseMemory(key, "M2", { why: "she owns the runners" }, { by: "claude" }, env);
    assert.equal(project.memory.find((entry) => entry.id === "M2")!.revisedBy, "claude");
    assert.equal(project.memory.find((entry) => entry.id === "M2")!.why, "she owns the runners");
    assert.throws(() => reviseMemory(key, "M1", { kind: "disagreement" }, { by: "Ivan" }, env), /only an entry with positions/);
    project = removeMemory(key, "M1", { by: "Ivan" }, env);
    assert.deepEqual(project.memory.map((entry) => entry.id), ["M2", "M3"]);
    // An id is never given out again.
    assert.equal(noteMemory(key, { text: "Prefers short updates.", kind: "preference" }, { by: "Ivan" }, env).memory.at(-1)!.id, "M4");
    assert.doesNotMatch(readFileSync(memoryPath(key, env), "utf8"), /7777/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an agent's memory note reaches the other agents as one delta line, not the one that wrote it", async () => {
  const room = createTestRoom({
    agoraHome: true,
    rules: [{ agent: "codex", once: true, table: [["memory", "note", "Ask Olena before touching CI.", "--kind", "person"]], reply: "::pass::" }, { reply: "::pass::" }],
  });
  try {
    room.engine.postHuman("Start");
    await withTimeout(room.engine.waitIdle());
    const key = room.store.state.workspace;
    const project = readProject(key, room.env);
    assert.deepEqual(project.memory.map((entry) => [entry.kind, entry.by, entry.from?.room]), [["person", "codex", room.store.state.id]]);

    room.engine.postHuman("Again");
    await withTimeout(room.engine.waitIdle());
    assert.match(room.invocations("claude")[1]!.prompt!, /memory: \+1 person by codex — `[^`]*memory` for the text\./);
    assert.doesNotMatch(room.invocations("codex")[1]!.prompt!, /memory: \+1/);
  } finally {
    await room.cleanup();
  }
});

test("the daemon keeps memory: agents note with their key, promote from their own room only, a stale edit is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-memory-"));
  const env = { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_LIVE: "0" };
  const bins = writeFakeBins(home);
  const daemon = new AgoraDaemon({
    env: { ...env, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") },
    runners: { claude: createClaudeRunner(bins.fakeClaude), codex: createCodexRunner(bins.fakeCodex) },
    port: 0,
  });
  try {
    const info = await daemon.start();
    const call = async (method: string, path: string, body?: unknown, token = daemon.token) => {
      const res = await fetch(`${info.url}${path}`, {
        method,
        headers: { "x-agoryx-token": token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const dir = join(home, "repo");
    mkdirSync(dir);
    const work = (await call("POST", "/api/rooms", { name: "Work here", dir, mode: "work" })).body.room;
    const chat = (await call("POST", "/api/rooms", { name: "Just chat" })).body.room;
    const hash = projectHash(dir);
    await call("POST", `/api/rooms/${work.id}/table`, { op: "settle", text: "Rooms live in JSONL." });

    const key = agentKey(daemon.token, work.id, "codex");
    const noted = await call("POST", `/api/projects/${hash}/memory`, { note: { text: "CI runs on push only.", kind: "fact" } }, key);
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    assert.equal(noted.body.project.memory[0].by, "codex");
    assert.ok(existsSync(noted.body.project.memoryPath));

    const promoted = await call("POST", `/api/projects/${hash}/memory`, { promote: { ref: "S1" } }, key);
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.deepEqual(promoted.body.project.memory[1].source, { room: work.id, roomName: "Work here", ref: "S1" });
    const fromChat = await call("POST", `/api/projects/${hash}/memory`, { promote: { room: chat.id, ref: "S1" } });
    assert.equal(fromChat.status, 400);
    assert.match(fromChat.body.error, /not a Work room of this project/);

    const m1 = promoted.body.project.memory[0];
    assert.equal((await call("PATCH", `/api/projects/${hash}/memory/M1`, { text: "CI runs on push and on PRs.", seq: m1.seq })).status, 200);
    const stale = await call("PATCH", `/api/projects/${hash}/memory/M1`, { text: "Something else", seq: m1.seq });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.entry.text, "CI runs on push and on PRs.");
    assert.equal((await call("DELETE", `/api/projects/${hash}/memory/M2`)).status, 200);
    assert.deepEqual((await call("GET", `/api/projects/${hash}`)).body.project.memory.map((entry: any) => [entry.id, entry.revisedBy]), [["M1", "Ivan"]]);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
