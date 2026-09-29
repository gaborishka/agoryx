import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RoomEngine, RoomLockedError } from "../../internal/agora/engine.js";
import { promptNorms } from "../../internal/agora/prompts.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { eventPatch } from "../../internal/agora/snapshot.js";
import { RoomStore } from "../../internal/agora/store.js";
import { openOnTable, renderTableMarkdown, summarizeTable } from "../../internal/agora/table.js";
import { createTestRoom, tableOutputs, withTimeout } from "./helpers.js";

const kinds = (room: ReturnType<typeof createTestRoom>) =>
  room.store.state.messages.map((message) => `${message.author}:${message.kind}`);

test("blind first round, then each agent sees the other and passes → quiet", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "Here is the conversation so far", reply: "Claude: use SQLite." },
      { agent: "codex", match: "Here is the conversation so far", reply: "Codex: use JSONL." },
    ],
  });
  try {
    room.engine.postHuman("How should we store rooms?");
    await withTimeout(room.engine.waitIdle());

    const state = room.store.state;
    assert.deepEqual(kinds(room).slice(0, 1), ["Ivan:human"]);
    const agentMessages = state.messages.filter((message) => message.kind === "agent").map((message) => message.text).sort();
    assert.deepEqual(agentMessages, ["Claude: use SQLite.", "Codex: use JSONL."]);
    assert.equal(state.messages.filter((message) => message.kind === "pass").length, 2);
    assert.equal(state.runs.at(-1)?.status, "ended");
    assert.equal(state.runs.at(-1)?.endReason, "quiet");

    const claude = room.invocations("claude");
    const codex = room.invocations("codex");
    assert.equal(claude.length, 2);
    assert.equal(codex.length, 2);
    // Round 1 is blind: briefing + the human message, nothing from the other agent.
    assert.match(claude[0]!.prompt!, /You are Claude \(@claude\), in an Agoryx room/);
    assert.match(claude[0]!.prompt!, /How should we store rooms\?/);
    assert.doesNotMatch(claude[0]!.prompt!, /use JSONL/);
    assert.doesNotMatch(codex[0]!.prompt!, /use SQLite/);
    // Round 2 is a thin delta with only the other agent's reply, resumed natively.
    assert.doesNotMatch(claude[1]!.prompt!, /You are Claude/);
    assert.match(claude[1]!.prompt!, /Codex · \d\d:\d\d\nCodex: use JSONL\./);
    assert.doesNotMatch(claude[1]!.prompt!, /How should we store rooms/);
    assert.equal(claude[1]!.resumed, true);
    assert.equal(claude[1]!.sessionId, claude[0]!.sessionId);
    assert.deepEqual(claude[0]!.args!.slice(0, 1), ["-p"]);
    assert.ok(claude[0]!.args!.includes("--session-id"));
    assert.ok(!claude[0]!.args!.some((arg) => arg.includes("dangerously")));
    assert.equal(codex[1]!.args![1], "resume");
    assert.equal(codex[1]!.sessionId, codex[0]!.sessionId);
    assert.ok(codex[0]!.args!.includes("workspace-write"));
    assert.ok(!codex[0]!.args!.some((arg) => arg.includes("dangerously")));
    // Native sessions are recorded for "open in Claude / Codex".
    assert.equal(state.sessions.claude?.sessionId, claude[0]!.sessionId);
    assert.equal(state.sessions.codex?.sessionId, codex[0]!.sessionId);
    // Nested Claude must not inherit CLAUDECODE; agents get the room env and the shim first on PATH.
    assert.equal(claude[0]!.env!.CLAUDECODE, undefined);
    assert.equal(codex[0]!.env!.AGORYX_AGENT, "codex");
    assert.equal(codex[0]!.env!.PATH_HEAD, room.shimDir);
    // Activity traces were captured.
    const claudeTurn = state.turns.find((turn) => turn.agent === "claude")!;
    assert.equal(claudeTurn.activity[0]?.kind, "command");
    assert.equal(claudeTurn.activity[0]?.status, "ok");
    const codexTurn = state.turns.find((turn) => turn.agent === "codex")!;
    assert.equal(codexTurn.activity[0]?.label, "ls -a");
  } finally {
    await room.cleanup();
  }
});

