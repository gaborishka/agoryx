import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyEvent, initialState } from "../../internal/agora/projection.js";
import type { MessageEntry, RoomCreatedEvent, RoomEvent, RoomState, TableOp } from "../../internal/agora/types.js";
import { betweenAgents, buildFeed, toHuman, turnClock, turnLimit, waitingFor } from "../../ui/src/lib/room.js";
import type { OpEntry } from "../../ui/src/lib/types.js";
import { createTestRoom, withTimeout } from "./helpers.js";

// The P10 room's journal (without its tool calls): 95 messages, 50 of them written while working, many by one agent to the other.
const events = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "p10", "room-events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as RoomEvent & { seq: number; ts: string });

/** The room as it stood after event `upTo`, with the table ops the UI gets beside it. */
const room = (upTo = Infinity) => {
  const state = initialState(events[0] as RoomCreatedEvent & { seq: number; ts: string });
  const ops: OpEntry[] = [];
  for (const event of events.slice(1)) {
    if (event.seq > upTo) break;
    applyEvent(state, event);
    if (event.type === "table.op") ops.push({ seq: event.seq, ts: event.ts, op: event.op });
  }
  return { state, ops };
};

test("P10: what the agents wrote to each other folds into one line per exchange; what they wrote to Ivan and what changed the table or files stay", () => {
  const { state, ops } = room();
  const model = buildFeed(state, ops);
  const rows = model.rows;
  // The turns whose replies show table moves, file revisions or changed files beside them.
  const shown = new Set([...model.opsByTurn.keys(), ...model.docByTurn.keys(), ...state.turns.filter((t) => t.files?.length || t.changes?.length).map((t) => t.id)]);
  const folded = rows.flatMap((row) => (row.type === "between" ? [row] : []));
  const message = (id: string) => state.messages.find((m) => m.id === id)!;
  assert.deepEqual(
    folded.map((row) => row.key),
    ["b-m29", "b-m33", "b-m39", "b-m45", "b-m54", "b-m66", "b-m84"],
  );
  // 24 messages; an agent's pass between two of them (m67, m85) does not end the exchange, and is no message.
  assert.equal(
    folded.reduce((n, row) => n + row.items.filter((g) => g.m.kind !== "pass").length, 0),
    24,
  );
  assert.deepEqual(
    folded.flatMap((row) => row.items.filter((g) => g.m.kind === "pass").map((g) => g.m.id)),
    ["m67", "m85"],
  );
  // Claude's reply m32 to @codex ("P1 зроблено…") moved nothing on the table, but its turn changed four files: it stays, with
  // them, between the updates before and after it.
  assert.deepEqual(
    folded.slice(0, 2).map((row) => row.items.map((g) => g.m.id)),
    [
      ["m29", "m30", "m31"],
      ["m33", "m34"],
    ],
  );
  assert.equal(state.turns.find((t) => t.id === message("m32").turnId)?.files?.length, 4);
  assert.ok(rows.some((row) => row.type === "msg" && row.m.id === "m32"));
  // Codex's six updates to Claude in the turn it lost waiting: one line, with the table items they were about.
  const waitingTurn = folded.find((row) => row.key === "b-m45")!;
  assert.deepEqual(
    waitingTurn.items.map((g) => g.m.id),
    ["m45", "m46", "m47", "m48", "m49", "m50"],
  );
  assert.deepEqual(waitingTurn.agents, ["codex", "claude"]);
  assert.deepEqual(waitingTurn.refs, ["P1", "P2", "D2", "P10"]);
  for (const row of folded) for (const g of row.items) assert.ok(g.m.kind === "pass" || betweenAgents(state, g.m, shown), g.m.id);

  // The comparison Ivan asked for mentions Codex along the way: it answers Ivan (and its turn moved the table).
  assert.equal(betweenAgents(state, message("m10"), shown), false);
  assert.ok(rows.some((row) => row.type === "group" && row.items.some((g) => g.m.id === "m10")), "with Codex's, written at the same time");
  // Replies that speak to Ivan by name, with an @codex too: "Маєш рацію, Іване, …" (m36), "@codex, виправив … Іване, …" (m43),
  // "@codex, з мого боку X1 закрито … Іване, … Чекаю твоєї команди" (m53).
  for (const id of ["m36", "m43", "m53"]) {
    assert.ok(toHuman(state, message(id)), id);
    assert.equal(betweenAgents(state, message(id), shown), false, id);
    assert.ok(rows.some((row) => row.type === "msg" && row.m.id === id), id);
  }
  // Claude's replies between Codex's updates later on (m65, m69, m71) moved items on the table: shown, with the moves.
  for (const id of ["m65", "m69", "m71"]) {
    assert.equal(betweenAgents(state, message(id), shown), false, id);
    assert.ok(rows.some((row) => row.type === "msg" && row.m.id === id), id);
  }
  // Ivan named, not spoken to: "після прохання Івана" (m84) is Codex telling Claude.
  assert.equal(toHuman(state, message("m84")), false);
  // An update to everyone (@all) is not between agents.
  assert.equal(betweenAgents(state, message("m61"), shown), false);
  // Nothing of Ivan's and no line of Agoryx's is ever folded.
  const hidden = new Set(folded.flatMap((row) => row.items.map((g) => g.m.id)));
  for (const m of state.messages) if (m.author === state.human || m.kind === "system" || m.kind === "decision") assert.ok(!hidden.has(m.id), m.id);
  // The table ops and file revisions of a turn are shown with its reply, never inside a fold.
  for (const turn of shown) {
    const reply = state.messages.find((m) => m.turnId === turn && m.kind !== "update");
    assert.ok(reply && !hidden.has(reply.id), turn);
  }
});

