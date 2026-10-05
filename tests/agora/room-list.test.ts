import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomStore } from "../../internal/agora/store.js";
import { AGENTS } from "./helpers.js";

const settings = { budget: 8, turnTimeoutMs: 60_000, access: "workspace" as const, network: false, autoCommit: false, doc: null };

test("the room list reads a room again only when its log changed, and forgets a room that is gone", () => {
  const home = mkdtempSync(join(tmpdir(), "agora-room-list-"));
  try {
    const root = join(home, "rooms");
    mkdirSync(root);
    const a = RoomStore.create(root, { name: "A", workspace: join(home, "a"), createdWorkspace: true, human: "Ivan", agents: AGENTS, settings });
    const b = RoomStore.create(root, { name: "B", workspace: join(home, "b"), createdWorkspace: true, human: "Ivan", agents: AGENTS, settings });
    const first = RoomStore.list(root);
    assert.deepEqual(first.map((room) => room.name).sort(), ["A", "B"]);
    const again = RoomStore.list(root);
    assert.equal(again.find((room) => room.id === a.id), first.find((room) => room.id === a.id), "an unchanged room: the summary read before");

    a.append({ type: "message.posted", message: { id: "m1", author: "Ivan", kind: "human", text: "hello there", mentions: [] } } as never);
    const after = RoomStore.list(root);
    assert.equal(after.find((room) => room.id === a.id)?.messages, 1);
    assert.equal(after.find((room) => room.id === a.id)?.lastMessage?.text, "hello there");
    assert.equal(after.find((room) => room.id === b.id), first.find((room) => room.id === b.id));

    rmSync(join(root, b.id), { recursive: true, force: true });
    assert.deepEqual(RoomStore.list(root).map((room) => room.id), [a.id]);
    assert.equal(RoomStore.resolveId(root, "A", home), a.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
