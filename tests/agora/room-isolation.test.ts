import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RoomEngine } from "../../internal/agora/engine.js";
import { RoomStore } from "../../internal/agora/store.js";
import { readTurnPatch, writeTurnPatch } from "../../internal/agora/workspace.js";
import { createTestRoom } from "./helpers.js";

const pair = () => {
  const first = createTestRoom();
  const store = RoomStore.create(first.roomsRoot, {
    name: "Second room", workspace: first.store.state.workspace,
    createdWorkspace: false, human: "Ivan", agents: first.store.state.agents,
    settings: first.store.state.settings,
  });
  const second = new RoomEngine({ store, runners: {}, nativePollMs: 0 });
  return { first, second, async cleanup() { await second.close(); await first.cleanup(); } };
};

test("two engines in one workspace cannot consume one another's table ops or acknowledgments", async () => {
  const rooms = pair();
  try {
    const { first, second } = rooms;
    writeFileSync(join(first.engine.ws.opsDir, "codex.jsonl"), JSON.stringify({ op: "ask", text: "Only first room", nonce: "first123" }) + "\n");
    second.ingestOps();
    assert.equal(second.state.table.questions.length, 0, "the other engine must not steal the op");
    first.engine.ingestOps();
    assert.equal(first.store.state.table.questions.length, 1);
    assert.notEqual(first.engine.ws.acksDir, second.ws.acksDir);
  } finally { await rooms.cleanup(); }
});

test("same numbered turn patches remain independently readable", async () => {
  const rooms = pair();
  try {
    const turn = { id: "t1", author: "codex", ts: new Date().toISOString() };
    writeTurnPatch(rooms.first.engine.ws, turn, [], "first patch\n");
    writeTurnPatch(rooms.second.ws, turn, [], "second patch\n");
    assert.equal(readTurnPatch(rooms.first.engine.ws, "t1")?.patch, "first patch\n");
    assert.equal(readTurnPatch(rooms.second.ws, "t1")?.patch, "second patch\n");
  } finally { await rooms.cleanup(); }
});

test("opening a second room does not overwrite the first table projection", async () => {
  const rooms = pair();
  try {
    assert.match(readFileSync(rooms.first.engine.ws.tableFile, "utf8"), /Test room/);
    assert.match(readFileSync(rooms.second.ws.tableFile, "utf8"), /Second room/);
  } finally { await rooms.cleanup(); }
});

test("legacy patch with same turn id, author and minute is not proof of ownership", async () => {
  const rooms = pair();
  try {
    const { workspacePaths } = await import("../../internal/agora/workspace.js");
    const endedAt = "2026-09-29T03:40:30.000Z";
    writeTurnPatch(workspacePaths(rooms.first.store.state.workspace), { id: "t1", author: "Codex", ts: endedAt }, [], "belongs to second room\n");
    assert.equal(readTurnPatch(rooms.first.engine.ws, "t1", {
      files: ["same.ts"], author: "Codex", endedAt,
    }), null, "ambiguous old patches must not be attributed using author and clock proximity");
  } finally { await rooms.cleanup(); }
});


test("room identity overrides old shared paths when reading a table", async () => {
  const rooms = pair();
  try {
    const root = rooms.first.store.state.workspace;
    writeFileSync(join(root, ".agoryx", "TABLE.md"), "foreign stale table");
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin/agoryx-agent.mjs"), "table", "show"], {
      cwd: root, encoding: "utf8", env: { PATH: process.env.PATH,
        AGORYX_ROOM: rooms.first.store.id, AGORYX_OPS_DIR: join(root, ".agoryx", "ops"),
        AGORYX_TABLE: join(root, ".agoryx", "TABLE.md"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Test room/);
    assert.doesNotMatch(result.stdout, /foreign stale table/);
  } finally { await rooms.cleanup(); }
});

test("an old shared inbox variable cannot bypass ambiguous room selection", async () => {
  const rooms = pair();
  try {
    const root = rooms.first.store.state.workspace;
    writeFileSync(join(root, ".agoryx", "TABLE.md"), "ambiguous legacy table");
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin/agoryx-agent.mjs"), "table", "show"], {
      cwd: root, encoding: "utf8", env: { PATH: process.env.PATH,
        AGORYX_OPS_DIR: join(root, ".agoryx", "ops"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--room/);
    assert.doesNotMatch(result.stdout, /ambiguous legacy table/);
  } finally { await rooms.cleanup(); }
});