test("P10: while Codex was still writing to Claude, its updates stayed open; they folded once something else came", () => {
  // m50: Codex's sixth update in t9, both agents still working.
  const during = room(1167);
  assert.ok(during.state.turns.some((t) => t.status === "running"));
  const rows = buildFeed(during.state, during.ops).rows;
  assert.ok(!rows.some((row) => row.type === "between" && row.key === "b-m45"));
  assert.deepEqual(
    rows.slice(-6).map((row) => (row.type === "msg" ? row.m.id : row.key)),
    ["m45", "m46", "m47", "m48", "m49", "m50"],
  );
  // Claude's reply m52 follows: now they fold.
  const after = room(1208);
  assert.ok(buildFeed(after.state, after.ops).rows.some((row) => row.type === "between" && row.key === "b-m45"));
});

test("an update that shows an image or a diagram is not folded away", () => {
  const { state } = room();
  const update = (text: string) => ({ id: "m200", author: "codex", kind: "update", text, mentions: ["claude"], seq: 99999, ts: "" }) as MessageEntry;
  assert.equal(betweenAgents(state, update("@claude P3 is done.")), true);
  assert.equal(betweenAgents(state, update("@claude see ![the header](shots/header.png)")), false);
  assert.equal(betweenAgents(state, update("@claude the flow:\n```mermaid\ngraph TD; A-->B\n```")), false);
  assert.equal(betweenAgents(state, update("@claude the chart is in out/plot.svg")), false);
  // A page or a drawing the room renders live.
  assert.equal(betweenAgents(state, update("@claude the card:\n```html\n<div class=card>…</div>\n```")), false);
  assert.equal(betweenAgents(state, update("@claude the icon:\n```svg\n<svg viewBox='0 0 8 8'/>\n```")), false);
  assert.equal(betweenAgents(state, update("@claude the fix:\n```ts\nconst x = 1;\n```")), true);
});

/** The P10 room at its end, with messages and agents added to it. */
const extended = () => {
  const { state, ops } = room();
  // After the room's last event (its last commit came after its last message).
  let seq = events.at(-1)!.seq;
  const post = (m: Partial<MessageEntry> & Pick<MessageEntry, "id" | "author" | "kind">) =>
    state.messages.push({ text: "", mentions: [], ts: new Date().toISOString(), seq: (seq += 1), ...m } as MessageEntry);
  return { state, ops, post };
};

test("an exchange among three agents folds into one line with all three; one agent's messages to another read as from one to the other", () => {
  const { state, ops, post } = extended();
  state.agents.push({ ...state.agents.find((a) => a.id === "codex")!, id: "codex-2", label: "Codex 2" });
  post({ id: "m96", author: "claude", kind: "update", text: "@codex take P12", mentions: ["codex"] });
  post({ id: "m97", author: "codex", kind: "update", text: "@codex-2 the tests for P12 are yours", mentions: ["codex-2"] });
  post({ id: "m98", author: "codex-2", kind: "update", text: "@claude P12's tests pass", mentions: ["claude"] });
  post({ id: "m99", author: "Ivan", kind: "human", text: "thanks" });
  const fold = buildFeed(state, ops).rows.findLast((row) => row.type === "between")!;
  assert.equal(fold.type === "between" && fold.key, "b-m96");
  assert.deepEqual(fold.type === "between" && fold.agents, ["claude", "codex", "codex-2"]);
  assert.deepEqual(fold.type === "between" && fold.refs, ["P12"]);
});

