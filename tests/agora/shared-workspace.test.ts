import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RoomEngine, roomsSharingWorkspace } from "../../internal/agora/engine.js";
import { RoomStore } from "../../internal/agora/store.js";
import { DEFAULT_SETTINGS } from "../../internal/agora/types.js";
import { readTurnPatch, writeTurnPatch } from "../../internal/agora/workspace.js";
import { AGENTS } from "./helpers.js";

const agentTool = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agoryx-agent.mjs");

/** Two rooms, same agent ids, one workspace; the engines do not poll (each test drains by hand). */
const twoRooms = (options: { beforeOpen?: (workspace: string) => void } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "agora-shared-"));
  const roomsRoot = join(home, "rooms");
  const workspace = join(home, "ws");
  mkdirSync(workspace, { recursive: true });
  options.beforeOpen?.(workspace);
  const open = (name: string) => {
    const store = RoomStore.create(roomsRoot, {
      name,
      workspace,
      createdWorkspace: true,
      human: "Ivan",
      agents: AGENTS,
      settings: { ...DEFAULT_SETTINGS, network: false },
    });
    return new RoomEngine({ store, runners: {}, opsPollMs: 50, nativePollMs: 0 });
  };
  const a = open("Room A");
  const b = open("Room B");
  return {
    workspace,
    a,
    b,
    async cleanup() {
      await a.close();
      await b.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
};

const agentCli = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [agentTool, ...args], { cwd, env: { PATH: process.env.PATH!, ...env }, encoding: "utf8", timeout: 15_000 });

const tableTexts = (engine: RoomEngine) => engine.store.state.table.questions.map((question) => question.text);

test("two rooms on one workspace keep their own inbox, table file and turn patches", async () => {
  const rooms = twoRooms();
  try {
    const { a, b } = rooms;
    assert.notEqual(a.ws.opsDir, b.ws.opsDir, "each room has its own ops inbox");
    assert.notEqual(a.ws.acksDir, b.ws.acksDir);
    assert.notEqual(a.ws.tableFile, b.ws.tableFile, "each room has its own TABLE.md");

    // An op queued for room A (as a room turn's agent writes it: AGORYX_OPS_DIR is A's) …
    mkdirSync(a.ws.opsDir, { recursive: true });
    writeFileSync(join(a.ws.opsDir, "claude.jsonl"), `${JSON.stringify({ op: "ask", text: "for A only", nonce: "aaaa1111" })}\n`);
    // … is not taken by room B, even when B drains first.
    b.ingestOps();
    assert.deepEqual(tableTexts(b), []);
    a.ingestOps();
    assert.deepEqual(tableTexts(a), ["for A only"]);
    assert.match(readFileSync(a.ws.tableFile, "utf8"), /for A only/);
    assert.doesNotMatch(readFileSync(b.ws.tableFile, "utf8"), /for A only/, "B's table file does not show A's table");

    // Both rooms number turns from t1: neither patch overwrites the other.
    const ts = new Date().toISOString();
    writeTurnPatch(a.ws, { id: "t1", author: "Claude", ts }, [{ path: "a.txt", status: "A", added: 1, removed: 0 }], "diff --git a/a.txt b/a.txt\n+room A\n");
    writeTurnPatch(b.ws, { id: "t1", author: "Codex", ts }, [{ path: "b.txt", status: "A", added: 1, removed: 0 }], "diff --git a/b.txt b/b.txt\n+room B\n");
    assert.match(readTurnPatch(a.ws, "t1")?.patch ?? "", /room A/, "B's t1 did not overwrite A's");
    assert.match(readTurnPatch(b.ws, "t1")?.patch ?? "", /room B/);

    // The agent tool inside a room turn reads its own room's table and turns.
    const inA = { AGORYX_AGENT: "claude", AGORYX_ROOM: a.store.state.id, AGORYX_OPS_DIR: a.ws.opsDir };
    const inB = { AGORYX_AGENT: "claude", AGORYX_ROOM: b.store.state.id, AGORYX_OPS_DIR: b.ws.opsDir };
    assert.match(agentCli(rooms.workspace, ["table", "show"], inA).stdout, /for A only/);
    assert.doesNotMatch(agentCli(rooms.workspace, ["table", "show"], inB).stdout, /for A only/);
    assert.match(agentCli(rooms.workspace, ["diff", "t1"], inA).stdout, /room A/);
    assert.match(agentCli(rooms.workspace, ["diff", "t1"], inB).stdout, /room B/);
  } finally {
    await rooms.cleanup();
  }
});

