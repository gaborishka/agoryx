import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import type { AttentionItem, RoomState } from "../../internal/agora/types.js";
import {
  AttentionFollower,
  BANNER_GAP_MS,
  BANNER_SETTLE_MS,
  bannerFor,
  lookingAt,
  nextBannerAt,
  roomsWord,
  trayLabel,
  type LookingInput,
} from "../../internal/desktop/attention.js";
import { writeFakeBins } from "../agora/helpers.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const ORIGIN = "http://127.0.0.1:7801";
const at = (url: string, window: Partial<NonNullable<LookingInput["window"]>> = {}, locked = false): LookingInput => ({
  window: { url, visible: true, minimized: false, ...window },
  locked,
  daemonOrigin: ORIGIN,
});

test("lookingAt: the room on screen, and whether the human can see it", () => {
  assert.deepEqual(lookingAt(at(`${ORIGIN}/#room-a1`)), { room: "room-a1", looking: true });
  // A child window on the daemon's origin (the wiring passes it the same way), with a query.
  assert.deepEqual(lookingAt(at(`${ORIGIN}/?view=1#room-b2`)), { room: "room-b2", looking: true });
  assert.deepEqual(lookingAt(at(`${ORIGIN}/#a%20b`)), { room: "a b", looking: true });
  assert.deepEqual(lookingAt(at(`${ORIGIN}/#room-a1`, { minimized: true })), { room: "room-a1", looking: false });
  assert.deepEqual(lookingAt(at(`${ORIGIN}/#room-a1`, { visible: false })), { room: "room-a1", looking: false });
  assert.deepEqual(lookingAt(at(`${ORIGIN}/#room-a1`, {}, true)), { room: "room-a1", looking: false });
});

test("lookingAt: no room for the start page, a preview, another origin, #new, an empty or malformed hash", () => {
  const none = { room: null, looking: false };
  assert.deepEqual(lookingAt({ window: null, locked: false, daemonOrigin: ORIGIN }), none);
  assert.deepEqual(lookingAt({ ...at(`${ORIGIN}/#room-a1`), daemonOrigin: null }), none);
  assert.deepEqual(lookingAt(at("file:///Applications/Agoryx.app/Contents/Resources/app/static/start.html")), none);
  assert.deepEqual(lookingAt(at("not a url")), none);
  assert.deepEqual(lookingAt(at("http://127.0.0.1:7802/#room-a1")), none);
  assert.deepEqual(lookingAt(at(`${ORIGIN}/raw/room-a1/abc/index.html#room-a1`)), none);
  assert.deepEqual(lookingAt(at(`${ORIGIN}/#new`)), { room: null, looking: true });
  assert.deepEqual(lookingAt(at(`${ORIGIN}/`)), { room: null, looking: true });
  assert.deepEqual(lookingAt(at(`${ORIGIN}/#`)), { room: null, looking: true });
  for (const hash of ["#%", "#%E0%A4%A"]) assert.deepEqual(lookingAt(at(`${ORIGIN}/${hash}`)), { room: null, looking: true }, hash);
});

test("roomsWord: Ukrainian plurals", () => {
  assert.equal(roomsWord(1), "1 кімната чекає на вас");
  assert.equal(roomsWord(2), "2 кімнати чекають на вас");
  assert.equal(roomsWord(5), "5 кімнат чекають на вас");
  assert.equal(roomsWord(11), "11 кімнат чекають на вас");
  assert.equal(roomsWord(21), "21 кімната чекає на вас");
  assert.equal(roomsWord(22), "22 кімнати чекають на вас");
  assert.equal(roomsWord(12), "12 кімнат чекають на вас");
});

const item = (fields: Partial<AttentionItem> = {}): AttentionItem => ({
  room: "room-a1",
  name: "Parser",
  seq: 10,
  ts: "2026-09-29T10:00:00.000Z",
  reason: "done",
  text: "all set",
  ...fields,
});

test("trayLabel: the name and a short reason, the name cut at 40", () => {
  assert.equal(trayLabel(item()), "Parser — агенти закінчили");
  assert.equal(trayLabel(item({ reason: "budget" })), "Parser — ліміт ходів вичерпано");
  assert.equal(trayLabel(item({ reason: "stopped", by: "Codex" })), "Parser — зупинено");
  assert.equal(trayLabel(item({ reason: "stopped" })), "Parser — зупинено");
  assert.equal(trayLabel(item({ reason: "mention", by: "Claude" })), "Parser — Claude кличе вас");
  assert.equal(trayLabel(item({ reason: "error", by: "Codex" })), "Parser — хід Codex не вдався");
  const long = trayLabel(item({ name: "x".repeat(50) }));
  assert.equal(long, `${"x".repeat(39)}… — агенти закінчили`);
});