test("a reply that calls the human by name is not folded; its author waits for them only when it @mentioned them", () => {
  const { state, ops, post } = extended();
  post({ id: "m96", author: "claude", kind: "agent", text: "@codex P12 is in. Ivan, merge it now or after P13?", mentions: ["codex"], turnId: "t90" });
  post({ id: "m97", author: "codex", kind: "update", text: "@claude checked P12", mentions: ["claude"] });
  post({ id: "m98", author: "claude", kind: "update", text: "@codex thanks", mentions: ["codex"] });
  const rows = buildFeed(state, ops).rows;
  assert.ok(rows.some((row) => row.type === "msg" && row.m.id === "m96"));
  // Its name alone is no call to wait on ("Маєш рацію, Іване, виправив" asks nothing): the briefing asks for an @mention
  // when an answer is wanted, and the room's attention counts only that.
  assert.equal(waitingFor(state, "claude"), null);
  assert.equal(toHuman(state, { text: "Маєш рацію, Іване, це наша помилка.", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "Що скажеш, Іване?", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "**Ivan**, which one?", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "Ivan: P12 or P13?", mentions: [] }), true);
  // The name closing a sentence after a comma, with a dash, or opening a line with a full stop; the vocative anywhere.
  assert.equal(toHuman(state, { text: "Your call on P3, Ivan.", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "Дякую, Іване.", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "Ivan — your call on P3", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "Ivan. Which one?", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "Дякую Іване за підказку", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "I asked Ivan. He said P12.", mentions: [] }), false);
  // A name with an underscore is the name, not emphasis.
  assert.equal(toHuman({ human: "ivan_h" }, { text: "ivan_h, which one?", mentions: [] }), true);
  // A short name is matched as it is: "Al" is not "Also," or "Але,".
  assert.equal(toHuman({ human: "Al" }, { text: "Also, the tests pass. Але, P3 is next.", mentions: [] }), false);
  assert.equal(toHuman({ human: "Al" }, { text: "Al, P12 or P13?", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "Після прохання Івана я прибрав T3.", mentions: [] }), false);
  assert.equal(toHuman(state, { text: "`Ivan, x` is only code", mentions: [] }), false);
  assert.equal(toHuman(state, { text: "> Ivan, quoted\n\nok", mentions: [] }), false);
  // An @mention the message's mentions do not carry (a pass's note).
  assert.equal(toHuman(state, { text: "@Ivan, I need your decision on Q3.", mentions: [] }), true);
  assert.equal(toHuman(state, { text: "@ivan-bot P3 is done", mentions: [] }), false);
  // The punctuation on the name's own line: a list after it is not a dash.
  assert.equal(toHuman(state, { text: "@codex here is what we agreed with Ivan\n- P1 done\n- P2 next", mentions: ["codex"] }), false);
  assert.equal(toHuman(state, { text: "PR for Ivan\n\n- P1 done", mentions: [] }), false);
  // The name as it is or in its vocative, no other case of it: "з Іваном, …", "для Івана: …".
  assert.equal(toHuman(state, { text: "Узгодив з Іваном, P3 закрито.", mentions: [] }), false);
  assert.equal(toHuman(state, { text: "Для Івана: P3 закрито.", mentions: [] }), false);
  // Other names: no word that begins with them ("Same,", "Patch:", "Danger:"), no short name's "vocative" ("саме", "дане").
  for (const [human, text] of [["Sam", "Same, P3 passes."], ["Pat", "Patch: P3"], ["Pat", "Path: src/a.ts"], ["Dan", "Danger: P3 rewrites history"], ["Sam", "Це саме те, що треба."], ["Dan", "Дане питання закрите."]]) {
    assert.equal(toHuman({ human: human! }, { text: text!, mentions: [] }), false, `${human}: ${text}`);
  }
  // Ukrainian names called in their vocative.
  for (const [human, text] of [["olena", "Олено, P3 чи P4?"], ["andrii", "Андрію, глянь P3"], ["mykola", "Дякую, Миколо."], ["oleh", "Олеже, P3?"], ["petro", "Петре — твоє слово"], ["yurii", "Юрію, P3 готово"], ["olena", "Дякую Олено за P3"]]) {
    assert.equal(toHuman({ human: human! }, { text: text!, mentions: [] }), true, `${human}: ${text}`);
  }
});

test("a reply in a turn that read the human's message answers it, even when another reply came between", () => {
  const { state, ops, post } = extended();
  const turn = (id: string, agent: string, cursorBefore: number, cursor: number) =>
    state.turns.push({ id, agent, runId: "r4", status: "ok", startedAt: new Date().toISOString(), cursorBefore, cursor, activity: [] } as unknown as RoomState["turns"][number]);
  // Claude's t90 started before Ivan wrote; its reply m97 lands after his message, t91 reads it and answers.
  post({ id: "m96", author: "Ivan", kind: "human", text: "@claude is P12 safe to merge?", mentions: ["claude"] });
  post({ id: "m97", author: "claude", kind: "agent", text: "@codex P11 is in, can you check it?", mentions: ["codex"], turnId: "t90" });
  post({ id: "m98", author: "claude", kind: "agent", text: "Yes: the tests pass. @codex can you double-check the migration?", mentions: ["codex"], turnId: "t91" });
  post({ id: "m99", author: "codex", kind: "agent", text: "@claude the migration is fine", mentions: ["claude"], turnId: "t92" });
  post({ id: "m100", author: "codex", kind: "update", text: "@claude and P11 too", mentions: ["claude"] });
  const seq = (id: string) => state.messages.find((m) => m.id === id)!.seq;
  turn("t90", "claude", seq("m96") - 1, seq("m96") - 1);
  turn("t91", "claude", seq("m96") - 1, seq("m97"));
  turn("t92", "codex", seq("m96") - 1, seq("m98"));
  const rows = buildFeed(state, ops).rows;
  assert.deepEqual(
    rows.slice(-4).map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type)),
    ["m96", "m97", "m98", "m99,m100"],
  );
});

test("an agent's own decision on the table is not the human's message: the replies after it fold", () => {
  const { state, ops, post } = extended();
  post({ id: "m96", author: "claude", kind: "decision", text: "Decided P12" });
  post({ id: "m97", author: "codex", kind: "agent", text: "@claude agreed, P12 it is", mentions: ["claude"], turnId: "t90" });
  post({ id: "m98", author: "claude", kind: "update", text: "@codex thanks", mentions: ["codex"] });
  post({ id: "m99", author: "Ivan", kind: "human", text: "ok" });
  const rows = buildFeed(state, ops).rows;
  assert.deepEqual(
    rows.slice(-3).map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type)),
    ["m96", "m97,m98", "m99"],
  );
});