test("media an agent made outside the workspace is shown from where it is, not copied", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "moon", image: "PNG-BYTES", reply: "🌕" },
      { agent: "codex", match: "sun", image: "SUN", reply: "::pass::" },
      { agent: "codex", match: "chart", reply: "Here: ![chart](/tmp/elsewhere/chart.png) and [data](file:///tmp/elsewhere/data.csv)." },
    ],
  });
  const embeds = (text: string) => [...text.matchAll(/!\[\]\(([^)]+)\)/g)].map((match) => decodeURI(match[1]!));
  const lastCodex = () => room.store.state.messages.filter((message) => message.author === "codex" && message.kind === "agent").at(-1)!;
  try {
    room.engine.postHuman("@codex draw the moon");
    await withTimeout(room.engine.waitIdle());
    const moon = lastCodex();
    assert.match(moon.text, /^🌕\n\n!\[\]\(\/.+\/generated_images\/.+\.png\)$/);
    const [moonPath] = embeds(moon.text);
    assert.ok(moonPath!.startsWith(room.env.CODEX_HOME!), "embedded from Codex's own folder");
    assert.equal(readFileSync(moonPath!, "utf8"), "PNG-BYTES");

    // A reply that would be a pass still carries the image; an older image is not picked up again.
    room.engine.postHuman("@codex now the sun");
    await withTimeout(room.engine.waitIdle());
    const sun = lastCodex();
    assert.notEqual(sun.id, moon.id);
    assert.equal(embeds(sun.text).length, 1);
    assert.equal(readFileSync(embeds(sun.text)[0]!, "utf8"), "SUN");

    // Links to files elsewhere stay as the agent wrote them; nothing is brought into the workspace.
    room.engine.postHuman("@codex make the chart");
    await withTimeout(room.engine.waitIdle());
    assert.equal(lastCodex().text, "Here: ![chart](/tmp/elsewhere/chart.png) and [data](file:///tmp/elsewhere/data.csv).");
    assert.ok(!existsSync(join(room.store.state.workspace, ".agoryx", "media")));
  } finally {
    await room.cleanup();
  }
});

test("turn budget ends a run that would otherwise never converge", async () => {
  const room = createTestRoom({
    settings: { budget: 5 },
    rules: [{ reply: "I still disagree." }],
  });
  try {
    room.engine.postHuman("Argue forever");
    await withTimeout(room.engine.waitIdle());
    const state = room.store.state;
    assert.equal(state.turns.length, 5);
    assert.equal(state.runs.at(-1)?.endReason, "budget");
    const last = state.messages.at(-1)!;
    assert.equal(last.kind, "system");
    assert.match(last.text, /Turn budget reached \(5 agent turns\)\. Nothing is left open on the table/);
    // Prompts count down the remaining budget.
    const prompts = [...room.invocations("claude"), ...room.invocations("codex")].map((entry) => entry.prompt!);
    assert.ok(prompts.some((prompt) => /Turns left in this run after yours: \d/.test(prompt)));
  } finally {
    await room.cleanup();
  }
});

test("a budget stop names what the table still holds open", async () => {
  const room = createTestRoom({ settings: { budget: 3 }, rules: [{ reply: "I still disagree." }] });
  try {
    room.engine.tableOp({ op: "ask", text: "Name?" }, "claude");
    room.engine.tableOp({ op: "propose", title: "Agora", q: "Q1" }, "codex");
    await withTimeout(room.engine.waitIdle());
    room.engine.postHuman("Argue forever");
    await withTimeout(room.engine.waitIdle());
    const last = room.store.state.messages.at(-1)!;
    assert.match(last.text, /Still open on the table: 1 open question, 1 undecided proposal — write anything/);
    // A turn that would only acknowledge is asked to be a pass, so a settled room goes quiet by itself.
    const prompts = room.invocations("claude").map((entry) => entry.prompt!);
    assert.ok(prompts.some((prompt) => prompt.includes("or tidy the table is a pass")));
  } finally {
    await room.cleanup();
  }
});