test("bannerFor: one room's subtitle per reason, the title cut at 60, several rooms in one banner", () => {
  const one = (fields: Partial<AttentionItem>) => bannerFor([item(fields)]);
  assert.deepEqual(one({}), { title: "Parser", subtitle: "Агенти закінчили — чекають на вас", body: "all set", room: "room-a1" });
  assert.equal(one({ reason: "budget" }).subtitle, "Ліміт ходів вичерпано — чекають на вас");
  assert.equal(one({ reason: "stopped", by: "Codex" }).subtitle, "Codex зупиняє розмову");
  assert.equal(one({ reason: "stopped" }).subtitle, "Розмову перервано");
  assert.equal(one({ reason: "mention", by: "Claude" }).subtitle, "Claude звертається до вас");
  assert.equal(one({ reason: "error", by: "Codex", text: "Not logged in" }).subtitle, "Codex: хід не вдалося завершити");
  assert.equal(one({ name: "y".repeat(80) }).title, `${"y".repeat(59)}…`);

  const several = bannerFor([
    item({ room: "a", name: "Alpha", ts: "2026-09-29T10:00:01.000Z" }),
    item({ room: "b", name: "Beta", ts: "2026-09-29T10:00:03.000Z", reason: "mention", by: "Claude" }),
    item({ room: "c", name: "Gamma", ts: "2026-09-29T10:00:02.000Z" }),
  ]);
  assert.equal(several.title, "3 кімнати чекають на вас");
  assert.equal(several.subtitle, undefined);
  assert.equal(several.body, "Alpha, Beta, Gamma");
  assert.equal(several.room, "b", "a click opens the newest");
});

test("nextBannerAt: a burst gives one banner; the next waits for the 10 s gap", () => {
  const t0 = 1_000_000;
  // The wiring arms one timer at the first arrival; every arrival of the burst asks the same time.
  const times = new Set(Array.from({ length: 20 }, () => nextBannerAt(t0, null)));
  assert.deepEqual([...times], [t0 + BANNER_SETTLE_MS]);
  const shown = t0 + BANNER_SETTLE_MS;
  assert.equal(nextBannerAt(shown + 3000, shown), shown + BANNER_GAP_MS);
  assert.equal(nextBannerAt(shown + 20_000, shown), shown + 20_000 + BANNER_SETTLE_MS);
});

// ---------------------------------------------------------------------------
// The follower against a real daemon
// ---------------------------------------------------------------------------

let home: string;
let env: NodeJS.ProcessEnv;
let daemon: AgoraDaemon;
let info: { url: string; token: string };
const stubs: Server[] = [];

const startDaemon = async () => {
  daemon = new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    opsPollMs: 50,
    runners: { claude: createClaudeRunner(join(home, "fakebin", "fake-claude")), codex: createCodexRunner(join(home, "fakebin", "fake-codex")) },
  });
  const started = await daemon.start();
  info = { url: started.url, token: started.token };
};

const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, token = info.token): Promise<{ status: number; json: T }> => {
  const response = await fetch(`${info.url}${path}`, {
    method,
    headers: { "x-agoryx-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as T };
};

const waitFor = async (check: () => Promise<boolean> | boolean, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
};

const setRules = (rules: unknown[]) => {
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));
  rmSync(join(home, "fake-state", "used-rules.json"), { force: true });
};

const newRoom = async (name: string, agents: unknown = [{ id: "claude", kind: "claude", label: "Claude" }]) => {
  const reply = await api<{ room: { id: string } }>("POST", "/api/rooms", { name, agents });
  assert.equal(reply.status, 201);
  return reply.json.room.id;
};

const state = async (room: string) => (await api<{ state: RoomState }>("GET", `/api/rooms/${room}`)).json.state;
const waiting = async () => (await api<{ rooms: AttentionItem[] }>("GET", "/api/attention")).json.rooms;

/** Posts as the human; waits for the run to end unless told not to. */
const say = async (room: string, text: string, wait = true) => {
  const before = (await state(room)).runs.length;
  assert.equal((await api("POST", `/api/rooms/${room}/messages`, { text })).status, 201);
  if (wait) await waitFor(async () => {
    const runs = (await state(room)).runs;
    return runs.length > before && runs.every((run) => run.status !== "active");
  });
};

/** A follower and what it told. */
const follow = (options: ConstructorParameters<typeof AttentionFollower>[0] = {}) => {
  const follower = new AttentionFollower(options);
  const states: Array<{ items: AttentionItem[]; connected: boolean }> = [];
  const arrived: AttentionItem[] = [];
  follower.on("state", (items, connected) => states.push({ items, connected }));
  follower.on("arrived", (entry) => arrived.push(entry));
  return { follower, states, arrived };
};

const away = { room: null, looking: false };

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agoryx-attention-"));
  writeFakeBins(home);
  env = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_HUMAN: "Ivan",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  setRules([]);
  await startDaemon();
});

