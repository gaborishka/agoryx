import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { RoomEngine } from "../../internal/agora/engine.js";
import { blockHash } from "../../internal/agora/blocks.js";
import { RoomStore } from "../../internal/agora/store.js";
import type { AgentRunner } from "../../internal/agora/runners/types.js";
import type { RoomState, TableOp } from "../../internal/agora/types.js";
import { workTableView } from "../../internal/agora/work-table.js";
import { createTestRoom } from "./helpers.js";

const run = promisify(execFile);
const shim = resolve("bin/agoryx-agent.mjs");

test("brief freshness reflects the agent's turn context, not unseen concurrent decisions", async () => {
  const room = createTestRoom();
  try {
    room.engine.tableOp({ op: "ask", text: "Which result?" }, "codex");
    room.engine.tableOp({ op: "propose", title: "A", q: "Q1" }, "codex");
    const cursor = room.store.state.seq;
    room.store.append({ type: "run.started", runId: "r1", trigger: null, budget: 4 });
    room.store.append({ type: "turn.started", turnId: "t1", agent: "claude", runId: "r1", cursor, resume: false, sessionId: null, promptChars: 0 });
    room.engine.tableOp({ op: "decide", target: "P1" }, "codex");
    const op = room.engine.tableOp({ op: "brief", now: "Still comparing", refs: ["P1"], asOfSeq: 999999 }, "claude");
    assert.equal(op.asOfSeq, cursor);
    assert.equal(op.turnId, "t1");
    assert.equal(workTableView(room.store.state, room.store.events).headsUp.stale, true);
    assert.equal(room.store.state.table.brief?.by, "claude");
  } finally { await room.cleanup(); }
});

test("table action retry survives replay and cannot impersonate another actor or reuse an id for a new intent", async () => {
  const room = createTestRoom();
  let reopened: RoomEngine | undefined;
  try {
    const input = { op: "component", title: "Result", kind: "custom", body: "```html\n<div>Result</div>\n```", refs: [], nonce: "retry-action-123" };
    const first = room.engine.tableOp(input, "claude");
    assert.equal(first.id, "W1");
    assert.match(first.requestHash!, /^[a-f0-9]{64}$/);
    const seq = room.store.state.seq;
    assert.equal(room.engine.tableOp({ refs: [], nonce: input.nonce, body: input.body, kind: input.kind, title: input.title, op: input.op }, "claude").id, "W1");
    assert.equal(room.store.state.seq, seq, "a retry neither appends an event nor wakes another round");
    assert.throws(() => room.engine.tableOp(input, "codex"), /different action/);
    assert.throws(() => room.engine.tableOp({ ...input, title: "Different intent" }, "claude"), /different action/);
    await room.engine.close();
    const store = RoomStore.open(room.roomsRoot, room.store.id);
    reopened = new RoomEngine({ store, runners: {}, env: room.env, nativePollMs: 0 });
    assert.equal(reopened.tableOp(input, "claude").id, "W1");
    assert.equal(store.state.table.components?.length, 1);
    assert.equal(store.state.seq, seq);
  } finally { await reopened?.close(); await room.cleanup(); }
});