test("the disagreement norms are on unless a control run switches them off", () => {
  assert.deepEqual([promptNorms({}), promptNorms({ AGORYX_PROMPT_NORMS: "on" })], [true, true]);
  assert.equal(promptNorms({ AGORYX_PROMPT_NORMS: "OFF" }), false);
});

test("a control run switches the norms off through the room's own environment", async () => {
  const room = createTestRoom({ env: { AGORYX_PROMPT_NORMS: "off" } });
  try {
    room.engine.postHuman("Pick a name");
    await withTimeout(room.engine.waitIdle());
    const prompts = room.invocations("claude").map((entry) => entry.prompt!);
    assert.ok(prompts.length > 0);
    assert.ok(prompts.every((prompt) => !prompt.includes("agreeing for politeness") && !prompt.includes("Disagree when you disagree")));
  } finally {
    await room.cleanup();
  }
});

test("@mention wakes only the addressed agent first; the other hears the reply", async () => {
  const room = createTestRoom({
    rules: [{ agent: "codex", match: "@codex", reply: "Done, @claude please review." }],
  });
  try {
    room.engine.postHuman("@codex fix the build");
    await withTimeout(room.engine.waitIdle());
    const claude = room.invocations("claude");
    const codex = room.invocations("codex");
    assert.ok(codex.length >= 1);
    assert.ok(claude.length >= 1);
    // Claude's first turn already contains Codex's answer: it was woken by it, not by the human.
    assert.match(claude[0]!.prompt!, /please review/);
    const firstTurn = room.store.state.turns[0]!;
    assert.equal(firstTurn.agent, "codex");
  } finally {
    await room.cleanup();
  }
});

test("a human message sent while agents work reaches both in their next delta", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", once: true, sleepMs: 600, reply: "claude first answer" },
      { agent: "codex", once: true, sleepMs: 600, reply: "codex first answer" },
      { match: "ALSO CONSIDER COST", reply: "noted cost" },
    ],
  });
  try {
    room.engine.postHuman("Pick a database");
    await new Promise((resolve) => setTimeout(resolve, 200));
    room.engine.postHuman("ALSO CONSIDER COST");
    await withTimeout(room.engine.waitIdle());
    for (const kind of ["claude", "codex"]) {
      const second = room.invocations(kind)[1]!;
      assert.match(second.prompt!, /ALSO CONSIDER COST/, `${kind} must see the interjection`);
    }
    const texts = room.store.state.messages.map((message) => message.text);
    assert.equal(texts.filter((text) => text === "noted cost").length, 2);
  } finally {
    await room.cleanup();
  }
});

