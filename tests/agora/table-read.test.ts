import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { parseTableCommand } from "../../internal/agora/table-cli.js";
import { renderTableComponentMarkdown, renderTableMarkdown, summarizeTable } from "../../internal/agora/table.js";
import { workspacePaths } from "../../internal/agora/workspace.js";
import { createTestRoom } from "./helpers.js";

const run = promisify(execFile);
const shim = resolve("bin/agoryx-agent.mjs");
const bodies = ["---\ntitle: A result\n---\nThe content", "---\nA horizontal rule, then content", "-- a prose note\nAnother line"];

test("quoted Markdown beginning with hyphens is a body, while a following flag is not its value", () => {
  for (const body of bodies) {
    for (const [verb, args] of [
      ["component", ["Result", "--kind", "custom"]],
      ["propose", ["Route"]],
      ["edit", ["P1"]],
    ] as const) assert.equal(parseTableCommand(verb, [...args, "--body", body]).body, body);
  }
  for (const verb of ["component", "propose", "edit"]) {
    assert.throws(() => parseTableCommand(verb, ["Result", "--body", "--file", "result.html"]), /--body needs a value/);
  }
});

test("human and agent component reads return the complete content and never change the room", async () => {
  const room = createTestRoom({ agoraHome: true });
  const body = "```html\n<button onclick=\"this.textContent='Ready'\">Exact authored content</button>\n```";
  try {
    room.engine.tableOp({ op: "component", title: "Interactive result", kind: "custom", refs: [], body }, "codex");
    room.engine.tableOp({ op: "archive", target: "W1" }, "Ivan");
    const seq = room.store.state.seq;
    const env = { ...room.env, AGORYX_TURN_FILE: "", AGORYX_AGENT: "codex", AGORYX_ROOM: room.store.id };
    const cli = (args: string[]) => run(process.execPath, [shim, "table", ...args], { cwd: room.store.state.workspace, env, timeout: 10_000 });
    const agentRead = await cli(["show", "w1"]);
    assert.ok(agentRead.stdout.includes(body), "custom code is readable without truncation");
    assert.match(agentRead.stdout, /archived/);
    assert.match(agentRead.stdout, /Content by: codex/);
    const humanRead = await run(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("cmd/agoryx/main.ts"), "table", "show", "W1", "--room", room.store.id], {
      cwd: room.home, env: { ...room.env, AGORYX_OPS_DIR: "", AGORYX_AGENT: "", AGORYX_TURN_FILE: "" }, timeout: 10_000,
    });
    assert.equal(humanRead.stdout, renderTableComponentMarkdown(room.store.state.table, "W1"));
    await assert.rejects(cli(["show", "W9"]), /no component W9/);
    await assert.rejects(cli(["show", "P1"]), /component id/);
    await assert.rejects(cli(["show", "W1", "--as"]), /--as needs a value/);
    assert.equal(room.store.state.seq, seq);
    assert.equal(room.store.state.turns.length, 0);
  } finally { await room.cleanup(); }
});

test("agent parser preserves quoted Markdown and rejects malformed identity and body flags without writes", async () => {
  const room = createTestRoom();
  try {
    const env = { ...room.env, AGORYX_TURN_FILE: "", AGORYX_AGENT: "codex", AGORYX_ROOM: room.store.id };
    const cli = (args: string[]) => run(process.execPath, [shim, "table", ...args], { cwd: room.store.state.workspace, env, timeout: 10_000 });
    await cli(["propose", "Route", "--body", bodies[0]!]);
    assert.equal(room.store.state.table.options[0]?.body, bodies[0]);
    await cli(["edit", "P1", "--body", bodies[1]!]);
    assert.equal(room.store.state.table.options[0]?.body, bodies[1]);
    await cli(["component", "Result", "--kind", "custom", "--body", bodies[0]!]);
    assert.equal(room.store.state.table.components?.[0]?.body, bodies[0]);
    const seq = room.store.state.seq;
    for (const args of [
      ["brief", "Status", "--as"], ["show", "--as="], ["brief", "Status", "--room", "--as", "codex"],
      ["propose", "Bad", "--body", "--file", "result.html"], ["show", "--bogus"],
    ]) await assert.rejects(cli(args), /needs a value|does not take/);
    assert.equal(room.store.state.seq, seq);
  } finally { await room.cleanup(); }
});

test("an unanswered component read fails rather than claiming a queued result", async () => {
  const room = createTestRoom();
  try {
    await room.engine.close();
    const env = { ...room.env, AGORYX_TURN_FILE: "", AGORYX_AGENT: "codex", AGORYX_ROOM: room.store.id, AGORYX_ACK_MS: "50" };
    await assert.rejects(run(process.execPath, [shim, "table", "show", "W1"], { cwd: room.store.state.workspace, env, timeout: 5000 }), /room did not answer/);
    const paths = workspacePaths(room.store.state.workspace, room.store.id);
    assert.equal(readdirSync(paths.opsDir).filter(name => name.endsWith(".op")).length, 0, "an obsolete read must not linger in the inbox");
  } finally { await room.cleanup(); }
});

test("full table and turn summaries distinguish historical choices and preserve their original meaning", async () => {
  const room = createTestRoom();
  try {
    const move = (raw: Record<string, unknown>) => room.engine.tableOp(raw, "codex");
    move({ op: "ask", text: "Which route?" });
    move({ op: "propose", title: "Original route", q: "Q1" });
    move({ op: "propose", title: "Second route", q: "Q1" });
    move({ op: "decide", target: "P1" });
    move({ op: "reopen", target: "P1" });
    move({ op: "edit", target: "P1", title: "Changed route" });
    move({ op: "decide", target: "P2" });
    const full = renderTableMarkdown(room.store.state.table, "Room");
    assert.match(full, /Previous decision \(no longer current\) №1 \(D1\): P1 "Original route"/);
    assert.match(full, /Current decision №2 \(D2\): P2 "Second route"/);
    const summary = summarizeTable(room.store.state.table);
    assert.match(summary, /previous decision \(no longer current\): P1 "Original route"/);
    assert.match(summary, /decided: P2 "Second route"/);
    assert.doesNotMatch(summary, /decided: P1/);
  } finally { await room.cleanup(); }
});
