import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveToolEmbed, ToolEmbedError } from "../../internal/agora/tool-embed.js";
import { prepareTableOp } from "../../internal/agora/table.js";
import { RoomStore } from "../../internal/agora/store.js";
import type { TableOpInput } from "../../internal/agora/types.js";
import { createTestRoom } from "./helpers.js";

const ui = (value = 3) => ({ version: 1, description: "Illustrative", inputs: [{ id: "people", label: "People", type: "number", min: 1, max: 10, value }], root: { type: "input", id: "people" } });
const publish = (value = 3, target?: string) => ({ op: "component", title: "Planner", kind: "interactive", ui: ui(value), refs: [], ...(target ? { target } : {}) });
const op = (store: RoomStore, input: unknown, human = false) => store.append({ type: "table.op", op: prepareTableOp(store.state.table, input as TableOpInput, human ? "Ivan" : "codex", human) });
const message = (store: RoomStore, id = "m1") => store.append({ type: "message.posted", message: { id, author: "codex", kind: "agent", text: "```tool\nW1\n```", mentions: [], wakes: false } });

test("chat lookup pins model and scenarios to message time across refinement and log reload", async () => {
  const room = createTestRoom();
  try {
    const created = op(room.store, publish());
    op(room.store, { op: "component-input", target: "W1", revision: created.seq, inputSeq: 0, values: { people: 4 } }, true);
    const posted = message(room.store);
    const pinnedBefore = resolveToolEmbed(room.store.events, room.store.state, "m1", "W1").pinned;
    op(room.store, { op: "component-input", target: "W1", revision: created.seq, inputSeq: pinnedBefore.inputSnapshot!.seq, values: { people: 7 } }, true);
    const saved = resolveToolEmbed(room.store.events, room.store.state, "m1", "W1");
    assert.equal(saved.pinned.inputSnapshot!.values.people, 4);
    assert.equal(saved.current!.inputSnapshot!.values.people, 7);
    const updated = op(room.store, publish(6, "W1"));
    const reopened = RoomStore.open(room.roomsRoot, room.store.id);
    const result = resolveToolEmbed(reopened.events, reopened.state, "m1", "W1");
    assert.equal(result.messageSeq, posted.seq);
    assert.deepEqual(result.pinned, pinnedBefore);
    assert.equal(result.pinned.contentSeq, created.seq);
    assert.equal(result.current!.contentSeq, updated.seq);
    assert.equal(result.current!.ui!.inputs[0]!.value, 6);
    result.current!.title = "Mutated client copy";
    assert.equal(reopened.state.table.components![0]!.title, "Planner");
    // Existing server authority rejects writes made against the historical model.
    assert.throws(() => op(reopened, { op: "component-input", target: "W1", revision: created.seq, inputSeq: 0, values: { people: 5 } }, true), /changed/);
  } finally { await room.cleanup(); }
});

test("archive and an absent current item retain a historical embed", async () => {
  const room = createTestRoom();
  try {
    op(room.store, publish());
    message(room.store);
    op(room.store, { op: "archive", target: "W1" });
    const archived = resolveToolEmbed(room.store.events, room.store.state, "m1", "W1");
    assert.equal(archived.current!.archived, true);
    assert.equal(archived.pinned.archived, undefined);
    // Defensive lookup when a current projection lacks an item (deletion is not a component operation).
    room.store.state.table.components = [];
    const deleted = resolveToolEmbed(room.store.events, room.store.state, "m1", "W1");
    assert.equal(deleted.current, null);
    assert.equal(deleted.pinned.title, "Planner");
  } finally { await room.cleanup(); }
});

test("lookup rejects malformed, missing, future and non-native references", async () => {
  const room = createTestRoom();
  try {
    message(room.store);
    op(room.store, publish());
    assert.throws(() => resolveToolEmbed(room.store.events, room.store.state, "m1", "W1"), /time of this message/);
    assert.throws(() => resolveToolEmbed(room.store.events, room.store.state, "m2", "W1"), /No such message/);
    for (const id of ["../W1", "W0", "W1@2", "W1\n"]) assert.throws(() => resolveToolEmbed(room.store.events, room.store.state, "m1", id), (error: unknown) => error instanceof ToolEmbedError && error.status === 400);
    op(room.store, { op: "component", title: "Custom", kind: "custom", body: "<html></html>", refs: [] });
    message(room.store, "m2");
    assert.throws(() => resolveToolEmbed(room.store.events, room.store.state, "m2", "W2"), /No native tool/);
    op(room.store, { op: "component", title: "Other kind", kind: "custom", body: "changed", target: "W1", refs: [] });
    message(room.store, "m3");
    assert.throws(() => resolveToolEmbed(room.store.events, room.store.state, "m3", "W1"), /No native tool/);
  } finally { await room.cleanup(); }
});