test("a file a running turn revised does not fold the exchange at the end; once the turn ends it does", () => {
  const { state, ops, post } = extended();
  state.turns.push({ id: "t96", agent: "claude", runId: "r4", status: "running", startedAt: new Date().toISOString(), cursorBefore: 0, cursor: 0, activity: [] } as unknown as RoomState["turns"][number]);
  post({ id: "m96", author: "codex", kind: "update", text: "@claude P12 is in", mentions: ["claude"] });
  post({ id: "m97", author: "claude", kind: "update", text: "@codex checking it", mentions: ["codex"], turnId: "t96" });
  (state.docRevisions ??= []).push({ seq: state.messages.at(-1)!.seq + 1, ts: new Date().toISOString(), path: "docs/plan.md", by: "claude", turnId: "t96", hash: "h1", added: 3, removed: 1 });
  const shape = () =>
    buildFeed(state, ops)
      .rows.slice(-3)
      .map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type));
  assert.deepEqual(shape().slice(-3), ["m96", "m97", "doc"]);
  state.turns.at(-1)!.status = "ok";
  assert.deepEqual(shape().slice(-2), ["m96,m97", "doc"]);
});

test("a reply to the human that also asks another agent stays in sight; what the agents say after it folds", () => {
  const { state, ops, post } = extended();
  post({ id: "m96", author: "Ivan", kind: "human", text: "@claude is P12 safe to merge?", mentions: ["claude"] });
  post({ id: "m97", author: "claude", kind: "agent", text: "Yes: the tests pass. @codex can you double-check the migration?", mentions: ["codex"], turnId: "t90" });
  post({ id: "m98", author: "codex", kind: "update", text: "@claude checking", mentions: ["claude"] });
  post({ id: "m99", author: "codex", kind: "agent", text: "@claude the migration is fine", mentions: ["claude"], turnId: "t91" });
  const rows = buildFeed(state, ops).rows;
  assert.deepEqual(
    rows.slice(-3).map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type)),
    ["m96", "m97", "m98,m99"],
  );
});

test("a pass with a note for the human ends an exchange: it is shown", () => {
  // By name, or by an @mention the pass does not carry as one (the room records a pass's note with no mentions).
  for (const note of ["Ivan, I need your decision on Q3 before I go on.", "@Ivan I need your decision on Q3 before I go on."]) {
    const { state, ops, post } = extended();
    post({ id: "m96", author: "codex", kind: "update", text: "@claude P12 is in", mentions: ["claude"] });
    post({ id: "m97", author: "claude", kind: "update", text: "@codex checking it", mentions: ["codex"] });
    post({ id: "m98", author: "claude", kind: "pass", text: note });
    post({ id: "m99", author: "codex", kind: "update", text: "@claude ok", mentions: ["claude"] });
    post({ id: "m100", author: "claude", kind: "update", text: "@codex waiting", mentions: ["codex"] });
    post({ id: "m101", author: "codex", kind: "pass", text: "nothing to add" });
    post({ id: "m102", author: "Ivan", kind: "human", text: "Q3: yes" });
    const rows = buildFeed(state, ops).rows;
    assert.deepEqual(
      rows.slice(-5).map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type)),
      ["m96,m97", "m98", "m99,m100", "m101", "m102"],
      note,
    );
  }
});

test("a pass whose turn moved the table or changed files ends an exchange: it is shown, with what it did", () => {
  const { state, ops, post } = extended();
  state.turns.push({ id: "t95", agent: "claude", runId: "r4", status: "ok", startedAt: new Date().toISOString(), cursor: 0, files: ["ui/src/a.ts"], activity: [] } as unknown as RoomState["turns"][number]);
  post({ id: "m96", author: "claude", kind: "update", text: "@codex P12 is in", mentions: ["codex"] });
  post({ id: "m97", author: "codex", kind: "update", text: "@claude checking it", mentions: ["claude"] });
  post({ id: "m98", author: "claude", kind: "pass", turnId: "t95" });
  post({ id: "m99", author: "codex", kind: "update", text: "@claude P12 is fine", mentions: ["claude"] });
  post({ id: "m100", author: "claude", kind: "update", text: "@codex thanks", mentions: ["codex"] });
  post({ id: "m101", author: "Ivan", kind: "human", text: "ok" });
  const rows = buildFeed(state, ops).rows.filter((row) => (row.type === "msg" ? row.m.seq > state.messages.find((m) => m.id === "m95")!.seq : row.type === "between"));
  assert.deepEqual(
    rows.slice(-4).map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type)),
    ["m96,m97", "m98", "m99,m100", "m101"],
  );
});

