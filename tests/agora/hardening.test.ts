import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { docHash, MAX_DOC_TEXT, readDoc } from "../../internal/agora/doc.js";
import { DocTooLargeError, MAX_TURN_TIMEOUT_MS, RoomEngine } from "../../internal/agora/engine.js";
import { createRoom } from "../../internal/agora/service.js";
import { RoomStore } from "../../internal/agora/store.js";
import { parseTableCommand, TableCommandError } from "../../internal/agora/table-cli.js";
import { DEFAULT_SETTINGS } from "../../internal/agora/types.js";
import { workspacePaths } from "../../internal/agora/workspace.js";
import { AGENTS, createTestRoom } from "./helpers.js";

const agentTool = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agoryx-agent.mjs");

test("a canonical file past the cap is hashed whole but only a preview is read, and never saved over", async () => {
  const room = createTestRoom({ settings: { doc: "README.md" } });
  try {
    const small = join(room.store.state.workspace, "small.md");
    writeFileSync(small, "# small\n");
    assert.equal(readDoc(room.store.state.workspace, "small.md")?.hash, docHash("# small\n"));

    const big = Buffer.alloc(MAX_DOC_TEXT * 3, "a");
    writeFileSync(join(room.store.state.workspace, "README.md"), big);
    const now = readDoc(room.store.state.workspace, "README.md")!;
    assert.equal(now.truncated, true);
    assert.equal(now.text.length, MAX_DOC_TEXT);
    assert.equal(now.size, big.length);
    assert.equal(now.hash, createHash("sha1").update(big).digest("hex").slice(0, 12));

    assert.equal(room.engine.readDocument()?.truncated, true);
    assert.throws(() => room.engine.writeDocument("# cut\n", now.hash), DocTooLargeError);
    assert.equal(readFileSync(join(room.store.state.workspace, "README.md")).length, big.length, "the file is untouched");
  } finally {
    await room.cleanup();
  }
});

