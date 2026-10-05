import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { RoomEngine } from "../../internal/agora/engine.js";
import { RoomStore } from "../../internal/agora/store.js";
import { prepareTableOp } from "../../internal/agora/table.js";
import { DEFAULT_SETTINGS, type Actor, type RoomState } from "../../internal/agora/types.js";
import type { AgentRunner } from "../../internal/agora/runners/types.js";
import { wakesAgent } from "../../internal/agora/wakes.js";
import { workspacePaths } from "../../internal/agora/workspace.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const exec = promisify(execFile);
const custom = { op: "component", title: "Result", kind: "custom", refs: [], body: "Current result" };
const guest: Actor = { by: "reviewer@other-room", from: { room: "other-room", roomName: "Other room", agent: "reviewer", label: "Reviewer", kind: "codex" } };

test("human and guest presentation operations do not wake another turn during active work", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-table-wakes-"));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  let calls = 0;
  const runner: AgentRunner = { kind: "codex", async run() {
    calls += 1;
    if (calls === 1) { enter(); await gate; }
    return { status: "ok", text: "::pass::", sessionId: null };
  }, resumeCommand() { return ""; } };
  const store = RoomStore.create(join(home, "rooms"), { name: "Presentation wakes", workspace: join(home, "ws"), createdWorkspace: true, human: "Ivan", agents: [{ id: "codex", kind: "codex", label: "Codex" }], settings: { ...DEFAULT_SETTINGS, network: false } });
  const engine = new RoomEngine({ store, runners: { codex: runner }, nativePollMs: 0, env: { ...process.env, AGORYX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") } });
  try {
    engine.tableOp(custom, "codex");
    engine.postHuman("Start the work");
    await withTimeout(entered);
    const before = store.state.seq;
    for (const actor of ["Ivan", guest]) {
      const component = engine.tableOp(custom, actor);
      engine.tableOp({ op: "brief", now: "Current status" }, actor);
      engine.tableOp({ op: "archive", target: component.id }, actor);
      engine.tableOp({ op: "restore", target: component.id }, actor);
    }
    for (const event of store.since(before)) if (event.type === "table.op") {
      assert.equal(wakesAgent(store.state, event, store.state.agents[0]!), false, event.op.op);
    }
    release();
    await withTimeout(engine.waitIdle());
    assert.equal(calls, 1, "maintaining the UI must not buy another model turn");
    engine.tableOp({ op: "fact", text: "New substantive finding" }, "Ivan");
    await withTimeout(engine.waitIdle());
    assert.equal(calls, 2, "a substantive human table operation still wakes the agent");
  } finally { release(); await engine.close(); rmSync(home, { recursive: true, force: true }); }
});

test("inbox retries validate actor and intent and keep legitimate crash recovery idempotent", async () => {
  const room = createTestRoom();
  try {
    const paths = workspacePaths(room.store.state.workspace, room.store.id);
    let stamp = 0;
    const queue = (raw: Record<string, unknown>, actor: string) => {
      writeFileSync(join(paths.opsDir, `${++stamp}-1-audit.${actor}.op`), `${JSON.stringify(raw)}\n`);
      room.engine.ingestOps();
      return JSON.parse(readFileSync(join(paths.acksDir, `${raw.nonce}.json`), "utf8")) as { ok: boolean; id?: string; error?: string };
    };
    const input = { ...custom, nonce: "inbox-retry-123" };
    assert.equal(queue(input, "claude").id, "W1");
    const seq = room.store.state.seq;
    assert.equal(queue(input, "claude").ok, true);
    assert.match(queue({ ...input, title: "Different intent" }, "claude").error!, /different action/);
    assert.match(queue(input, "codex").error!, /different action/);
    assert.equal(room.store.state.seq, seq);
    const oldInput = { op: "ask", text: "  Original question  ", nonce: "legacy-retry-123" };
    room.store.append({ type: "table.op", op: prepareTableOp(room.store.state.table, oldInput, "claude", false) });
    const oldSeq = room.store.state.seq;
    assert.equal(queue(oldInput, "claude").ok, true, "older operations without a request hash still recover");
    assert.equal(room.engine.tableOp(oldInput, "claude").id, "Q1");
    assert.match(queue({ ...oldInput, text: "Different question" }, "claude").error!, /different action/);
    assert.equal(room.store.state.seq, oldSeq);
  } finally { await room.cleanup(); }
});

test("a guest retry survives source room and display label renames but not identity changes", async () => {
  const room = createTestRoom();
  try {
    const input = { ...custom, nonce: "guest-retry-123" };
    const first = room.engine.tableOp(input, guest);
    const seq = room.store.state.seq;
    assert.equal(room.engine.tableOp(input, { ...guest, from: { ...guest.from!, roomName: "Renamed room", label: "New label" } }).id, first.id);
    assert.equal(room.store.state.seq, seq);
    assert.throws(() => room.engine.tableOp(input, { ...guest, from: { ...guest.from!, agent: "someone-else" } }), /different action/);
  } finally { await room.cleanup(); }
});

test("component content preserves its author's actual cursor and lifecycle cannot freshen it", async () => {
  const room = createTestRoom();
  try {
    room.engine.tableOp({ op: "fact", text: "Original finding" }, "codex");
    const cursor = room.store.state.seq;
    room.store.append({ type: "run.started", runId: "r1", trigger: null, budget: 4 });
    room.store.append({ type: "turn.started", turnId: "t1", agent: "claude", runId: "r1", cursor, resume: false, sessionId: null, promptChars: 0 });
    room.engine.tableOp({ op: "edit", target: "F1", text: "Concurrent correction" }, "codex");
    const op = room.engine.tableOp({ ...custom, refs: ["F1"], asOfSeq: 99999, contentBy: "Ivan", contentSeq: 99999 }, "claude");
    assert.equal(op.asOfSeq, cursor);
    const component = room.store.state.table.components![0]!;
    assert.equal(component.asOfSeq, cursor);
    assert.equal(component.contentBy, "claude");
    const contentSeq = component.contentSeq;
    room.engine.tableOp({ op: "archive", target: "W1" }, "Ivan");
    room.engine.tableOp({ op: "restore", target: "W1" }, "Ivan");
    assert.equal(component.asOfSeq, cursor);
    assert.equal(component.contentBy, "claude");
    assert.equal(component.contentSeq, contentSeq);
    assert.equal(component.updatedBy, "Ivan");
    const humanCursor = room.store.state.seq;
    room.engine.tableOp({ ...custom, target: "W1", body: "Human revision" }, "Ivan");
    const revised = room.store.state.table.components![0]!;
    assert.equal(revised.asOfSeq, humanCursor);
    assert.equal(revised.contentBy, "Ivan");
    assert.equal(revised.by, "claude", "the creator continues owning the component");
  } finally { await room.cleanup(); }
});

test("decision titles retain the choice at the event through edits, deletion and old-log replay", async () => {
  const room = createTestRoom();
  try {
    room.engine.tableOp({ op: "ask", text: "Which route?" }, "codex");
    room.engine.tableOp({ op: "propose", title: "Original route", q: "Q1" }, "codex");
    room.engine.tableOp({ op: "decide", target: "P1" }, "codex");
    room.engine.tableOp({ op: "reopen", target: "P1" }, "codex");
    room.engine.tableOp({ op: "edit", target: "P1", title: "Renamed route" }, "codex");
    room.engine.tableOp({ op: "decide", target: "P1" }, "codex");
    room.engine.tableOp({ op: "reopen", target: "P1" }, "codex");
    room.engine.tableOp({ op: "delete", target: "P1" }, "codex");
    assert.deepEqual(room.store.state.table.decisions.map(decision => decision.title), ["Original route", "Renamed route"]);
    const replayed = RoomStore.open(room.roomsRoot, room.store.id);
    assert.deepEqual(replayed.state.table.decisions.map(decision => decision.title), ["Original route", "Renamed route"]);
    assert.ok(room.store.events.filter(event => event.type === "table.op" && event.op.op === "decide").every(event => !("title" in event.op)), "old logs acquire historical titles from their original projection");
  } finally { await room.cleanup(); }
});

test("human presentation CLI commands exit on an idle daemon and component reads preserve state", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-table-cli-review-"));
  const env = { ...process.env, AGORYX_HOME: home, AGORYX_USER: "Ivan", CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
  const runner: AgentRunner = { kind: "codex", async run() { return { status: "ok", text: "::pass::", sessionId: null }; }, resumeCommand() { return ""; } };
  const daemon = new AgoraDaemon({ port: 0, advertise: true, env, runners: { codex: runner }, opsPollMs: 20 });
  try {
    const { port } = await daemon.start();
    const base = `http://127.0.0.1:${port}`;
    const call = async (path: string, body?: unknown) => (await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "x-agoryx-token": daemon.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<any>;
    const created = await call("/api/rooms", { name: "CLI review", mode: "chat", agents: [{ id: "codex", kind: "codex", label: "Codex" }] });
    const id = created.room.id;
    const cli = (args: string[]) => exec(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("cmd/agoryx/main.ts"), "table", ...args, "--room", id], { cwd: home, env, timeout: 10_000 });
    await cli(["brief", "Status ready"]);
    await cli(["component", "Read this result", "--kind", "custom", "--body", "Exact component content"]);
    await cli(["archive", "W1"]);
    await cli(["restore", "W1"]);
    const before = (await call(`/api/rooms/${id}`)).state as RoomState;
    const paths = workspacePaths(before.workspace, id);
    writeFileSync(join(paths.opsDir, "1-1-read.codex.op"), `${JSON.stringify({ op: "table-read", target: "w1", nonce: "component-read-123" })}\n`);
    const deadline = Date.now() + 5000;
    let ack: { ok: boolean; text: string } | undefined;
    while (Date.now() < deadline) {
      try { ack = JSON.parse(readFileSync(join(paths.acksDir, "component-read-123.json"), "utf8")); break; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
    }
    assert.equal(ack?.ok, true);
    assert.match(ack!.text, /Exact component content/);
    const after = (await call(`/api/rooms/${id}`)).state as RoomState;
    assert.equal(after.seq, before.seq, "reading authored content is read-only");
    assert.equal(after.turns.length, 0, "neither maintaining nor reading UI starts work");
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});
