import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoomEngine } from "../../internal/agora/engine.js";
import { projectBriefing, projectUpdate, readProject, setProjectField } from "../../internal/agora/projects.js";
import { buildTurnPrompt } from "../../internal/agora/prompts.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { changeRoomMode, createRoom } from "../../internal/agora/service.js";
import { ensureAgentShim } from "../../internal/agora/workspace.js";
import { createTestRoom, writeFakeBins, withTimeout } from "./helpers.js";

const PASS = { reply: "::pass::" };

test("a Work room's agents get the project when their session starts, then only what someone else changed", async () => {
  const room = createTestRoom({
    agoraHome: true,
    rules: [{ agent: "codex", once: true, table: [["project", "set", "instructions", "INSTR-BY-CODEX"]], reply: "::pass::" }, PASS],
  });
  try {
    const key = room.store.state.workspace;
    setProjectField(key, "goal", "GOAL-ONE", { by: "Ivan" }, room.env);
    room.engine.postHuman("Start");
    await withTimeout(room.engine.waitIdle());
    const first = room.invocations("claude")[0]!.prompt!;
    assert.match(first, /Project: ws — this folder's project, shared by every Work room in it/);
    assert.match(first, /Goal — by Ivan:\n {4}GOAL-ONE/);
    assert.match(first, /project set goal\|instructions\|name/);
    // Codex wrote through its own CLI, from its turn: the write says so.
    const written = readProject(key, room.env);
    assert.equal(written.instructions, "INSTR-BY-CODEX");
    assert.equal(written.events.at(-1)!.by, "codex");
    assert.equal(written.events.at(-1)!.from?.room, room.store.state.id);
    // What each session holds is the seq its prompt carried.
    assert.deepEqual(room.store.state.projectSeen, { claude: 1, codex: 1 });

    setProjectField(key, "goal", "GOAL-TWO", { by: "Ivan" }, room.env);
    room.engine.postHuman("Again");
    await withTimeout(room.engine.waitIdle());
    const claude = room.invocations("claude")[1]!.prompt!;
    const codex = room.invocations("codex")[1]!.prompt!;
    for (const prompt of [claude, codex]) {
      assert.doesNotMatch(prompt, /this folder's project, shared by every Work room/, "a running session gets no second briefing");
      assert.match(prompt, /── The project \(ws\) changed since your last turn:[\s\S]*Ivan wrote the goal:\n {4}GOAL-TWO/);
    }
    assert.match(claude, /codex in "Test room" wrote the instructions:\n {4}INSTR-BY-CODEX/);
    assert.doesNotMatch(codex, /wrote the instructions/, "its own write it already knows");
    assert.deepEqual(room.store.state.projectSeen, { claude: 3, codex: 3 });

    // Nothing new: nothing said.
    room.engine.postHuman("Once more");
    await withTimeout(room.engine.waitIdle());
    assert.doesNotMatch(room.invocations("claude")[2]!.prompt!, /The project/);
  } finally {
    await room.cleanup();
  }
});

test("an empty project adds one line; Chat gets none of it; a switch to Work briefs it afresh", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-project-prompts-"));
  const env: NodeJS.ProcessEnv = { ...process.env, AGORYX_HOME: home, AGORYX_LIVE: "0" };
  const bins = writeFakeBins(home);
  const shimDir = join(home, "shim");
  ensureAgentShim(shimDir);
  const runEnv = { ...env, FAKE_LOG: join(home, "fake.log"), FAKE_STATE: join(home, "fake"), FAKE_RULES: join(home, "none.json"), CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  try {
    const folder = join(home, "folder");
    mkdirSync(folder);
    // Empty: one line on how to write it.
    const empty = projectBriefing(readProject(folder, env), "agoryx");
    assert.equal(empty.split("\n").length, 2);
    assert.match(empty, /Nothing is written for it yet\. `agoryx project set goal\|instructions "…"`/);
    setProjectField(folder, "instructions", "INSTR-MARK", { by: "Ivan" }, env);
    const project = readProject(folder, env);

    const store = createRoom({ name: "Talk", env });
    const agent = store.state.agents[0]!;
    // Even handed a project block, a Chat prompt carries none of it.
    const chatPrompt = buildTurnPrompt({ state: store.state, agent, agentCli: { command: "agoryx" }, events: [], turnsLeft: null, fresh: true, rejoin: false, project: projectBriefing(project, "agoryx") });
    assert.doesNotMatch(chatPrompt, /INSTR-MARK|Project:/);
    const chatDelta = buildTurnPrompt({ state: store.state, agent, agentCli: { command: "agoryx" }, events: [], turnsLeft: null, fresh: false, rejoin: false, project: projectUpdate(project, 0, { room: store.state.id, agent: agent.id }) });
    assert.doesNotMatch(chatDelta, /INSTR-MARK/);

    store.append({ type: "turn.started", turnId: "t9", agent: agent.id, runId: "r", cursor: store.state.seq, resume: false, sessionId: null, promptChars: 1, project: 1 });
    store.append({ type: "turn.ended", turnId: "t9", agent: agent.id, status: "pass", durationMs: 1 });
    assert.equal(store.state.projectSeen?.[agent.id], 1);
    changeRoomMode(store, { mode: "work", dir: folder }, env);
    assert.deepEqual(store.state.projectSeen, {}, "a mode switch starts every session afresh");

    const engine = new RoomEngine({ store, runners: { claude: createClaudeRunner(bins.fakeClaude), codex: createCodexRunner(bins.fakeCodex) }, shimDir, env: runEnv, opsPollMs: 50, nativePollMs: 50 });
    try {
      engine.postHuman("Now work");
      await withTimeout(engine.waitIdle());
      const turns = store.events.flatMap((event) => (event.type === "turn.started" && event.seq > (store.state.modeSince ?? 0) ? [event] : []));
      assert.ok(turns.length >= 2);
      assert.ok(turns.every((event) => event.project === 1 && event.resume === false));
    } finally {
      await engine.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a turn that failed gives the project's changes again", () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-project-prompts-"));
  try {
    const store = createRoom({ name: "W", dir: home, env: { ...process.env, AGORYX_HOME: join(home, ".agora") } });
    const start = (turnId: string, project: number) =>
      store.append({ type: "turn.started", turnId, agent: "claude", runId: "r1", cursor: store.state.seq, resume: true, sessionId: "s", promptChars: 1, project });
    start("t1", 2);
    store.append({ type: "turn.ended", turnId: "t1", agent: "claude", status: "ok", durationMs: 1 });
    start("t2", 5);
    store.append({ type: "turn.ended", turnId: "t2", agent: "claude", status: "error", durationMs: 1 });
    assert.equal(store.state.projectSeen?.claude, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