test("outside a room turn, --as without --room is refused when rooms share the workspace; with --room it reaches that room", async () => {
  const rooms = twoRooms();
  try {
    const { a, b, workspace } = rooms;
    // Someone talking to Claude in its own session: no room variables, only its CLI's hint.
    const own = { CLAUDECODE: "1" };
    const refused = agentCli(workspace, ["table", "ask", "whose?", "--as", "claude"], own);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /2 rooms share this workspace — say which one with --room/);
    assert.ok(refused.stderr.includes(a.store.state.id) && refused.stderr.includes("Room B"), refused.stderr);
    assert.match(agentCli(workspace, ["table", "show"], own).stderr, /--room/, "reading is not guessed either");

    const unknown = agentCli(workspace, ["table", "ask", "x", "--as", "claude", "--room", "nope"], own);
    assert.match(unknown.stderr, /no room 'nope' in this workspace — rooms here: /);

    // From a subdirectory of the workspace, as an agent's own session usually is.
    const sent = agentCli(join(workspace, ".agoryx"), ["table", "ask", "for B", "--as", "claude", "--room", b.store.state.id], own);
    // Nobody polls in these tests: the op waits in B's own inbox.
    assert.match(sent.stdout, /queued/);
    a.ingestOps();
    b.ingestOps();
    assert.deepEqual(tableTexts(a), []);
    assert.deepEqual(tableTexts(b), ["for B"]);
    assert.equal(b.store.state.table.questions[0]!.by, "claude");
    assert.match(agentCli(workspace, ["table", "show", "--room", b.store.state.id], own).stdout, /for B/);
  } finally {
    await rooms.cleanup();
  }
});

test("an op in the old shared inbox is refused with a reason once several rooms share the workspace", async () => {
  const rooms = twoRooms({
    beforeOpen: (workspace) => {
      mkdirSync(join(workspace, ".agoryx", "ops"), { recursive: true });
      writeFileSync(join(workspace, ".agoryx", "ops", "claude.jsonl"), `${JSON.stringify({ op: "ask", text: "whose?", nonce: "legacy01" })}\n`);
    },
  });
  try {
    // Room A opened alone first and took it as its own (the only room then) …
    assert.deepEqual(tableTexts(rooms.a), ["whose?"]);
    // … one arriving there now that two rooms share the workspace belongs to neither.
    writeFileSync(join(rooms.workspace, ".agoryx", "ops", "claude.jsonl"), `${JSON.stringify({ op: "ask", text: "later", nonce: "legacy02" })}\n`);
    rooms.b.ingestOps();
    rooms.a.ingestOps();
    assert.deepEqual(tableTexts(rooms.a), ["whose?"]);
    assert.deepEqual(tableTexts(rooms.b), []);
    const ack = JSON.parse(readFileSync(join(rooms.workspace, ".agoryx", "ops", "acks", "legacy02.json"), "utf8")) as { ok: boolean; error: string };
    assert.equal(ack.ok, false);
    assert.match(ack.error, /2 rooms share this workspace .* --room/);
  } finally {
    await rooms.cleanup();
  }
});