test("between one turn of a run and the next, the exchange at the end stays open; it folds when the run ends", () => {
  const { state, ops, post } = extended();
  state.runs.push({ id: "r9", trigger: null, budget: null, used: 2, startedSeq: state.messages.at(-1)!.seq, status: "active" });
  post({ id: "m96", author: "claude", kind: "agent", text: "@codex P12 is in, can you check it?", mentions: ["codex"], turnId: "t90" });
  post({ id: "m97", author: "codex", kind: "agent", text: "@claude checked: P12 is fine", mentions: ["claude"], turnId: "t91" });
  assert.ok(!state.turns.some((t) => t.status === "running"), "the next turn has not started yet");
  const open = buildFeed(state, ops).rows;
  assert.ok(!open.some((row) => row.type === "between" && row.key === "b-m96"));
  assert.deepEqual(
    open.slice(-2).map((row) => row.type === "msg" && row.m.id),
    ["m96", "m97"],
  );
  state.runs.at(-1)!.status = "ended";
  assert.ok(buildFeed(state, ops).rows.some((row) => row.type === "between" && row.key === "b-m96"));
});

test("P10: Codex lost its turn waiting inside it for Claude — the chip says how long and for whom", () => {
  // m72: Codex's last update to @claude, 19 minutes into its turn; at 20 the daemon stopped it (m73).
  const { state } = room(1763);
  const turn = state.turns.find((t) => t.agent === "codex" && t.status === "running")!;
  const at = Date.parse(events.find((e) => e.seq === 1753)!.ts);
  const elapsed = at - Date.parse(turn.startedAt);
  assert.equal(turn.limitMs, undefined, "P10's log is from before the limit was recorded: the room's setting stands in");
  assert.equal(turnClock(elapsed, state.settings.turnTimeoutMs), "19 of 20 min");
  assert.ok(elapsed >= state.settings.turnTimeoutMs * 0.8);
  assert.deepEqual(waitingFor(state, "codex"), { who: ["claude"], since: "m72" });
  // Claude, working on it, waits for nobody.
  assert.equal(waitingFor(state, "claude"), null);
  // A new turn starts clean: Claude's t11 began right after its reply m52 to @codex, and was not shown waiting for Codex.
  const t11 = room(1210).state;
  assert.equal(t11.turns.find((t) => t.id === "t11")?.status, "running");
  assert.equal(waitingFor(t11, "claude"), null);
  // At the end both had passed: nobody waits.
  const end = room().state;
  assert.equal(waitingFor(end, "codex"), null);
  assert.equal(waitingFor(end, "claude"), null);
});

test("an agent that @mentions the human waits for the human until they write; idle, for nobody else", () => {
  const { state, post } = extended();
  post({ id: "m96", author: "claude", kind: "agent", text: "@Ivan, P12 or P13?", mentions: ["ivan"] });
  assert.deepEqual(waitingFor(state, "claude"), { who: ["ivan"], since: "m96" });
  // Codex writing does not answer for Ivan, nor does Claude passing when Codex wakes it.
  post({ id: "m97", author: "codex", kind: "update", text: "@claude I would take P12.", mentions: ["claude"] });
  assert.deepEqual(waitingFor(state, "claude")?.who, ["ivan"]);
  post({ id: "m97p", author: "claude", kind: "pass" });
  assert.deepEqual(waitingFor(state, "claude"), { who: ["ivan"], since: "m96" });
  post({ id: "m98", author: "Ivan", kind: "human", text: "P12" });
  assert.equal(waitingFor(state, "claude"), null);
  // An answer on the table (a question settled, a decision) is an answer too.
  post({ id: "m98a", author: "claude", kind: "agent", text: "@Ivan, Q4 or Q5?", mentions: ["ivan"] });
  assert.equal(waitingFor(state, "claude")?.since, "m98a");
  state.table.settled.push({ id: "S9", text: "Q4", by: "Ivan", seq: state.messages.at(-1)!.seq + 1 } as RoomState["table"]["settled"][number]);
  assert.equal(waitingFor(state, "claude"), null);
  // What it says to the human in its own session, outside the room, the room does not wait on.
  post({ id: "m98b", author: "claude", kind: "agent", text: "@Ivan, Q6?", mentions: ["ivan"], native: true });
  assert.equal(waitingFor(state, "claude"), null);
  // Idle, an agent that wrote to another waits for nobody: the other wakes it when it has something for it.
  post({ id: "m99", author: "codex", kind: "update", text: "@claude your turn", mentions: ["claude"] });
  assert.equal(waitingFor(state, "codex"), null);
  // Working, it waits for whom it wrote to in this turn, the human too.
  state.turns.push({ id: "t90", agent: "codex", runId: "r4", status: "running", startedAt: new Date().toISOString(), cursor: 0 } as RoomState["turns"][number]);
  post({ id: "m100", author: "codex", kind: "update", text: "@claude and @Ivan: P13?", mentions: ["claude", "ivan"], turnId: "t90" });
  assert.deepEqual(waitingFor(state, "codex")?.who, ["claude", "ivan"]);
  post({ id: "m101", author: "claude", kind: "update", text: "@codex skip it", mentions: ["codex"] });
  assert.deepEqual(waitingFor(state, "codex")?.who, ["ivan"]);
  // A pass is not waiting for anyone, in its turn.
  post({ id: "m102", author: "codex", kind: "pass", turnId: "t90" });
  assert.equal(waitingFor(state, "codex"), null);
  // Its turn over, it is still waiting for Ivan's answer, as the room's attention counts it.
  state.turns.at(-1)!.status = "ok";
  assert.deepEqual(waitingFor(state, "codex"), { who: ["ivan"], since: "m100" });
});

