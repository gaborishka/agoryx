import assert from "node:assert/strict";
import { test } from "node:test";
import { folds, layoutRooms } from "../../ui/src/lib/sidebar";
import type { AttentionItem } from "../../internal/agora/types";
import type { RoomSummary } from "../../ui/src/lib/types";

const room = (id: string, extra: Partial<RoomSummary> = {}): RoomSummary => ({
  id,
  name: id,
  workspace: "/w",
  createdAt: "2026-10-03T08:00:00Z",
  updatedAt: "2026-10-03T08:00:00Z",
  messages: 1,
  running: false,
  ...extra,
});
const busy = (since: string, extra: Partial<RoomSummary> = {}): Partial<RoomSummary> => ({ running: true, working: [{ agent: "claude", since }], ...extra });
const waiting = { reason: "mention" } as unknown as AttentionItem;

test("a room folds into Working while its agents work and nothing waits for the human", () => {
  assert.equal(folds(room("a", busy("2026-10-03T08:01:00Z")), null), true);
  assert.equal(folds(room("a", { running: false, working: [{ agent: "codex", since: "2026-10-03T08:01:00Z" }] }), null), true);
  assert.equal(folds(room("a"), null), false, "an idle room stays");
  assert.equal(folds(room("a", busy("2026-10-03T08:01:00Z", { waiting })), null), false, "a room that waits for the human stays, even mid-run");
  assert.equal(folds(room("a", busy("2026-10-03T08:01:00Z")), "a"), false, "the open room never folds");
});

test("Working lists the newest work first; the list keeps the rest in order", () => {
  const rooms = [room("idle1"), room("old", busy("2026-10-03T08:01:00Z")), room("idle2"), room("new", busy("2026-10-03T08:05:00Z"))];
  const view = layoutRooms(rooms, null, true);
  assert.equal(view.grouped, false);
  assert.deepEqual(view.rooms.map((r) => r.id), ["idle1", "idle2"]);
  assert.deepEqual(view.working.map((r) => r.id), ["new", "old"]);
});

test("with folding off, nothing goes to Working", () => {
  const view = layoutRooms([room("a", busy("2026-10-03T08:01:00Z")), room("b")], null, false);
  assert.deepEqual(view.rooms.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(view.working, []);
});

test("a project whose rooms all work keeps its head and says how many are in Working", () => {
  const rooms = [
    room("p1", busy("2026-10-03T08:01:00Z", { folder: "/repo/pelican", projectHash: "h1", projectName: "Pelican" })),
    room("p2", busy("2026-10-03T08:02:00Z", { folder: "/repo/pelican", projectHash: "h1", projectName: "Pelican" })),
    room("e1", { folder: "/repo/e2e" }),
  ];
  const view = layoutRooms(rooms, null, true);
  assert.equal(view.grouped, true);
  const pelican = view.groups.find((g) => g.project === "h1");
  assert.ok(pelican);
  assert.equal(pelican.label, "Pelican");
  assert.deepEqual(pelican.rooms, []);
  assert.equal(pelican.busy, 2);
  assert.deepEqual(view.groups.find((g) => g.key === "/repo/e2e")?.rooms.map((r) => r.id), ["e1"]);
  assert.deepEqual(view.working.map((r) => r.id), ["p2", "p1"]);
});

test("a busy thread folds on its own; its idle parent stays", () => {
  const rooms = [room("parent", { folder: "/repo", projectHash: "h" }), room("thread", busy("2026-10-03T08:01:00Z", { folder: "/repo", projectHash: "h", parent: "parent" }))];
  const view = layoutRooms(rooms, null, true);
  assert.deepEqual(view.groups[0]?.rooms.map((r) => r.id), ["parent"]);
  assert.deepEqual(view.working.map((r) => r.id), ["thread"]);
});
