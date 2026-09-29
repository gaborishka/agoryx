import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AttentionBoard, attentionFile, attentionOf, parseView, type RoomListener } from "../../internal/agora/attention.js";
import { roomsDir } from "../../internal/agora/paths.js";
import { RoomStore } from "../../internal/agora/store.js";
import { DEFAULT_SETTINGS, type ActorOrigin, type MessageKind, type RoomEvent, type RoomMessage, type TurnError } from "../../internal/agora/types.js";
import { AGENTS } from "./helpers.js";

/**
 * The attention board without a daemon: rooms are real RoomStores in a temp AGORYX_HOME, events are
 * appended by hand, and the board's clock is injected.
 */

const scratch = mkdtempSync(join(tmpdir(), "agoryx-attention-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let homes = 0;
const newHome = (): NodeJS.ProcessEnv => ({ AGORYX_HOME: join(scratch, `home-${(homes += 1)}`) });

const GUEST: ActorOrigin = { room: "other-room", roomName: "Other", agent: "opus", label: "Opus", kind: "claude" };

/** One room with an append helper for each kind of event the board reads. */
const makeRoom = (env: NodeJS.ProcessEnv, name = "Room") => {
  const store = RoomStore.create(roomsDir(env), {
    name,
    workspace: join(scratch, "ws"),
    createdWorkspace: true,
    human: "Ivan",
    agents: AGENTS,
    settings: DEFAULT_SETTINGS,
  });
  const listeners = new Set<RoomListener>();
  store.subscribe((event) => {
    for (const listener of listeners) listener(event);
  });
  let ids = 0;
  const post = (author: string, kind: MessageKind, text: string, extra: Partial<RoomMessage> = {}): RoomEvent =>
    store.append({
      type: "message.posted",
      message: { id: `m${(ids += 1)}`, author, kind, text, mentions: [], wakes: false, ...extra },
    });
  return {
    store,
    listeners,
    log: () => store,
    post,
    say: (text: string, runId: string, extra: Partial<RoomMessage> = {}) => post("claude", "agent", text, { runId, ...extra }),
    mention: (text = "@ivan which one?", extra: Partial<RoomMessage> = {}) => post("claude", "agent", text, { mentions: ["ivan"], ...extra }),
    runStart: (runId: string) => store.append({ type: "run.started", runId, trigger: null, budget: null }),
    runEnd: (runId: string, reason: "quiet" | "budget" | "stopped", extra: { by?: string; from?: ActorOrigin } = {}) =>
      store.append({ type: "run.ended", runId, reason, turns: 1, ...extra }),
    turn: (turnId: string, agent: string, runId: string, status: "ok" | "pass" | "error" | "interrupted", error?: TurnError) => {
      store.append({ type: "turn.started", turnId, agent, runId, cursor: store.state.seq, resume: false, sessionId: null, promptChars: 1 });
      return store.append({ type: "turn.ended", turnId, agent, status, sessionId: null, durationMs: 1, ...(error ? { error } : {}) });
    },
  };
};

const lastEvent = (room: ReturnType<typeof makeRoom>): RoomEvent => room.store.events[room.store.events.length - 1]!;
const judge = (room: ReturnType<typeof makeRoom>, event: RoomEvent = lastEvent(room)) => attentionOf(room.store.state, event);

// ---------------------------------------------------------------------------
// attentionOf
// ---------------------------------------------------------------------------

test("the four events that need the human", () => {
  const room = makeRoom(newHome());
  const mention = room.mention("@ivan which one?");
  assert.deepEqual(judge(room, mention), { seq: mention.seq, ts: mention.ts, reason: "mention", by: "Claude", text: "@ivan which one?" });

  const update = room.post("codex", "update", "@ivan halfway there", { mentions: ["ivan"], runId: "r0" });
  assert.equal(judge(room, update)?.reason, "mention");
  assert.equal(judge(room, update)?.by, "Codex");

  room.runStart("r1");
  room.say("first", "r1");
  room.say("the answer is 42", "r1");
  const done = room.runEnd("r1", "quiet");
  assert.deepEqual(judge(room, done), { seq: done.seq, ts: done.ts, reason: "done", text: "the answer is 42" });

  room.runStart("r2");
  room.say("spent", "r2");
  assert.equal(judge(room, room.runEnd("r2", "budget"))?.reason, "budget");

  room.runStart("r3");
  room.say("half done", "r3");
  const stopped = room.runEnd("r3", "stopped", { by: "codex" });
  assert.deepEqual(judge(room, stopped), { seq: stopped.seq, ts: stopped.ts, reason: "stopped", by: "Codex", text: "half done" });
});

test("a guest's stop counts, and so does a stop nobody is credited with, even with nothing posted", () => {
  const room = makeRoom(newHome());
  room.runStart("r1");
  const guest = room.runEnd("r1", "stopped", { by: "opus@other-room", from: GUEST });
  assert.equal(judge(room, guest)?.reason, "stopped");
  assert.equal(judge(room, guest)?.by, "opus@other-room");
  room.runStart("r2");
  const nobody = room.runEnd("r2", "stopped");
  assert.deepEqual(judge(room, nobody), { seq: nobody.seq, ts: nobody.ts, reason: "stopped", text: "" });
  // A guest's mention is signed with its handle.
  const asked = room.post("opus@other-room", "agent", "@ivan ok?", { mentions: ["ivan"], from: GUEST });
  assert.equal(judge(room, asked)?.by, "opus@other-room");
});

test("what never needs the human", () => {
  const room = makeRoom(newHome());
  const never = (event: RoomEvent, why: string) => assert.equal(judge(room, event), null, why);
  never(room.post("Ivan", "human", "@ivan note to self", { mentions: ["ivan"] }), "the human's own message");
  never(room.post("claude", "pass", "", { mentions: ["ivan"] }), "a pass");
  never(room.post("claude", "system", "@ivan Claude could not finish its turn", { mentions: ["ivan"] }), "a system note");
  never(room.post("claude", "decision", "@ivan decided", { mentions: ["ivan"] }), "a decision");
  never(room.mention("@ivan from the native session", { native: { agent: "claude", key: "k1" } }), "a native message");
  never(room.post("claude", "agent", "@all look", { mentions: ["all"] }), "@all alone");
  never(room.post("claude", "agent", "no one named"), "an agent message without a mention");
  never(room.store.append({ type: "table.op", op: { op: "ask", text: "Which one?", by: "claude", id: "Q1" } }), "a table op");
  room.runStart("r1");
  never(room.turn("t1", "claude", "r1", "error", { kind: "auth", message: "Not logged in" }), "turn.ended error on its own");
  never(room.turn("t2", "codex", "r1", "interrupted"), "turn.ended interrupted on its own");
  never(room.store.append({ type: "run.started", runId: "r9", trigger: null, budget: null }), "run.started");

  room.runStart("r2");
  room.post("claude", "pass", "", { runId: "r2" });
  room.post("codex", "pass", "", { runId: "r2" });
  never(room.runEnd("r2", "quiet"), "a quiet run in which every turn passed");
  room.runStart("r3");
  room.post("Ivan", "human", "go", { runId: "r3" });
  never(room.runEnd("r3", "budget"), "a budget run with no agent message");
  room.runStart("r4");
  room.say("working", "r4");
  never(room.runEnd("r4", "stopped", { by: "Ivan" }), "the human's own stop");
});

test("a run end is refined: stopped, then error, then budget, then done", () => {
  const room = makeRoom(newHome());
  room.runStart("r1");
  room.say("tried", "r1");
  room.turn("t1", "codex", "r1", "error", { kind: "auth", message: "Not logged in · Please run /login\nmore detail" });
  assert.equal(judge(room, room.runEnd("r1", "stopped", { by: "claude" }))?.reason, "stopped");

  room.runStart("r2");
  room.say("tried", "r2");
  room.turn("t2", "codex", "r2", "error", { kind: "auth", message: "Not logged in · Please run /login\nmore detail" });
  const budget = judge(room, room.runEnd("r2", "budget"));
  assert.equal(budget?.reason, "error");
  assert.equal(budget?.by, "Codex");
  assert.equal(budget?.text, "Not logged in · Please run /login");

  // An error counts even when nothing was posted.
  room.runStart("r3");
  room.turn("t3", "claude", "r3", "error", { kind: "spawn", message: "spawn claude ENOENT" });
  assert.deepEqual(
    { reason: judge(room, room.runEnd("r3", "quiet"))?.reason, by: judge(room)?.by, text: judge(room)?.text },
    { reason: "error", by: "Claude", text: "spawn claude ENOENT" },
  );
});

test("the text is one line of at most 160 characters", () => {
  const room = makeRoom(newHome());
  const long = `@ivan ${"word ".repeat(30)}\n\n  and\tmore ${"x".repeat(200)}`;
  const item = judge(room, room.mention(long));
  assert.ok(item);
  assert.equal(item.text.length, 160);
  assert.ok(item.text.endsWith("…"));
  assert.ok(!/\s{2}|\n|\t/.test(item.text));
  assert.ok(item.text.startsWith("@ivan word word"));
});

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

test("precedence: a done never hides an unseen mention; a newer mention replaces it", () => {
  const env = newHome();
  const room = makeRoom(env);
  const board = new AttentionBoard({ env });
  board.track(room.store.id, room.log, room.listeners);
  room.runStart("r1");
  const asked = room.mention("@ivan which one?", { runId: "r1" });
  room.runEnd("r1", "quiet");
  assert.equal(board.item(room.store.id)?.reason, "mention");
  assert.equal(board.item(room.store.id)?.seq, asked.seq);
  const again = room.mention("@ivan and now?");
  assert.equal(board.item(room.store.id)?.seq, again.seq);
  // A stop is not a "done": it replaces the mention.
  room.runStart("r2");
  const stopped = room.runEnd("r2", "stopped", { by: "codex" });
  assert.equal(board.item(room.store.id)?.reason, "stopped");
  assert.equal(board.item(room.store.id)?.seq, stopped.seq);
  room.runStart("r3");
  room.say("done", "r3");
  room.runEnd("r3", "quiet");
  assert.equal(board.item(room.store.id)?.reason, "stopped");
  board.close();
});

test("seeding: a room without a cursor raises nothing; with one, the same items come back", () => {
  const env = newHome();
  const room = makeRoom(env, "Seeded");
  room.mention();
  const first = new AttentionBoard({ env });
  first.track(room.store.id, room.log, room.listeners);
  assert.equal(first.item(room.store.id), undefined, "what was there before is not new");
  const asked = room.mention("@ivan now?");
  assert.equal(first.item(room.store.id)?.seq, asked.seq);
  first.close();
  const saved = JSON.parse(readFileSync(attentionFile(env), "utf8")) as { version: number; seen: Record<string, number> };
  assert.equal(saved.version, 1);
  assert.equal(saved.seen[room.store.id], asked.seq - 1);

  // A new board (a daemon restart) derives the same item again.
  const reopened = RoomStore.open(roomsDir(env), room.store.id);
  const second = new AttentionBoard({ env });
  second.track(room.store.id, () => reopened, new Set());
  assert.deepEqual(second.item(room.store.id), { room: room.store.id, name: "Seeded", seq: asked.seq, ts: asked.ts, reason: "mention", by: "Claude", text: "@ivan now?" });
  second.close();
});

test("a room whose folder is gone is pruned; tracking twice adds one listener", () => {
  const env = newHome();
  const room = makeRoom(env);
  mkdirSync(join(env.AGORYX_HOME!), { recursive: true });
  writeFileSync(attentionFile(env), JSON.stringify({ version: 1, seen: { "gone-room": 7, [room.store.id]: 1 } }));
  const board = new AttentionBoard({ env });
  board.track(room.store.id, room.log, room.listeners);
  board.track(room.store.id, room.log, room.listeners);
  assert.equal(room.listeners.size, 1);
  board.close();
  const saved = JSON.parse(readFileSync(attentionFile(env), "utf8")) as { seen: Record<string, number> };
  assert.deepEqual(Object.keys(saved.seen), [room.store.id]);
});

test("views: the watched room raises nothing; starting to look clears; a view expires after 45 s", () => {
  const env = newHome();
  const room = makeRoom(env);
  const other = makeRoom(env, "Other");
  let now = 1_000_000;
  const board = new AttentionBoard({ env, now: () => now });
  board.track(room.store.id, room.log, room.listeners);
  board.track(other.store.id, other.log, other.listeners);

  board.view({ view: "app-1", room: room.store.id, looking: true });
  const watched = room.mention();
  assert.equal(board.item(room.store.id), undefined, "the room on screen raises nothing");
  other.mention();
  assert.equal(board.item(other.store.id)?.reason, "mention", "the other room does");

  // Looking away and back: starting to look at the other room clears its item.
  board.view({ view: "app-1", room: other.store.id, looking: true });
  assert.equal(board.item(other.store.id), undefined);
  const missed = room.mention("@ivan back?");
  assert.equal(board.item(room.store.id)?.seq, missed.seq);
  assert.ok(missed.seq > watched.seq);

  // Not looking (the window blurred): the room on screen raises items again.
  board.view({ view: "app-1", room: other.store.id, looking: false });
  other.mention("@ivan still there?");
  assert.equal(board.item(other.store.id)?.reason, "mention");
  board.view({ view: "app-1", room: other.store.id, looking: true });
  assert.equal(board.item(other.store.id), undefined, "focusing again is starting to look");

  // 45 s without a report: the view no longer counts.
  now += 45_001;
  other.mention("@ivan hello?");
  assert.equal(board.item(other.store.id)?.reason, "mention");
  // Its next report is starting to look again.
  board.view({ view: "app-1", room: other.store.id, looking: true });
  assert.equal(board.item(other.store.id), undefined);
  board.close();
});

test("views: the app's views expire after 10 s, a tab's after 45 s", () => {
  const env = newHome();
  const room = makeRoom(env);
  const other = makeRoom(env, "Other");
  let now = 1_000_000;
  const board = new AttentionBoard({ env, now: () => now });
  board.track(room.store.id, room.log, room.listeners);
  board.track(other.store.id, other.log, other.listeners);

  board.view({ view: "app-1", room: room.store.id, looking: true });
  board.view({ view: "3f2a9c1e-tab", room: other.store.id, looking: true });
  now += 10_001;
  room.mention("@ivan the app went quiet");
  assert.equal(board.item(room.store.id)?.reason, "mention", "an app view silent for 10 s no longer counts");
  other.mention("@ivan the tab is still here");
  assert.equal(board.item(other.store.id), undefined, "a tab view still counts at 10 s");
  board.close();
});

test("views: at most 64, the oldest dropped first", () => {
  const env = newHome();
  const room = makeRoom(env);
  let now = 0;
  const board = new AttentionBoard({ env, now: () => now });
  board.track(room.store.id, room.log, room.listeners);
  board.view({ view: "tab-0", room: room.store.id, looking: true });
  room.mention();
  assert.equal(board.item(room.store.id), undefined, "watched");
  for (let n = 1; n <= 63; n += 1) {
    now += 1;
    board.view({ view: `tab-${n}`, room: null, looking: false });
  }
  room.mention("@ivan 64 views");
  assert.equal(board.item(room.store.id), undefined, "64 views: the first still counts");
  now += 1;
  board.view({ view: "tab-64", room: null, looking: false });
  room.mention("@ivan 65 views");
  assert.equal(board.item(room.store.id)?.reason, "mention", "the 65th view dropped the oldest");
  board.close();
});

test("markSeen, markAllSeen, and items newest first with the current name", async () => {
  const env = newHome();
  const a = makeRoom(env, "A");
  const b = makeRoom(env, "B");
  const board = new AttentionBoard({ env });
  board.track(a.store.id, a.log, a.listeners);
  board.track(b.store.id, b.log, b.listeners);
  a.mention();
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  b.mention();
  assert.deepEqual(
    board.items().map((item) => item.name),
    ["B", "A"],
  );
  b.store.append({ type: "room.renamed", name: "B renamed", by: "claude" });
  assert.equal(board.item(b.store.id)?.name, "B renamed");
  board.markSeen(a.store.id);
  board.markSeen("no-such-room");
  assert.deepEqual(
    board.items().map((item) => item.room),
    [b.store.id],
  );
  board.markAllSeen();
  assert.deepEqual(board.items(), []);
  board.close();
});

test("a failing room log is logged once and never throws into the room's listeners", () => {
  const env = newHome();
  const room = makeRoom(env);
  const lines: string[] = [];
  const board = new AttentionBoard({ env, log: (line) => lines.push(line) });
  let broken = false;
  board.track(room.store.id, () => (broken ? (null as never) : room.store), room.listeners);
  broken = true;
  room.mention();
  room.mention("@ivan again");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /cannot follow room/);
  // Ephemeral events (no seq) are ignored.
  for (const listener of room.listeners) listener({ type: "presence", agents: {} });
  board.close();
});

test("parseView validates what a client sends", () => {
  assert.deepEqual(parseView({ view: "app-1", room: null, looking: false }), { view: "app-1", room: null, looking: false });
  assert.deepEqual(parseView({ view: "a_B-9", room: "room-1", looking: true }), { view: "a_B-9", room: "room-1", looking: true });
  for (const bad of [
    { view: "bad id!", room: null, looking: true },
    { view: "x".repeat(65), room: null, looking: true },
    { view: "", room: null, looking: true },
    { room: null, looking: true },
    { view: "v", room: 7, looking: true },
    { view: "v", room: "r".repeat(201), looking: true },
    { view: "v", looking: true },
    { view: "v", room: null, looking: "yes" },
    null,
    [],
  ]) {
    assert.equal(typeof parseView(bad), "string", JSON.stringify(bad));
  }
});

test("attention.json: a debounced save, a flush on close, mode 0600", async () => {
  const env = newHome();
  const room = makeRoom(env);
  const board = new AttentionBoard({ env, saveMs: 40 });
  board.track(room.store.id, room.log, room.listeners);
  assert.equal(existsSync(attentionFile(env)), false, "not written at once");
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  assert.equal(existsSync(attentionFile(env)), true, "written after the debounce");
  assert.equal(statSync(attentionFile(env)).mode & 0o777, 0o600);
  room.mention();
  board.view({ view: "v", room: room.store.id, looking: true });
  board.close();
  const saved = JSON.parse(readFileSync(attentionFile(env), "utf8")) as { seen: Record<string, number> };
  assert.equal(saved.seen[room.store.id], room.store.state.seq, "flushed on close");

  // A long debounce still reaches the disk on close.
  const env2 = newHome();
  const room2 = makeRoom(env2);
  const slow = new AttentionBoard({ env: env2, saveMs: 60_000 });
  slow.track(room2.store.id, room2.log, room2.listeners);
  slow.close();
  assert.equal(existsSync(attentionFile(env2)), true);
});