test("the turn clock reads against the turn's limit, in the limit's units", () => {
  assert.equal(turnClock(45_000, 20 * 60_000), "45s of 20 min");
  assert.equal(turnClock(18 * 60_000 + 59_000, 20 * 60_000), "18 of 20 min");
  assert.equal(turnClock(-5, 20 * 60_000), "0s of 20 min");
  assert.equal(turnClock(12_000, 30_000), "12s of 30s");
  // A short limit that is not whole minutes.
  assert.equal(turnClock(65_000, 90_000), "1:05 of 1:30");
  assert.equal(turnClock(20_000, 5 * 60_000), "0:20 of 5:00");
  // Past the limit (the clock and the daemon's timer are not one): it says so instead of "23 of 20 min".
  assert.equal(turnClock(23 * 60_000, 20 * 60_000), "over 20 min");
  assert.equal(turnClock(20 * 60_000, 20 * 60_000), "over 20 min");
  // Long limits, up to the 24 days the daemon takes.
  assert.equal(turnClock(3 * 3_600_000 + 5 * 60_000, 24 * 3_600_000), "3 h 5 min of 24 h");
  assert.equal(turnClock(40 * 60_000, 3 * 3_600_000), "40 min of 3 h");
  assert.equal(turnClock(26 * 3_600_000, 24 * 86_400_000), "1 d 2 h of 24 d");
  // Early in a long limit: minutes, then seconds, not "0 h 5 min".
  assert.equal(turnClock(5 * 60_000, 24 * 86_400_000), "5 min of 24 d");
  assert.equal(turnClock(30_000, 24 * 3_600_000), "30s of 24 h");
  assert.equal(turnClock(2 * 3_600_000, 3 * 86_400_000), "2 h of 3 d");
  // The limit as it is, rounded neither way: 2.5 h, 15.5 min.
  assert.equal(turnClock(3_600_000, 2.5 * 3_600_000), "1 h of 2 h 30 min");
  assert.equal(turnClock(10 * 60_000 + 5_000, 15.5 * 60_000), "10:05 of 15:30");
  // A clock that can't be read is at its start.
  assert.equal(turnClock(Number.NaN, 20 * 60_000), "0s of 20 min");
  // Short, for a narrow header: the time alone, in the same units; past the limit it still says so.
  assert.equal(turnClock(18 * 60_000 + 59_000, 20 * 60_000, true), "18 min");
  assert.equal(turnClock(65_000, 90_000, true), "1:05");
  assert.equal(turnClock(12_000, 30_000, true), "12s");
  assert.equal(turnClock(23 * 60_000, 20 * 60_000, true), "over 20 min");
});

test("a turn keeps the limit it started with", async () => {
  const live = createTestRoom({ settings: { turnTimeoutMs: 90_000 }, rules: [{ reply: "::pass::" }] });
  try {
    live.engine.postHuman("@claude hi");
    await withTimeout(live.engine.waitIdle());
    assert.equal(live.store.state.turns[0]!.limitMs, 90_000);
  } finally {
    await live.cleanup();
  }

  const { state } = room();
  // P10's turns, from before the limit was recorded: the room's setting stands in.
  assert.equal(turnLimit(state, state.turns.at(-1)), 20 * 60_000);
  const started = { type: "turn.started", turnId: "t99", agent: "codex", runId: "r4", cursor: 0, resume: true, sessionId: null, promptChars: 1, limitMs: 90_000, seq: 99999, ts: new Date().toISOString() } as RoomEvent & { seq: number; ts: string };
  applyEvent(state, started);
  // The setting changed while the turn runs: the turn keeps its own; the next one takes the new one.
  applyEvent(state, { type: "settings.changed", patch: { turnTimeoutMs: 60 * 60_000 }, by: "Ivan", seq: 100000, ts: new Date().toISOString() } as RoomEvent & { seq: number; ts: string });
  assert.equal(state.settings.turnTimeoutMs, 60 * 60_000);
  assert.equal(state.turns.at(-1)!.limitMs, 90_000);
  assert.equal(turnLimit(state, state.turns.at(-1)), 90_000);
  // No turn: the room's.
  assert.equal(turnLimit(state, undefined), 60 * 60_000);
});

test("an idle agent's wait for the human ends with any move of theirs on the table: a step marked done or committed too", () => {
  const { state, ops, post } = extended();
  post({ id: "m96", author: "claude", kind: "agent", text: "@Ivan X9 is checked: commit it when you are ready.", mentions: ["ivan"] });
  const base = state.messages.at(-1)!.seq;
  const ts = new Date().toISOString();
  assert.deepEqual(waitingFor(state, "claude", ops), { who: ["ivan"], since: "m96" });
  // An agent's move, or one made with the key of another room's agent, is not the human's.
  ops.push({ seq: base + 1, ts, op: { op: "done", target: "X9", by: "codex" } as TableOp });
  ops.push({ seq: base + 2, ts, op: { op: "done", target: "X9", by: "Ivan", from: { room: "other", agent: "claude" } } as unknown as TableOp });
  assert.deepEqual(waitingFor(state, "claude", ops)?.who, ["ivan"]);
  // Marking it done changes an item on the table; it adds none.
  ops.push({ seq: base + 3, ts, op: { op: "done", target: "X9", by: "Ivan" } as TableOp });
  assert.equal(waitingFor(state, "claude", ops), null);
  // "Commit step" is recorded on the step.
  post({ id: "m97", author: "claude", kind: "agent", text: "@Ivan and X10?", mentions: ["ivan"], seq: base + 10 });
  assert.equal(waitingFor(state, "claude", ops)?.since, "m97");
  state.table.next.push({ id: "X10", text: "X10", by: "claude", seq: base + 4, commit: { sha: "abc1234", by: "Ivan", seq: base + 11 } } as unknown as RoomState["table"]["next"][number]);
  assert.equal(waitingFor(state, "claude", ops), null);
});