test("a new room never writes its first document through a symlink out of the workspace", () => {
  const home = mkdtempSync(join(tmpdir(), "agora-home-"));
  const outside = mkdtempSync(join(tmpdir(), "agora-outside-"));
  try {
    const dir = join(home, "mine");
    mkdirSync(dir);
    symlinkSync(outside, join(dir, "docs"));
    const env = { ...process.env, AGORYX_HOME: home };
    assert.throws(() => createRoom({ name: "Linked", dir, doc: "docs/notes/README.md", env }), /inside the workspace/);
    symlinkSync(join(outside, "target.md"), join(dir, "dangling.md"));
    // A symlink already there is left alone: the room does not create through it.
    createRoom({ name: "Dangling", dir, doc: "dangling.md", env });
    assert.equal(existsSync(join(outside, "notes")), false);
    assert.equal(existsSync(join(outside, "target.md")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the readable workspace name is claimed atomically: a directory that already exists is never shared", () => {
  const home = mkdtempSync(join(tmpdir(), "agora-home-"));
  try {
    const env = { ...process.env, AGORYX_HOME: home };
    const first = createRoom({ name: "Same name", mode: "work", env });
    const taken = first.state.workspace;
    // Empty again, as if a second create had just made it and not yet written into it.
    rmSync(taken, { recursive: true, force: true });
    mkdirSync(taken);
    const second = createRoom({ name: "Same name", mode: "work", env });
    assert.notEqual(second.state.workspace, taken);
    assert.ok(second.state.workspace.endsWith(second.id));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a room is found from the deepest workspace holding the cwd; a tie is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-rooms-"));
  try {
    const make = (name: string, workspace: string) =>
      RoomStore.create(root, { name, workspace, createdWorkspace: false, human: "Ivan", agents: AGENTS, settings: { ...DEFAULT_SETTINGS } });
    const outer = make("Outer", "/repo");
    const inner = make("Inner", "/repo/sub");
    assert.equal(RoomStore.resolveId(root, undefined, "/repo/sub/src"), inner.id);
    assert.equal(RoomStore.resolveId(root, undefined, "/repo/other"), outer.id);
    make("Inner twin", "/repo/sub");
    assert.throws(() => RoomStore.resolveId(root, undefined, "/repo/sub/src"), /name one with --room/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("table commands reject flags their verb does not take, in both CLIs", () => {
  assert.throws(() => parseTableCommand("decide", ["P1", "--nte", "why"]), TableCommandError);
  assert.throws(() => parseTableCommand("ask", ["what?", "--body", "x"]), TableCommandError);
  assert.deepEqual(parseTableCommand("evidence", ["P1", "bench", "--source", "b.txt"]), { op: "evidence", target: "P1", text: "bench", source: "b.txt" });

  const ws = mkdtempSync(join(tmpdir(), "agora-agent-"));
  try {
    const paths = workspacePaths(ws);
    const run = spawnSync(process.execPath, [agentTool, "table", "decide", "P1", "--nte", "why"], {
      cwd: ws,
      env: { PATH: process.env.PATH, AGORYX_AGENT: "codex", AGORYX_OPS_DIR: paths.opsDir },
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /does not take --nte/);
    assert.equal(existsSync(paths.opsDir), false, "nothing was queued");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a turn limit a Node timer cannot hold is refused", async () => {
  const room = createTestRoom();
  try {
    assert.throws(() => room.engine.updateSettings({ turnTimeoutMs: MAX_TURN_TIMEOUT_MS + 1 }), /turn limit/);
    assert.throws(() => room.engine.updateSettings({ turnTimeoutMs: 1000 }), /turn limit/);
    room.engine.updateSettings({ turnTimeoutMs: MAX_TURN_TIMEOUT_MS });
    assert.equal(room.store.state.settings.turnTimeoutMs, MAX_TURN_TIMEOUT_MS);
  } finally {
    await room.cleanup();
  }
});

test("a turn that died with the process or failed gives its messages back: the agent's cursor returns to where it was", async () => {
  const room = createTestRoom();
  try {
    const { store } = room;
    const run = "r-test";
    const turn = (id: string, cursor: number, status: "ok" | "interrupted" | "error", unseen?: boolean) => {
      store.append({ type: "turn.started", turnId: id, agent: "codex", runId: run, cursor, resume: false, sessionId: null, promptChars: 1 });
      store.append({ type: "turn.ended", turnId: id, agent: "codex", status, sessionId: null, durationMs: 1, ...(unseen ? { unseen } : {}) });
    };
    turn("tx1", 5, "ok");
    assert.equal(store.state.cursors.codex, 5);
    turn("tx2", 9, "interrupted", true);
    assert.equal(store.state.cursors.codex, 5);
    turn("tx3", 12, "error");
    assert.equal(store.state.cursors.codex, 5);
    turn("tx4", 14, "interrupted");
    assert.equal(store.state.cursors.codex, 14, "a turn the human stopped keeps what it was shown");
    // Replaying the log gives the same answer.
    assert.equal(RoomStore.open(room.roomsRoot, store.id).state.cursors.codex, 14);

    // A process that died mid-turn: the next engine closes the turn and hands the messages back.
    store.append({ type: "turn.started", turnId: "tx5", agent: "codex", runId: run, cursor: 20, resume: false, sessionId: null, promptChars: 1 });
    await room.engine.close();
    const reopened = new RoomEngine({ store: RoomStore.open(room.roomsRoot, store.id), runners: {} as never, shimDir: room.shimDir, env: room.env });
    try {
      assert.equal(reopened.state.turns.at(-1)?.status, "interrupted");
      assert.equal(reopened.state.cursors.codex, 14);
    } finally {
      await reopened.close();
    }
  } finally {
    await room.cleanup();
  }
});

test("a native exchange whose reply was not imported yet still gets it, once", async () => {
  const room = createTestRoom();
  try {
    const exchange = { key: "k1", at: new Date().toISOString(), prompt: "hello there", reply: "hi" };
    const engine = room.engine as unknown as { importNative(agent: unknown, exchange: unknown): void; nativeKeys?: Set<string> };
    // A crash after the prompt was appended: only that half is in the log.
    room.store.append({
      type: "message.posted",
      message: { id: "m900", author: "Ivan", kind: "human", text: "hello there", mentions: [], wakes: false, native: { agent: "codex", key: "k1" } },
    });
    engine.nativeKeys = undefined;
    engine.importNative(AGENTS[1], exchange);
    engine.importNative(AGENTS[1], exchange);
    const imported = room.store.state.messages.filter((message) => message.native?.key === "k1");
    assert.deepEqual(imported.map((message) => message.kind), ["human", "agent"]);
  } finally {
    await room.cleanup();
  }
});

test("in parallel turns a file a shell command changed without naming it is credited to neither; one it named is its", async () => {
  const room = createTestRoom();
  try {
    const { store } = room;
    for (const agent of ["claude", "codex"]) {
      store.append({ type: "turn.started", turnId: `t-${agent}`, agent, runId: "r", cursor: 0, resume: false, sessionId: null, promptChars: 1 });
    }
    store.append({ type: "turn.activity", turnId: "t-claude", agent: "claude", activity: { id: "a1", kind: "edit", label: "src/a.ts" } });
    store.append({ type: "turn.activity", turnId: "t-codex", agent: "codex", activity: { id: "a2", kind: "command", label: "sed -i s/x/y/ src/b.ts" } });
    store.append({ type: "turn.activity", turnId: "t-codex", agent: "codex", activity: { id: "a3", kind: "command", label: "npm run format" } });
    const attribute = (room.engine as unknown as { attributeFiles(turnId: string, files: string[]): string[] }).attributeFiles.bind(room.engine);
    assert.deepEqual(attribute("t-claude", ["src/a.ts", "src/b.ts", "src/c.ts"]), ["src/a.ts"]);
    assert.deepEqual(attribute("t-codex", ["src/a.ts", "src/b.ts", "src/c.ts"]), ["src/b.ts"], "sed named b.ts; what the formatter touched is nobody's");
  } finally {
    await room.cleanup();
  }
});

test("a recovered inbox op that was already applied is not applied again", async () => {
  const room = createTestRoom();
  try {
    const paths = workspacePaths(room.store.state.workspace);
    mkdirSync(paths.opsDir, { recursive: true });
    const line = `${JSON.stringify({ op: "ask", text: "Which storage?", nonce: "abc123" })}\n`;
    writeFileSync(join(paths.opsDir, "codex.jsonl"), line);
    room.engine.ingestOps();
    // The process died after applying it but before deleting the file it took.
    writeFileSync(join(paths.opsDir, `codex.jsonl.${spawnSync(process.execPath, ["-e", ""]).pid}.1.taking`), line);
    room.engine.ingestOps();
    assert.equal(room.store.state.table.questions.length, 1);
    assert.ok(existsSync(join(paths.acksDir, "abc123.json")));
  } finally {
    await room.cleanup();
  }
});