after(async () => {
  await daemon.close();
  for (const server of stubs) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(home, { recursive: true, force: true });
});

test("AttentionFollower: seeds silently, a new room arrives once, a replacement and a rename only change the state, a restart repeats nothing", async () => {
  setRules([
    { id: "claude", match: "seed-1", reply: "@ivan first?", once: true },
    { id: "claude", match: "new-1", reply: "@ivan second?", once: true },
    { id: "claude", match: "mix-1", reply: "@ivan which one?", once: true },
    { id: "codex", match: "mix-1", sleepMs: 20_000, once: true },
  ]);
  const a = await newRoom("Alpha");
  await say(a, "seed-1");
  const { follower, states, arrived } = follow();
  follower.setDaemon(info);
  await follower.report(away);
  assert.equal(follower.connected(), true);
  assert.deepEqual(follower.items().map((entry) => entry.room), [a]);
  assert.equal(states.length, 1);
  assert.equal(arrived.length, 0, "what waits at the first call only seeds");

  const b = await newRoom("Beta");
  await say(b, "new-1");
  await follower.report(away);
  assert.deepEqual(arrived.map((entry) => [entry.room, entry.reason]), [[b, "mention"]]);
  await follower.report(away);
  assert.equal(arrived.length, 1, "arrives once");

  // A mention, then an agent's stop in the same room: the item is replaced, and does not arrive again.
  const c = await newRoom("Gamma", [
    { id: "claude", kind: "claude", label: "Claude" },
    { id: "codex", kind: "codex", label: "Codex" },
  ]);
  await say(c, "mix-1", false);
  await waitFor(async () => (await waiting()).some((entry) => entry.room === c && entry.reason === "mention"));
  await follower.report(away);
  assert.equal(arrived.at(-1)?.room, c);
  assert.equal((await api("POST", `/api/rooms/${c}/stop`, {}, agentKey(info.token, c, "codex"))).status, 200);
  await waitFor(async () => (await waiting()).some((entry) => entry.room === c && entry.reason === "stopped"));
  const before = arrived.length;
  await follower.report(away);
  assert.equal(follower.items().find((entry) => entry.room === c)?.by, "Codex");
  assert.equal(states.at(-1)?.items.find((entry) => entry.room === c)?.reason, "stopped");
  assert.equal(arrived.length, before);

  // A rename by an agent (the human's own would mark the room seen): the state carries the new name.
  assert.equal((await api("POST", `/api/rooms/${a}/rename`, { name: "Alpha renamed" }, agentKey(info.token, a, "claude"))).status, 200);
  const statesBefore = states.length;
  await follower.report(away);
  assert.equal(states.length, statesBefore + 1);
  assert.equal(states.at(-1)?.items.find((entry) => entry.room === a)?.name, "Alpha renamed");
  assert.equal(arrived.length, before);

  // A restart on a new port: the same items come back and none arrives again; a new one does.
  const oldUrl = info.url;
  await daemon.close();
  await follower.report(away);
  assert.equal(follower.connected(), false);
  await startDaemon();
  assert.notEqual(info.url, oldUrl);
  follower.setDaemon(info);
  await follower.report(away);
  assert.equal(follower.connected(), true);
  assert.equal(arrived.length, before);
  assert.deepEqual(new Set(follower.items().map((entry) => entry.room)), new Set([a, b, c]));
  await follower.markSeen(a);
  await follower.report(away);
  assert.ok(!follower.items().some((entry) => entry.room === a));
  const d = await newRoom("Delta");
  setRules([{ id: "claude", match: "delta-1", reply: "@ivan delta?", once: true }]);
  await say(d, "delta-1");
  await follower.report(away);
  assert.equal(arrived.at(-1)?.room, d);
  assert.equal(arrived.length, before + 1);

  await follower.markSeen();
  assert.deepEqual(follower.items(), []);
  follower.dispose();
});

test("AttentionFollower: report() tells the daemon where the app looks, so the room on screen raises nothing", async () => {
  setRules([{ id: "claude", match: "looked-2", reply: "@ivan look?", once: true }]);
  const room = await newRoom("On screen");
  const { follower, arrived } = follow();
  follower.setDaemon(info);
  await follower.report({ room, looking: true });
  await say(room, "looked-2");
  assert.ok((await state(room)).messages.some((message) => message.text === "@ivan look?"));
  await follower.report({ room, looking: true });
  assert.ok(!follower.items().some((entry) => entry.room === room));
  assert.equal(arrived.length, 0);
  await follower.report(away);
  follower.dispose();
});