test("a file a running turn revised among the agents' messages keeps the exchange open while the turn runs; it is shown after the fold", () => {
  const { state, ops, post } = extended();
  state.turns.push({ id: "t96", agent: "claude", runId: "r4", status: "running", startedAt: new Date().toISOString(), cursorBefore: 0, cursor: 0, activity: [] } as unknown as RoomState["turns"][number]);
  post({ id: "m96", author: "codex", kind: "update", text: "@claude P12 is in", mentions: ["claude"] });
  post({ id: "m97", author: "claude", kind: "update", text: "@codex checking it", mentions: ["codex"], turnId: "t96" });
  const at = state.messages.at(-1)!.seq + 1;
  (state.docRevisions ??= []).push({ seq: at, ts: new Date().toISOString(), path: "docs/plan.md", by: "claude", turnId: "t96", hash: "h1", added: 3, removed: 1 });
  post({ id: "m98", author: "claude", kind: "update", text: "@codex found an issue in P12", mentions: ["codex"], turnId: "t96", seq: at + 1 });
  const shape = () =>
    buildFeed(state, ops).rows.map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type));
  assert.deepEqual(shape().slice(-4), ["m96", "m97", "doc", "m98"]);
  // Something else follows while it runs: the exchange folds whole, the file after it.
  post({ id: "m99", author: "Ivan", kind: "human", text: "ok", seq: at + 2 });
  assert.deepEqual(shape().slice(-3), ["m96,m97,m98", "doc", "m99"]);
});

test("the human's message in an agent's own session is not one the other agents' turns answer; nor one said before an agent was seated", () => {
  const { state, ops, post } = extended();
  const turn = (id: string, agent: string, cursorBefore: number, cursor: number) =>
    state.turns.push({ id, agent, runId: "r4", status: "ok", startedAt: new Date().toISOString(), cursorBefore, cursor, activity: [] } as unknown as RoomState["turns"][number]);
  const seq = (id: string) => state.messages.find((m) => m.id === id)!.seq;
  const shape = (n: number) =>
    buildFeed(state, ops)
      .rows.slice(-n)
      .map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type));
  // Ivan asked Claude in its own session; Claude answered there.
  post({ id: "m96", author: "Ivan", kind: "human", text: "what is left on P3?", native: { agent: "claude", key: "k1" } });
  post({ id: "m97", author: "claude", kind: "agent", text: "P3 needs its tests.", native: { agent: "claude", key: "k1" } });
  post({ id: "m98", author: "claude", kind: "agent", text: "@codex can you review P3?", mentions: ["codex"], turnId: "t90" });
  post({ id: "m99", author: "codex", kind: "agent", text: "@claude P3 looks fine", mentions: ["claude"], turnId: "t91" });
  post({ id: "m100", author: "claude", kind: "agent", text: "@codex thanks, merging", mentions: ["codex"], turnId: "t92" });
  post({ id: "m101", author: "Ivan", kind: "human", text: "ok" });
  turn("t90", "claude", seq("m96") - 1, seq("m97"));
  turn("t91", "codex", seq("m96") - 1, seq("m98"));
  turn("t92", "claude", seq("m97"), seq("m99"));
  assert.deepEqual(shape(2), ["m98,m99,m100", "m101"]);
  // Codex 2 is seated after Ivan wrote to all: its first turn reads that, and does not answer it.
  state.agents.push({ ...state.agents.find((a) => a.id === "codex")!, id: "codex-2", label: "Codex 2" });
  post({ id: "m102", author: "Ivan", kind: "human", text: "P4 next" });
  post({ id: "m103", author: "claude", kind: "agent", text: "@codex P4 is yours", mentions: ["codex"], turnId: "t94" });
  state.joined["codex-2"] = seq("m103");
  post({ id: "m104", author: "codex-2", kind: "agent", text: "@claude I will test P4", mentions: ["claude"], turnId: "t95" });
  post({ id: "m105", author: "claude", kind: "update", text: "@codex-2 thanks", mentions: ["codex-2"] });
  post({ id: "m106", author: "Ivan", kind: "human", text: "ok" });
  turn("t94", "claude", seq("m101"), seq("m102"));
  turn("t95", "codex-2", 0, seq("m103"));
  assert.deepEqual(shape(4), ["m102", "m103", "m104,m105", "m106"]);
});