test("agents put things on the table through the agoryx shim, with acks and attribution", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        once: true,
        table: [
          ["table", "ask", "Where do rooms live?"],
          ["table", "propose", "JSONL event log", "--body", "append-only, replayable"],
        ],
        reply: "I opened Q1 and proposed P1.",
      },
      {
        agent: "codex",
        match: "proposed P1",
        once: true,
        table: [
          ["table", "object", "P1", "no indexes"],
          ["table", "propose", "SQLite", "--file", "notes/sqlite.md"],
          ["table", "object", "P9", "does not exist"],
        ],
        reply: "Objected to P1, proposed P2.",
      },
    ],
  });
  try {
    // Codex waits for Claude's proposal: mention only claude first.
    room.engine.postHuman("@claude open a question about storage");
    await withTimeout(room.engine.waitIdle());
    const table = room.store.state.table;
    assert.equal(table.questions[0]?.text, "Where do rooms live?");
    assert.equal(table.questions[0]?.by, "claude");
    assert.deepEqual(
      table.options.map((option) => [option.id, option.title, option.by, option.q]),
      [
        ["P1", "JSONL event log", "claude", "Q1"],
        ["P2", "SQLite", "codex", "Q1"],
      ],
    );
    assert.equal(table.notes[0]?.kind, "object");
    assert.equal(table.notes[0]?.target, "P1");
    assert.equal(table.notes[0]?.by, "codex");
    // Ops are attributed to the turn that made them.
    const claudeTurn = room.store.state.turns.find((turn) => turn.agent === "claude")!;
    const askEvent = room.store.events.find((event) => event.type === "table.op" && event.op.op === "ask");
    assert.ok(askEvent && askEvent.type === "table.op" && askEvent.op.turnId === claudeTurn.id);
    // The shim printed the assigned ids and the rejection.
    const outputs = tableOutputs(room).flatMap((entry) => entry.tableOutputs!);
    assert.ok(outputs.some((line) => line.startsWith("Q1 ·")), outputs.join("\n"));
    assert.ok(outputs.some((line) => line.startsWith("P2 ·")), outputs.join("\n"));
    assert.ok(outputs.some((line) => line.includes("ERR") && line.includes("no option P9")), outputs.join("\n"));
    // TABLE.md in the workspace mirrors the table.
    const md = readFileSync(room.engine.ws.tableFile, "utf8");
    assert.match(md, /## Q1 · Where do rooms live\?/);
    assert.match(md, /✗ objection \(codex\): no indexes/);
    // Codex's prompt showed Claude's table ops under Claude's message.
    const codexPrompt = room.invocations("codex")[0]!.prompt!;
    assert.match(codexPrompt, /↳ table: asked Q1/);
  } finally {
    await room.cleanup();
  }
});

test("a human decision posts Decision №1 and wakes the agents", async () => {
  const room = createTestRoom({ rules: [{ match: "Decision №1", reply: "::pass::" }] });
  try {
    room.engine.tableOp({ op: "ask", text: "Name?" });
    await withTimeout(room.engine.waitIdle());
    room.engine.tableOp({ op: "propose", title: "Agora" }, "claude");
    room.engine.tableOp({ op: "decide", target: "P1", note: "short and Greek" });
    await withTimeout(room.engine.waitIdle());
    const decision = room.store.state.messages.find((message) => message.kind === "decision")!;
    assert.match(decision.text, /Decision №1: P1 «Agora» — short and Greek \(decided by Ivan\)/);
    assert.equal(room.store.state.table.questions[0]?.status, "decided");
    const prompts = room.invocations().map((entry) => entry.prompt!);
    assert.ok(prompts.some((prompt) => prompt.includes("Decision №1")));
  } finally {
    await room.cleanup();
  }
});

test("reopening the chosen option reopens its question, so it can be decided again", async () => {
  const room = createTestRoom({ rules: [{ reply: "::pass::" }] });
  try {
    room.engine.tableOp({ op: "ask", text: "Name?" });
    room.engine.tableOp({ op: "propose", title: "Agora" }, "claude");
    room.engine.tableOp({ op: "decide", target: "P1" });
    await withTimeout(room.engine.waitIdle());
    room.engine.tableOp({ op: "reopen", target: "P1" });
    await withTimeout(room.engine.waitIdle());
    const question = room.store.state.table.questions[0]!;
    assert.equal(question.status, "open");
    assert.equal(question.decision, undefined);
    room.engine.tableOp({ op: "decide", target: "P1", note: "again" });
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.store.state.table.questions[0]?.status, "decided");
  } finally {
    await room.cleanup();
  }
});

