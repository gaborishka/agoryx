import assert from "node:assert/strict";
import { test } from "node:test";
import { nestThreads } from "../../ui/src/lib/room";
import type { RoomSummary } from "../../ui/src/lib/types";

const room = (id: string, parent?: string): RoomSummary => ({
  id,
  name: id,
  workspace: "/w",
  createdAt: "",
  updatedAt: "",
  messages: 0,
  running: false,
  ...(parent ? { parent } : {}),
});

test("threads sit right under the room they came from, threads of threads deeper", () => {
  const got = nestThreads([room("t2", "main"), room("other"), room("main"), room("t1", "main"), room("t1a", "t1")]);
  assert.deepEqual(
    got.map(({ room, depth }) => [room.id, depth]),
    [
      ["other", 0],
      ["main", 0],
      ["t2", 1],
      ["t1", 1],
      ["t1a", 2],
    ],
  );
});

test("a thread whose room is not listed stays where it is", () => {
  assert.deepEqual(
    nestThreads([room("t", "gone"), room("a")]).map(({ room, depth }) => [room.id, depth]),
    [
      ["t", 0],
      ["a", 0],
    ],
  );
});

test("a loop of parents still lists every room once", () => {
  const got = nestThreads([room("a", "b"), room("b", "a")]);
  assert.deepEqual(got.map(({ room }) => room.id).sort(), ["a", "b"]);
});