test("the human's name with a non-breaking space before its punctuation still speaks to them; a file named after them does not", () => {
  const { state } = extended();
  for (const text of ["Ivan — your call on P3", "Ivan : your call", "Your call on P3, Ivan."]) assert.equal(toHuman(state, { text, mentions: [] }), true, text);
  assert.equal(toHuman(state, { text: "Ivan.md updated with P3", mentions: [] }), false);
  assert.equal(toHuman(state, { text: "Ivan.\nWhich one?", mentions: [] }), true);
});

/** A synthetic room after P10, with turns to place replies in and the feed's shape at its end. */
const synthetic = () => {
  const { state, ops, post } = extended();
  const turn = (id: string, agent: string, cursorBefore: number, cursor: number) =>
    state.turns.push({ id, agent, runId: "r4", status: "ok", startedAt: new Date().toISOString(), cursorBefore, cursor, activity: [] } as unknown as RoomState["turns"][number]);
  const seq = (id: string) => state.messages.find((m) => m.id === id)!.seq;
  const shape = (n: number) =>
    buildFeed(state, ops)
      .rows.slice(-n)
      .map((row) => (row.type === "between" ? row.items.map((g) => g.m.id).join(",") : row.type === "msg" ? row.m.id : row.type));
  return { state, post, turn, seq, shape };
};

test("the session's own agent answers the human there: its reply right after their message stays with it", () => {
  const { post, turn, seq, shape } = synthetic();
  post({ id: "m96", author: "Ivan", kind: "human", text: "ask codex to review P3", native: { agent: "claude", key: "k1" } });
  post({ id: "m97", author: "claude", kind: "agent", text: "@codex can you review P3?", mentions: ["codex"], native: { agent: "claude", key: "k1" } });
  post({ id: "m98", author: "codex", kind: "agent", text: "@claude P3 looks fine", mentions: ["claude"], turnId: "t91" });
  post({ id: "m99", author: "Ivan", kind: "human", text: "ok" });
  turn("t91", "codex", seq("m97"), seq("m97"));
  assert.deepEqual(shape(4), ["m96", "m97", "m98", "m99"]);
});

test("the human's message that @mentions no agent is to all, as the room wakes them: a turn that read it answers it", () => {
  const { post, turn, seq, shape } = synthetic();
  post({ id: "m96", author: "Ivan", kind: "human", text: "@ivan note to self: P4 next", mentions: ["ivan"] });
  post({ id: "m97", author: "codex", kind: "agent", text: "@claude P4 first?", mentions: ["claude"], turnId: "t92" });
  post({ id: "m98", author: "claude", kind: "agent", text: "@codex Yes, P4 first.", mentions: ["codex"], turnId: "t93" });
  post({ id: "m99", author: "codex", kind: "update", text: "@claude starting P4", mentions: ["claude"] });
  post({ id: "m100", author: "claude", kind: "update", text: "@codex good", mentions: ["codex"] });
  post({ id: "m101", author: "Ivan", kind: "human", text: "thanks" });
  turn("t92", "codex", seq("m96") - 1, seq("m96"));
  turn("t93", "claude", seq("m96") - 1, seq("m97"));
  assert.deepEqual(shape(5), ["m96", "m97", "m98", "m99,m100", "m101"]);
});

test("an agent seated after the human wrote does not answer them with its first reply right after their message", () => {
  const { state, post, turn, seq, shape } = synthetic();
  state.agents.push({ ...state.agents.find((a) => a.id === "codex")!, id: "codex-2", label: "Codex 2" });
  post({ id: "m96", author: "Ivan", kind: "human", text: "P5 next" });
  state.joined["codex-2"] = seq("m96");
  post({ id: "m97", author: "codex-2", kind: "agent", text: "@claude I will test P5", mentions: ["claude"], turnId: "t95" });
  post({ id: "m98", author: "claude", kind: "update", text: "@codex-2 thanks", mentions: ["codex-2"] });
  post({ id: "m99", author: "Ivan", kind: "human", text: "ok" });
  turn("t95", "codex-2", 0, seq("m96"));
  assert.deepEqual(shape(3), ["m96", "m97,m98", "m99"]);
});

test("a full stop after the human's name speaks to them unless a file's name goes on", () => {
  const { state } = synthetic();
  for (const text of ["Ivan...\nwhich one?", "Ivan.)", "Ivan.» далі", "Ivan.… which?", "Your call, Ivan..."]) assert.equal(toHuman(state, { text, mentions: [] }), true, text);
  assert.equal(toHuman(state, { text: "@codex updated README.md, Ivan.md and plan.md", mentions: ["codex"] }), false);
});

test("an idle agent's wait for the human does not end with what the human said in another agent's own session, unless it names it", () => {
  const { state, ops, post } = extended();
  post({ id: "m96", author: "claude", kind: "agent", text: "@Ivan X9 or X10?", mentions: ["ivan"] });
  post({ id: "m97", author: "Ivan", kind: "human", text: "what is left on P5?", native: { agent: "codex", key: "k2" } });
  assert.deepEqual(waitingFor(state, "claude", ops), { who: ["ivan"], since: "m96" });
  post({ id: "m98", author: "Ivan", kind: "human", text: "X9", native: { agent: "claude", key: "k1" } });
  assert.equal(waitingFor(state, "claude", ops), null);
});