test("a settled conclusion can answer a question, and a concession is kept on the table", async () => {
  const room = createTestRoom({ rules: [{ reply: "::pass::" }] });
  try {
    room.engine.tableOp({ op: "ask", text: "Is time frozen in the Wheeler–DeWitt picture?" }, "claude");
    room.engine.tableOp({ op: "propose", title: "Time is an illusion", q: "Q1" }, "claude");
    room.engine.tableOp({ op: "object", target: "P1", text: "HΨ=0 is a constraint, not a frozen world" }, "codex");
    room.engine.tableOp({ op: "concede", text: "I overstated it: the constraint does not freeze anything", target: "P1" }, "claude");
    room.engine.tableOp({ op: "settle", text: "Time is relational, not absent", q: "q1" }, "codex");
    await withTimeout(room.engine.waitIdle());
    const table = room.store.state.table;
    assert.equal(table.questions[0]?.status, "answered");
    assert.equal(table.questions[0]?.answer, "S1");
    assert.equal(table.settled[0]?.q, "Q1");
    assert.deepEqual(
      table.shifts.map((shift) => [shift.id, shift.by, shift.target]),
      [["C1", "claude", "P1"]],
    );
    assert.deepEqual(openOnTable(table), { questions: 0, options: 0, steps: 0 });
    assert.match(summarizeTable(table)!, /changed minds: C1 claude on P1/);
    assert.match(renderTableMarkdown(table, "time"), /answered → S1/);
    assert.match(renderTableMarkdown(table, "time"), /## Changed minds/);

    assert.throws(() => room.engine.tableOp({ op: "settle", text: "again", q: "Q1" }), /Q1 is already answered/);
    assert.throws(() => room.engine.tableOp({ op: "decide", target: "P1" }), /Q1 is already answered/);
    assert.throws(() => room.engine.tableOp({ op: "concede", text: "nothing", target: "P9" }), /no P9/);

    room.engine.tableOp({ op: "reopen", target: "Q1" });
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.store.state.table.questions[0]?.status, "open");
    assert.equal(room.store.state.table.questions[0]?.answer, undefined);
  } finally {
    await room.cleanup();
  }
});

test("a message sent while a stop is under way is not swallowed by the run being stopped", async () => {
  const room = createTestRoom({
    rules: [
      { match: "Take your time", sleepMs: 30_000, reply: "too late" },
      { match: "follow-up", reply: "got the follow-up" },
    ],
    // These fakes answer each other forever; a limit ends the run (the default has none).
    settings: { budget: 4 },
  });
  try {
    room.engine.postHuman("Take your time");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stopping = room.engine.stop();
    const followUp = room.engine.postHuman("a follow-up");
    await withTimeout(stopping, 10_000);
    await withTimeout(room.engine.waitIdle());
    const runs = room.store.state.runs;
    assert.equal(runs.at(-2)?.endReason, "stopped");
    assert.equal(runs.at(-1)?.trigger, followUp.id);
    assert.ok(room.store.state.messages.some((message) => message.text === "got the follow-up"));
  } finally {
    await room.cleanup();
  }
});

test("stop interrupts running turns and ends the run", async () => {
  const room = createTestRoom({ rules: [{ sleepMs: 30_000, reply: "too late" }] });
  try {
    room.engine.postHuman("Take your time");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(room.engine.presence(), { claude: "working", codex: "working" });
    const started = Date.now();
    await withTimeout(room.engine.stop(), 10_000);
    assert.ok(Date.now() - started < 8_000);
    const state = room.store.state;
    assert.ok(state.turns.every((turn) => turn.status === "interrupted"));
    assert.equal(state.runs.at(-1)?.endReason, "stopped");
    assert.ok(!state.messages.some((message) => message.text === "too late"));
    assert.ok(room.engine.isIdle());
  } finally {
    await room.cleanup();
  }
});

