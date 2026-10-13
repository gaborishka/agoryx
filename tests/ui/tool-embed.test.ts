import assert from "node:assert/strict";
import { test } from "node:test";
import { toolEmbedId, toolEmbedMessage, toolEmbedState } from "../../ui/src/lib/tool-embed.js";

test("a tool fence names exactly one table tool", () => {
  assert.equal(toolEmbedId("W2"), "W2");
  assert.equal(toolEmbedId("  W12\n"), "W12");
  for (const fence of ["", "W0", "w2", "W2 W3", "P1", '{"version":1}', "W2\nextra"]) assert.equal(toolEmbedId(fence), null, fence);
});

test("only a posted message pins a version", () => {
  assert.equal(toolEmbedMessage("m:m14"), "m14");
  for (const source of [undefined, "", "w:W2", "o:P1", "m:14", "m:m0"]) assert.equal(toolEmbedMessage(source), null, String(source));
});

test("the current version is reachable while it is still a native tool on the table", () => {
  const tool = { kind: "interactive", ui: {} };
  assert.deepEqual(toolEmbedState(10, { ...tool, seq: 5, contentSeq: 10 }), { changed: false, reachable: true, note: null });
  assert.deepEqual({ ...toolEmbedState(10, { ...tool, seq: 5, contentSeq: 20 }), note: null }, { changed: true, reachable: true, note: null });
  assert.equal(toolEmbedState(10, { ...tool, seq: 10 }).changed, false);
  assert.equal(toolEmbedState(10, { ...tool, seq: 5, contentSeq: 20, archived: true }).reachable, false);
  assert.equal(toolEmbedState(10, { kind: "custom", seq: 5, contentSeq: 20 }).reachable, false);
  assert.equal(toolEmbedState(10, null).reachable, false);
  assert.match(toolEmbedState(10, null).note!, /removed/);
});
