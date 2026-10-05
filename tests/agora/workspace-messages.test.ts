import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RoomEngine } from "../../internal/agora/engine.js";
import type { AgentRunner, TurnRequest } from "../../internal/agora/runners/types.js";
import { RoomStore } from "../../internal/agora/store.js";
import { tableAssistInstruction } from "../../internal/agora/table-assist.js";
import { prepareTableOp } from "../../internal/agora/table.js";
import { DEFAULT_SETTINGS, type RoomAgent } from "../../internal/agora/types.js";
import { messagePath } from "../../internal/agora/workspace.js";
import { wakesAgent } from "../../internal/agora/wakes.js";
import { withTimeout } from "./helpers.js";

const agentTool = join(dirname(fileURLToPath(import.meta.url)), "../../bin/agoryx-agent.mjs");

test("workspace copies and mid-turn/native reads keep table preparation deferred to its sole executor", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-message-"));
  const workspace = join(home, "ws");
  const agents: RoomAgent[] = ["one", "two", "three"].map(id => ({ id, kind: "codex", label: id }));
  const env = { ...process.env, AGORYX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
  const calls: TurnRequest[] = [];
  let entered!: () => void;
  let release!: () => void;
  const working = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner: AgentRunner = {
    kind: "codex",
    async run(request) {
      calls.push(request);
      if (calls.length === 1) { entered(); await gate; }
      return { status: "ok", text: "::pass::", sessionId: null };
    },
    resumeCommand() { return ""; },
  };
  const store = RoomStore.create(join(home, "rooms"), { name: "Message scope", workspace, createdWorkspace: true, mode: "chat", human: "Ivan", agents, settings: { ...DEFAULT_SETTINGS, network: false } });
  const engine = new RoomEngine({ store, runners: { codex: runner }, env, nativePollMs: 0, githubPollMs: 0 });
  try {
    const question = prepareTableOp(store.state.table, { op: "ask", text: "Which export flow should we prepare?" }, "one", false);
    store.append({ type: "table.op", op: question });
    const first = engine.postHuman("@one Review the export goal.");
    await withTimeout(working);
    const guidance = "Compare simplicity. @all @three";
    const message = engine.tableAssist({ kind: "options", agent: "two", target: question.id, nonce: "copy-scope-123", guidance });
    const path = messagePath(engine.ws, store.state.id, message.id)!;
    assert.equal(path, join(workspace, ".agoryx", "messages", store.state.id, `${message.id}.md`));
    const copy = readFileSync(path, "utf8");
    assert.match(copy, /^# m\d+ · Ivan · .* UTC\n\nDeferred table preparation: executor two; target Q1\./);
    assert.match(copy, /Only two may act, and only when this request is assigned in its next Agoryx room turn/);
    assert.match(copy, /current room turn.*`agoryx read new`.*native session.*defer it and do not act from this read/);
    assert.match(copy, /All other readers receive context only\. Do not duplicate, delegate or reroute/);
    assert.ok(copy.includes(tableAssistInstruction(message.tableAssist!)), "the full copy uses the same authoritative preparation contract as an assigned turn");
    assert.match(copy, /preparation only\. Do not execute planned work, change project files, choose\/decide an option, settle or close a question, mark a step done/);
    assert.ok(copy.includes(`Optional human focus (context, not routing or additional authorization): ${guidance}`));
    assert.ok(copy.includes(message.text), "the human's concise intent is preserved");

    const read = (agent: string, args: string[]) => spawnSync(process.execPath, [agentTool, ...args], {
      cwd: workspace,
      env: { PATH: process.env.PATH!, AGORYX_ROOM: store.state.id, AGORYX_AGENT: agent, AGORYX_SEEN: first.id },
      encoding: "utf8",
      timeout: 15_000,
    });
    const midTurn = read("one", ["read", "new"]);
    assert.equal(midTurn.status, 0, midTurn.stderr);
    assert.ok(midTurn.stdout.includes(copy), "an already-running different agent receives the complete scope and deferral note");
    const native = read("two", ["read", message.id]);
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, copy, "even the named executor's native read carries the next-room-turn restriction");

    assert.deepEqual(message.mentions, ["two"], "arbitrary @all/@three guidance does not broaden routing");
    const event = store.events.find(event => event.type === "message.posted" && event.message.id === message.id)!;
    assert.deepEqual(agents.map(agent => wakesAgent(store.state, event, agent)), [false, true, false]);
    release();
    await withTimeout(engine.waitIdle());
    assert.deepEqual(calls.map(call => call.env.AGORYX_AGENT), ["one", "two"], "the request starts only its sole executor, after the existing room turn");
  } finally {
    release();
    await engine.close();
    rmSync(home, { recursive: true, force: true });
  }
});