test("a lost native session is rejoined with the full context", async () => {
  const room = createTestRoom({ rules: [] });
  try {
    room.store.append({ type: "session.bound", agent: "claude", sessionId: "00000000-0000-4000-8000-000000000000" });
    room.store.append({ type: "session.bound", agent: "codex", sessionId: "11111111-1111-4111-8111-111111111111" });
    room.engine.postHuman("hello again");
    await withTimeout(room.engine.waitIdle());
    for (const kind of ["claude", "codex"]) {
      const calls = room.invocations(kind);
      assert.equal(calls[0]!.resumed, true);
      assert.equal(calls[1]!.resumed, false);
      assert.match(calls[1]!.prompt!, /could not be resumed/);
      assert.match(calls[1]!.prompt!, /hello again/);
    }
    assert.notEqual(room.store.state.sessions.claude?.sessionId, "00000000-0000-4000-8000-000000000000");
    assert.equal(room.store.state.messages.filter((message) => message.kind === "agent").length, 2);
  } finally {
    await room.cleanup();
  }
});

test("agent failures are reported in the room and do not wedge the run", async () => {
  const room = createTestRoom({ rules: [{ agent: "codex", error: "stream error: 429 Too Many Requests" }], settings: { budget: 4 } });
  try {
    room.engine.postHuman("hi");
    await withTimeout(room.engine.waitIdle());
    const system = room.store.state.messages.find((message) => message.kind === "system" && message.author === "agoryx")!;
    assert.match(system.text, /Codex could not finish its turn/);
    assert.match(system.text, /rate limit/);
    const codexTurn = room.store.state.turns.find((turn) => turn.agent === "codex")!;
    assert.equal(codexTurn.status, "error");
    assert.equal(codexTurn.error?.kind, "rate_limit");
    assert.ok(room.store.state.messages.some((message) => message.author === "claude" && message.kind === "agent"));
  } finally {
    await room.cleanup();
  }
});

test("a missing CLI benches that agent until the next human message", async () => {
  const room = createTestRoom();
  await room.engine.close();
  const engine = new RoomEngine({
    store: room.store,
    runners: { claude: createClaudeRunner(room.fakeClaude), codex: createCodexRunner("/nonexistent/codex") },
    shimDir: room.shimDir,
    env: room.env,
  });
  try {
    engine.postHuman("hi");
    await withTimeout(engine.waitIdle());
    const codexTurns = room.store.state.turns.filter((turn) => turn.agent === "codex");
    assert.equal(codexTurns.length, 1);
    assert.equal(codexTurns[0]!.error?.kind, "spawn");
  } finally {
    await engine.close();
    await room.cleanup();
  }
});

test("workspace changes are attributed per turn and checkpointed at run end", async () => {
  const room = createTestRoom({
    rules: [{ agent: "claude", once: true, write: { path: "site/index.html", content: "<h1>hi</h1>" }, reply: "made a page" }],
  });
  try {
    room.engine.postHuman("make a page");
    await withTimeout(room.engine.waitIdle());
    const turn = room.store.state.turns.find((entry) => entry.agent === "claude" && entry.files?.length)!;
    assert.deepEqual(turn.files, ["site/index.html"]);
    const commit = room.store.state.commits[0]!;
    assert.match(commit.subject, /^agoryx\(Test room\): make a page/);
    assert.equal(commit.files, 1);
    // .agoryx/ stays out of git.
    const codexPrompt = room.invocations("codex")[1]!.prompt!;
    assert.match(codexPrompt, /↳ changed: site\/index\.html/);
  } finally {
    await room.cleanup();
  }
});

test("activity traces show workspace-relative paths and a plain `agoryx`, not machine paths", async () => {
  const room = createTestRoom({
    rules: [{ command: 'cat {cwd}/src/app.ts && "{cli}" table ask "why?" && ls {cwd}', reply: "looked" }],
    settings: { budget: 4 },
  });
  try {
    room.engine.postHuman("look around");
    await withTimeout(room.engine.waitIdle());
    for (const agent of ["claude", "codex"]) {
      const turn = room.store.state.turns.find((entry) => entry.agent === agent)!;
      assert.equal(turn.activity[0]?.label, 'cat src/app.ts && agoryx table ask "why?" && ls .', agent);
    }
  } finally {
    await room.cleanup();
  }
});