test("two rooms that shared a workspace before the upgrade: an old queued op goes to neither, whichever opens first", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-legacy2-"));
  const workspace = join(home, "ws");
  try {
    mkdirSync(join(workspace, ".agoryx", "ops"), { recursive: true });
    writeFileSync(join(workspace, ".agoryx", "ops", "claude.jsonl"), `${JSON.stringify({ op: "ask", text: "whose?", nonce: "legacy03" })}\n`);
    mkdirSync(join(workspace, ".agoryx", "turns"), { recursive: true });
    writeFileSync(join(workspace, ".agoryx", "turns", "t1.patch"), "# t1 · Codex · 2026-09-01 10:00 UTC\n#\ndiff --git a/a.txt b/a.txt\n+whose turn?\n");
    const create = (name: string) =>
      RoomStore.create(join(home, "rooms"), { name, workspace, createdWorkspace: true, human: "Ivan", agents: AGENTS, settings: { ...DEFAULT_SETTINGS, network: false } });
    const first = create("Old A");
    create("Old B"); // exists in the room logs, not opened yet: no directory of its own in the workspace
    const engine = new RoomEngine({ store: first, runners: {}, opsPollMs: 50, nativePollMs: 0 });
    try {
      assert.deepEqual(tableTexts(engine), [], "the room that opened first does not take it");
      const ack = JSON.parse(readFileSync(join(workspace, ".agoryx", "ops", "acks", "legacy03.json"), "utf8")) as { ok: boolean; error: string };
      assert.match(ack.error, /2 rooms share this workspace .* --room/);
      // The same turn number, author and minute prove nothing: the old t1 is neither room's.
      assert.equal(readTurnPatch(engine.ws, "t1", { files: ["a.txt"], author: "Codex", endedAt: "2026-09-01T10:00:30.000Z", ownsLegacy: () => roomsSharingWorkspace(first).length === 1 }), null);
      // The agent tool sees only the workspace; the room that opened has named the one that did not, so it asks.
      const own = { CLAUDECODE: "1" };
      assert.match(agentCli(workspace, ["table", "ask", "x", "--as", "claude"], own).stderr, /2 rooms share this workspace.*Old B/s);
      assert.doesNotMatch(agentCli(workspace, ["diff", "--room", first.state.id], own).stdout, /whose turn/);
    } finally {
      await engine.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a room from before per-room directories keeps its queued ops and old turn patches, and old shims are still heard", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-legacy-"));
  const workspace = join(home, "ws");
  try {
    const legacy = join(workspace, ".agoryx");
    mkdirSync(join(legacy, "ops"), { recursive: true });
    mkdirSync(join(legacy, "turns"), { recursive: true });
    writeFileSync(join(legacy, "ops", "codex.jsonl"), `${JSON.stringify({ op: "fact", text: "queued before the upgrade", nonce: "old00001" })}\n`);
    writeFileSync(join(legacy, "turns", "t1.patch"), "# t1 · Codex · 2026-09-01 10:00 UTC\n#   a.txt  +1 −0 (new)\n#\ndiff --git a/a.txt b/a.txt\n+old turn\n");
    const store = RoomStore.create(join(home, "rooms"), {
      name: "Old room",
      workspace,
      createdWorkspace: true,
      human: "Ivan",
      agents: AGENTS,
      settings: { ...DEFAULT_SETTINGS, network: false },
    });
    const engine = new RoomEngine({ store, runners: {}, opsPollMs: 50, nativePollMs: 0 });
    try {
      assert.deepEqual(store.state.table.facts.map((fact) => fact.text), ["queued before the upgrade"]);
      // An agent still holding the old variables (AGORYX_OPS_DIR=.agoryx/ops) is heard too.
      const old = agentCli(workspace, ["table", "fact", "old shim"], { AGORYX_AGENT: "codex", AGORYX_OPS_DIR: join(legacy, "ops") });
      assert.match(old.stdout, /queued/);
      engine.ingestOps();
      assert.deepEqual(store.state.table.facts.map((fact) => fact.text), ["queued before the upgrade", "old shim"]);
      // The old turn patch is still what `agoryx diff t1` shows while this is the only room here.
      assert.match(agentCli(workspace, ["diff", "t1"], { CLAUDECODE: "1" }).stdout, /old turn/);
      const owns = () => roomsSharingWorkspace(store).length === 1;
      assert.equal(readTurnPatch(engine.ws, "t1", { files: ["a.txt"], author: "Codex" }), null, "without knowing who else had the workspace, an old patch is nobody's");
      assert.match(readTurnPatch(engine.ws, "t1", { files: ["a.txt"], ownsLegacy: owns, author: "Codex" })?.patch ?? "", /old turn/);
      assert.equal(readTurnPatch(engine.ws, "t1", { files: ["a.txt"], ownsLegacy: owns, author: "Claude" }), null, "someone else's t1 is not taken for this one");
      assert.match(readTurnPatch(engine.ws, "t1", { files: ["a.txt"], ownsLegacy: owns, author: "Codex", endedAt: "2026-09-01T10:00:41.000Z" })?.patch ?? "", /old turn/);
      assert.equal(readTurnPatch(engine.ws, "t1", { files: ["a.txt"], ownsLegacy: owns, author: "Codex", endedAt: "2026-09-02T10:00:41.000Z" }), null, "nor a t1 by the same agent in another room, another day");
    } finally {
      await engine.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