test("AttentionFollower: each has its own view; setDaemon(null) keeps the items and is not connected", async () => {
  setRules([{ id: "claude", match: "kept-3", reply: "@ivan kept?", once: true }]);
  const one = new AttentionFollower();
  const two = new AttentionFollower();
  assert.match(one.view, /^app-[\w-]+$/);
  assert.notEqual(one.view, two.view);
  one.dispose();
  two.dispose();

  const room = await newRoom("Kept");
  await say(room, "kept-3");
  const { follower, states } = follow();
  follower.setDaemon(info);
  await follower.report(away);
  assert.ok(follower.items().some((entry) => entry.room === room));
  follower.setDaemon(null);
  assert.equal(follower.connected(), false);
  assert.deepEqual(states.at(-1), { items: follower.items(), connected: false });
  assert.ok(follower.items().some((entry) => entry.room === room), "the last items are kept");
  // With no daemon, nothing is called.
  await follower.report(away);
  await follower.markSeen(room);
  assert.equal(follower.connected(), false);
  follower.dispose();
  await api("POST", "/api/attention/seen", { all: true });
});

test("AttentionFollower: a daemon without /api/attention (404) or one that does not answer is logged once, not connected, no throw", async () => {
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<string>((resolve) => {
      const server = createServer(handler);
      stubs.push(server);
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });
  const old = await listen((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown endpoint" }));
  });
  const logs: string[] = [];
  const { follower, states } = follow({ log: (message) => logs.push(message) });
  follower.setDaemon({ url: old, token: "t" });
  for (let i = 0; i < 3; i += 1) await follower.report(away);
  await follower.markSeen("room");
  assert.equal(follower.connected(), false);
  assert.deepEqual(logs, ["the daemon answered 404 to /api/attention/view"]);
  assert.equal(states.length, 0, "never connected, so nothing changed");

  const silent = await listen(() => {});
  const quiet: string[] = [];
  const slow = new AttentionFollower({ log: (message) => quiet.push(message), timeoutMs: 150 });
  slow.setDaemon({ url: silent, token: "t" });
  await slow.report(away);
  await slow.report(away);
  assert.equal(slow.connected(), false);
  assert.deepEqual(quiet, ["cannot reach the daemon: no answer in 150 ms"]);
  slow.dispose();

  // A listener that throws is logged, never thrown into the call.
  const thrown: string[] = [];
  const touchy = new AttentionFollower({ log: (message) => thrown.push(message) });
  touchy.on("state", () => {
    throw new Error("boom");
  });
  touchy.setDaemon(info);
  await touchy.report(away);
  assert.equal(touchy.connected(), true);
  assert.deepEqual(thrown, ["attention listener failed: boom"]);
  touchy.dispose();
  follower.dispose();
});

test("AttentionFollower: an older answer that lands after a newer one is dropped, so a room just marked seen does not arrive again", async () => {
  const waiting = { room: "a", name: "A", seq: 1, ts: "2026-09-30T00:00:00.000Z", reason: "done", text: "" };
  const replies: Array<(rooms: unknown[]) => void> = [];
  const bodies: unknown[] = [];
  const fake = ((_input: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Promise<Response>((resolve) => {
      replies.push((rooms) => resolve(new Response(JSON.stringify({ rooms }), { status: 200, headers: { "content-type": "application/json" } })));
    });
  }) as typeof fetch;
  const follower = new AttentionFollower({ fetch: fake });
  const events: string[] = [];
  follower.on("state", (items) => events.push(`state [${items.map((item) => item.room).join(",")}]`));
  follower.on("arrived", (item) => events.push(`arrived ${item.room}`));
  follower.setDaemon({ url: "http://127.0.0.1:1", token: "t" });
  const seed = follower.report({ room: null, looking: false });
  replies[0]!([waiting]);
  await seed;
  // A view report goes out with A still waiting; «Позначити все переглянутим» goes out after it and answers first.
  const stale = follower.report({ room: null, looking: false });
  const seen = follower.markSeen();
  replies[2]!([]);
  await seen;
  replies[1]!([waiting]);
  await stale;
  assert.deepEqual(events, ["state [a]", "state []"]);
  assert.deepEqual(follower.items(), []);

  // leave(): the app stops looking, even while a report is still in flight.
  const inFlight = follower.report({ room: "a", looking: true });
  const left = follower.leave();
  assert.deepEqual(bodies.at(-1), { view: follower.view, room: null, looking: false });
  replies[4]!([]);
  replies[3]!([]);
  await Promise.all([inFlight, left]);
  follower.dispose();
});