test("a second engine cannot drive the same room; restart closes stale turns", async () => {
  const room = createTestRoom({ rules: [{ sleepMs: 30_000 }] });
  try {
    assert.throws(
      () => new RoomEngine({ store: RoomStore.open(room.roomsRoot, room.store.id), runners: {}, env: room.env }),
      RoomLockedError,
    );
    room.engine.postHuman("long task");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Simulate a crash: the log says a run and a turn are still going, but no process owns them.
    await room.engine.close();
    const crashed = RoomStore.open(room.roomsRoot, room.store.id);
    crashed.append({ type: "run.started", runId: "r9", trigger: null, budget: 4 });
    crashed.append({ type: "turn.started", turnId: "t99", agent: "claude", runId: "r9", cursor: 1, resume: false, sessionId: null, promptChars: 1 });
    const reopened = RoomStore.open(room.roomsRoot, room.store.id);
    const engine = new RoomEngine({ store: reopened, runners: {}, env: room.env });
    assert.equal(reopened.state.turns.find((turn) => turn.id === "t99")?.status, "interrupted");
    assert.equal(reopened.state.runs.at(-1)?.status, "ended");
    assert.match(reopened.state.messages.at(-1)!.text, /restarted/);
    await engine.close();
    assert.ok(!existsSync(join(reopened.dir, "engine.lock")));
  } finally {
    await room.cleanup();
  }
});

test("a lock left by a dead process is reclaimed; one held by a live process is not", async () => {
  const room = createTestRoom();
  try {
    await room.engine.close();
    const lock = join(room.store.dir, "engine.lock");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, String(dead));
    const engine = new RoomEngine({ store: RoomStore.open(room.roomsRoot, room.store.id), runners: {}, env: room.env });
    assert.equal(readFileSync(lock, "utf8"), String(process.pid));
    await engine.close();
    writeFileSync(lock, String(process.ppid));
    assert.throws(
      () => new RoomEngine({ store: RoomStore.open(room.roomsRoot, room.store.id), runners: {}, env: room.env }),
      RoomLockedError,
    );
    assert.equal(readFileSync(lock, "utf8"), String(process.ppid));
    rmSync(lock);
  } finally {
    await room.cleanup();
  }
});

test("an append after a crash mid-write starts on a fresh line and survives the next replay", async () => {
  const room = createTestRoom();
  try {
    await room.engine.close();
    appendFileSync(room.store.file, '{"type":"message.posted","mess');
    const reopened = RoomStore.open(room.roomsRoot, room.store.id);
    const event = reopened.append({ type: "room.renamed", name: "after the crash" });
    const replayed = RoomStore.open(room.roomsRoot, room.store.id);
    assert.equal(replayed.state.name, "after the crash");
    assert.equal(replayed.state.seq, event.seq);
    // A corrupt line that had used up a seq leaves a gap; catching up after it still finds what follows.
    appendFileSync(room.store.file, `{"seq":${event.seq + 1},"broken\n${JSON.stringify({ type: "room.renamed", name: "past the gap", seq: event.seq + 2, ts: new Date().toISOString() })}\n`);
    const gapped = RoomStore.open(room.roomsRoot, room.store.id);
    assert.deepEqual(gapped.since(event.seq).map((entry) => entry.seq), [event.seq + 2]);
    assert.deepEqual(gapped.since(event.seq - 1).map((entry) => entry.seq), [event.seq, event.seq + 2]);
  } finally {
    await room.cleanup();
  }
});