test("the zero-dependency room shim publishes authored UI and rejects malformed repeated flags", async () => {
  const room = createTestRoom();
  try {
    room.engine.tableOp({ op: "ask", text: "Which result?" }, "codex");
    room.engine.tableOp({ op: "propose", title: "A", q: "Q1" }, "codex");
    writeFileSync(join(room.store.state.workspace, "preview.md"), "```html\n<button onclick=\"this.textContent='Selected'\">Local interaction</button>\n```");
    const env = { ...room.env, AGORYX_TURN_FILE: "", AGORYX_AGENT: "codex", AGORYX_ROOM: room.store.id };
    const cli = (args: string[]) => run(process.execPath, [shim, "table", ...args, "--as", "codex", "--room", room.store.id], { cwd: room.store.state.workspace, env });
    await cli(["brief", "Comparing results", "--change", "A is ready", "--change", "Checks pending", "--ref", "Q1", "--ref", "P1", "--awaiting", "Q1", "--recommend", "P1"]);
    assert.deepEqual(room.store.state.table.brief?.changes, ["A is ready", "Checks pending"]);
    assert.deepEqual(room.store.state.table.brief?.refs, ["Q1", "P1"]);
    const component = await cli(["component", "Interactive result", "--kind", "custom", "--body-file", "preview.md", "--ref", "P1"]);
    assert.match(component.stdout, /W1/);
    assert.match(room.store.state.table.components?.[0]?.body ?? "", /Local interaction/);
    const seq = room.store.state.seq;
    for (const args of [
      ["brief", "Now", "--change", "--ref", "P1"],
      ["brief", "Now", "--recommend"],
      ["archive", "W1", "W2"],
      ["component", "Bad", "--kind", "custom", "--body", "inline", "--body-file", "preview.md"],
    ]) await assert.rejects(cli(args), /needs a value|takes one component id|use --body or --body-file/);
    assert.equal(room.store.state.seq, seq, "malformed flags cannot silently change the table");
    await cli(["archive", "W1"]);
    await cli(["restore", "W1"]);
    assert.equal(room.store.state.table.components?.[0]?.archived, undefined);
  } finally { await room.cleanup(); }
});

test("HTTP table actions return committed events; custom components render only through the sandbox capability", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-work-table-api-"));
  const runner: AgentRunner = {
    kind: "codex", async run() { return { status: "ok", text: "::pass::", sessionId: null }; }, resumeCommand() { return ""; },
  };
  const daemon = new AgoraDaemon({ port: 0, advertise: false, env: { ...process.env, AGORYX_HOME: home, AGORYX_USER: "Ivan", CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") }, runners: { codex: runner }, opsPollMs: 20 });
  try {
    const { port } = await daemon.start();
    const base = `http://127.0.0.1:${port}`;
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "x-agoryx-token": daemon.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json() as any;
      return { status: response.status, data };
    };
    const created = await call("/api/rooms", { name: "Work table API", mode: "chat", agents: [{ id: "codex", kind: "codex", label: "Codex" }] });
    assert.equal(created.status, 201);
    const roomId = created.data.room.id;
    const path = `/api/rooms/${roomId}`;
    const html = '<button onclick="this.textContent=\'Selected\'">Local interaction</button>';
    const body = { op: "component", title: "Interactive result", kind: "custom", body: `\`\`\`html\n${html}\n\`\`\``, refs: [], nonce: "http-retry-component" };
    const result = await call(path + "/table", body);
    assert.equal(result.status, 201);
    assert.equal(result.data.event.type, "table.op");
    assert.equal(result.data.seq, result.data.event.seq);
    assert.equal(result.data.table.components[0].id, "W1");
    const retry = await call(path + "/table", body);
    assert.equal(retry.data.seq, result.data.seq);
    const snapshot = (await call(path)).data;
    assert.equal(snapshot.state.table.components.length, 1);
    assert.equal(snapshot.events.at(-1).op.id, "W1");
    const raw = await fetch(base + snapshot.rawBase + `~block/w:W1/${blockHash(html)}`);
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get("content-security-policy")!, /sandbox allow-scripts/);
    assert.doesNotMatch(raw.headers.get("content-security-policy")!, /allow-same-origin/);
    assert.match(await raw.text(), /Local interaction/);
    assert.equal((await fetch(base + snapshot.rawBase + "~block/w:W9/bad")).status, 404);
    const brief = await call(path + "/table", { op: "brief", now: "Result prepared", refs: ["W1"], asOfSeq: 99999 });
    assert.equal(brief.data.table.brief.asOfSeq, snapshot.state.seq);
    const view = workTableView((await call(path)).data.state as RoomState, (await call(path)).data.events);
    assert.equal(view.headsUp.now, "Result prepared");
    assert.equal(view.headsUp.stale, false);
    assert.equal((await call(path + "/table", { op: "archive", target: "W1" })).status, 201);
    assert.equal((await call(path + "/table", { op: "restore", target: "W1" })).status, 201);
    assert.equal((await call(path + "/table", { ...body, title: "Reused nonce, new intent" })).status, 400);
    const saved = (await call(path)).data.state as RoomState;
    assert.equal(saved.table.components?.length, 1);
    assert.equal(saved.turns.length, 0, "publishing or hiding UI does not start needless agent turns");
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});