test("each replayed patch carries its own event's seq, so a catching-up client applies every event", async () => {
  const room = createTestRoom({ rules: [{ sleepMs: 30_000 }] });
  try {
    await room.engine.close();
    const store = RoomStore.open(room.roomsRoot, room.store.id);
    const from = store.state.seq;
    store.append({ type: "room.renamed", name: "one" });
    store.append({ type: "room.renamed", name: "two" });
    for (const event of store.since(from)) assert.equal(eventPatch(store.state, event).seq, event.seq);
  } finally {
    await room.cleanup();
  }
});

test("the event log replays into the same state", async () => {
  const room = createTestRoom();
  try {
    room.engine.postHuman("hello");
    await withTimeout(room.engine.waitIdle());
    const replayed = RoomStore.open(room.roomsRoot, room.store.id).state;
    assert.deepEqual(replayed.messages, room.store.state.messages);
    assert.deepEqual(replayed.cursors, room.store.state.cursors);
    assert.deepEqual(replayed.sessions, room.store.state.sessions);
    assert.deepEqual(replayed.turns, room.store.state.turns);
  } finally {
    await room.cleanup();
  }
});

test("one conversation: blind in parallel after the human, then one agent at a time", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "Hello both", sleepMs: 300, reply: "codex here", once: true },
      { agent: "codex", match: "claude here", reply: "Codex answers Claude.", once: true },
      { agent: "claude", match: "Codex answers Claude.", reply: "Claude agrees.", once: true },
    ],
  });
  try {
    room.engine.postHuman("Hello both");
    await withTimeout(room.engine.waitIdle());
    const events = room.store.events;
    const started = (turnId: string) => events.find((event) => event.type === "turn.started" && event.turnId === turnId)!.seq;
    const ended = (turnId: string) => events.find((event) => event.type === "turn.ended" && event.turnId === turnId)!.seq;
    const turns = room.store.state.turns;
    assert.ok(turns.length >= 4, `expected a conversation, got ${turns.length} turns`);
    const [first, second, ...rest] = turns;
    assert.ok(started(second!.id) < ended(first!.id), "the blind round runs in parallel");
    for (let i = 1; i < rest.length; i += 1) {
      assert.ok(started(rest[i]!.id) > ended(rest[i - 1]!.id), `${rest[i]!.id} waited for ${rest[i - 1]!.id}`);
    }
    assert.ok(started(rest[0]!.id) > Math.max(ended(first!.id), ended(second!.id)));
    // Codex had waited longest (Claude's blind reply came first), so it speaks first…
    assert.equal(rest[0]!.agent, "codex");
    // …and Claude answers having seen it: one thread, not two crossing ones.
    const claudePrompt = room.invocations("claude").find((entry) => entry.prompt!.includes("Codex answers Claude."));
    assert.ok(claudePrompt, "Claude saw Codex's reply before speaking again");
    assert.ok(room.store.state.messages.some((message) => message.text === "Claude agrees."));
  } finally {
    await room.cleanup();
  }
});

test("the human can still reach an agent while the other one holds the floor", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "slow task", sleepMs: 1500, reply: "Done with the slow task.", once: true },
      { agent: "codex", match: "quick question", reply: "Quick answer.", once: true },
    ],
  });
  try {
    room.engine.postHuman("@claude slow task");
    await new Promise((resolve) => setTimeout(resolve, 300));
    room.engine.postHuman("@codex quick question");
    await withTimeout(room.engine.waitIdle());
    const events = room.store.events;
    const codexTurn = room.store.state.turns.find((turn) => turn.agent === "codex")!;
    const claudeTurn = room.store.state.turns.find((turn) => turn.agent === "claude")!;
    const codexStart = events.find((event) => event.type === "turn.started" && event.turnId === codexTurn.id)!.seq;
    const claudeEnd = events.find((event) => event.type === "turn.ended" && event.turnId === claudeTurn.id)!.seq;
    assert.ok(codexStart < claudeEnd, "a message from the human does not wait for the floor");
  } finally {
    await room.cleanup();
  }
});
