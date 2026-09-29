import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import type { AttentionItem, RoomState } from "../../internal/agora/types.js";
import { writeFakeBins } from "./helpers.js";

// The attention routes on a real daemon with the fake CLIs (docs/plans/2026-09-29-desktop-attention.md, Tests 2).

interface Reply {
  status: number;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

let home: string;
let env: NodeJS.ProcessEnv;
let rulesPath: string;
let daemon: AgoraDaemon;
let port: number;

const CLAUDE_ONLY = [{ id: "claude", kind: "claude", label: "Claude" }];

const call = (method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          "x-agoryx-token": options.token ?? daemon.token,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const waitFor = async (check: () => Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
};

/** New rules; `once` counts rule indexes, so what the last test used is forgotten. */
const setRules = (rules: unknown[]) => {
  writeFileSync(rulesPath, JSON.stringify(rules));
  rmSync(join(home, "fake-state", "used-rules.json"), { force: true });
};

const startDaemon = async () => {
  daemon = new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    opsPollMs: 50,
    runners: { claude: createClaudeRunner(join(home, "fakebin", "fake-claude")), codex: createCodexRunner(join(home, "fakebin", "fake-codex")) },
  });
  port = (await daemon.start()).port;
};

const newRoom = async (name: string, agents: unknown = CLAUDE_ONLY): Promise<string> => {
  const reply = await call("POST", "/api/rooms", { body: { name, agents } });
  assert.equal(reply.status, 201, reply.body);
  return reply.json<{ room: { id: string } }>().room.id;
};

const state = async (room: string): Promise<RoomState> => (await call("GET", `/api/rooms/${room}`)).json<{ state: RoomState }>().state;

/** Waits for the room's `count`-th run to end. */
const ended = (room: string, count: number) =>
  waitFor(async () => {
    const runs = (await state(room)).runs;
    return runs.length >= count && runs.every((run) => run.status !== "active");
  });

/** Posts as the human and waits for the run it starts to end. */
const say = async (room: string, text: string) => {
  const before = (await state(room)).runs.length;
  const posted = await call("POST", `/api/rooms/${room}/messages`, { body: { text } });
  assert.equal(posted.status, 201, posted.body);
  await ended(room, before + 1);
};

const attention = async (): Promise<AttentionItem[]> => {
  const reply = await call("GET", "/api/attention");
  assert.equal(reply.status, 200, reply.body);
  return reply.json<{ rooms: AttentionItem[] }>().rooms;
};

const itemOf = async (room: string) => (await attention()).find((item) => item.room === room);

const seen = async (room: string) => assert.equal((await call("POST", "/api/attention/seen", { body: { room } })).status, 200);

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-attention-"));
  writeFakeBins(home);
  rulesPath = join(home, "rules.json");
  setRules([]);
  env = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_HUMAN: "Ivan",
    AGORYX_USER: "Ivan",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: rulesPath,
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  await startDaemon();
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("an agent's «@ivan» is a mention; it outlives the run's end, and once seen the next run raises done", async () => {
  setRules([
    { id: "claude", match: "ask-mention-1", reply: "@ivan which one?", once: true },
    { id: "claude", match: "go-on-1", reply: "all set", once: true },
  ]);
  const room = await newRoom("Asks");
  await say(room, "ask-mention-1");
  const item = await itemOf(room);
  assert.ok(item, JSON.stringify(await attention()));
  assert.equal(item.reason, "mention");
  assert.equal(item.by, "Claude");
  assert.equal(item.text, "@ivan which one?");
  assert.equal(item.name, "Asks");
  // The run ended after the mention: the mention stays.
  assert.equal((await state(room)).runs.at(-1)?.endReason, "quiet");

  await seen(room);
  assert.equal(await itemOf(room), undefined);
  await say(room, "go-on-1");
  const done = await itemOf(room);
  assert.equal(done?.reason, "done");
  assert.equal(done?.text, "all set");
  await seen(room);
});

test("a run in which every agent passes raises nothing", async () => {
  setRules([{ id: "claude", match: "all-pass-2", reply: "::pass::", once: true }]);
  const room = await newRoom("Quiet");
  await say(room, "all-pass-2");
  assert.equal(await itemOf(room), undefined);
});

test("a view looking at the room keeps it clear during a run; after looking:false the next run raises one", async () => {
  setRules([
    { id: "claude", match: "watched-3", reply: "@ivan look here", once: true },
    { id: "claude", match: "unwatched-3", reply: "@ivan and now?", once: true },
  ]);
  const room = await newRoom("Watched");
  const looking = await call("POST", "/api/attention/view", { body: { view: "tab-1", room, looking: true } });
  assert.equal(looking.status, 200, looking.body);
  assert.ok(!looking.json<{ rooms: AttentionItem[] }>().rooms.some((item) => item.room === room));
  await say(room, "watched-3");
  assert.ok((await state(room)).messages.some((message) => message.text === "@ivan look here"));
  assert.equal(await itemOf(room), undefined);

  assert.equal((await call("POST", "/api/attention/view", { body: { view: "tab-1", room, looking: false } })).status, 200);
  await say(room, "unwatched-3");
  assert.equal((await itemOf(room))?.text, "@ivan and now?");
  await seen(room);
});

test("the human's own message marks the room seen", async () => {
  setRules([{ id: "claude", match: "mark-4", reply: "@ivan which file?", once: true }]);
  const room = await newRoom("Answered");
  await say(room, "mark-4");
  assert.equal((await itemOf(room))?.reason, "mention");
  // Posting holds a slow reply: the item must be gone as soon as the message is in, before the run ends.
  setRules([{ id: "claude", match: "reply-4", sleepMs: 1500, reply: "::pass::", once: true }]);
  const posted = await call("POST", `/api/rooms/${room}/messages`, { body: { text: "reply-4" } });
  assert.equal(posted.status, 201);
  assert.equal(await itemOf(room), undefined);
  await ended(room, 2);
});

test("an agent's stop counts, with who stopped; the human's stop does not", async () => {
  setRules([
    { id: "claude", match: "slow-5", sleepMs: 20_000, once: true },
    { id: "claude", match: "slower-5", sleepMs: 20_000, once: true },
  ]);
  const room = await newRoom("Stops");
  const key = agentKey(daemon.token, room, "claude");
  await call("POST", `/api/rooms/${room}/messages`, { body: { text: "slow-5" } });
  await waitFor(async () => (await state(room)).turns.some((turn) => turn.status === "running"));
  const stopped = await call("POST", `/api/rooms/${room}/stop`, { token: key });
  assert.equal(stopped.status, 200, stopped.body);
  await ended(room, 1);
  const item = await itemOf(room);
  assert.equal(item?.reason, "stopped");
  assert.equal(item?.by, "Claude");
  await seen(room);

  await call("POST", `/api/rooms/${room}/messages`, { body: { text: "slower-5" } });
  await waitFor(async () => (await state(room)).turns.filter((turn) => turn.status === "running").length > 0);
  assert.equal((await call("POST", `/api/rooms/${room}/stop`)).status, 200);
  await ended(room, 2);
  assert.equal((await state(room)).runs.at(-1)?.endReason, "stopped");
  assert.equal(await itemOf(room), undefined);
});

test("an agent that cannot log in ends the run as an error, named", async () => {
  setRules([{ id: "claude", match: "login-6", error: "Not logged in · Please run /login", once: true }]);
  const room = await newRoom("Logged out");
  await say(room, "login-6");
  const item = await itemOf(room);
  assert.equal(item?.reason, "error", JSON.stringify(await attention()));
  assert.equal(item?.by, "Claude");
  assert.match(item?.text ?? "", /Not logged in/);
  await seen(room);
});

test("GET /api/rooms carries waiting for the human only; agents get 403 on the attention routes; bad bodies 400", async () => {
  setRules([{ id: "claude", match: "ask-7", reply: "@ivan which branch?", once: true }]);
  const room = await newRoom("Waiting");
  const other = await newRoom("Next door");
  await say(room, "ask-7");

  type Listed = { rooms: Array<{ id: string; waiting?: AttentionItem }> };
  const human = (await call("GET", "/api/rooms")).json<Listed>().rooms;
  assert.equal(human.find((entry) => entry.id === room)?.waiting?.reason, "mention");
  assert.equal(human.find((entry) => entry.id === other)?.waiting, undefined);
  // Its own room's agent, and a guest from next door: neither learns what the human has not seen.
  for (const key of [agentKey(daemon.token, room, "claude"), agentKey(daemon.token, other, "claude")]) {
    const listed = await call("GET", "/api/rooms", { token: key });
    assert.equal(listed.status, 200, listed.body);
    assert.ok(listed.json<Listed>().rooms.every((entry) => !("waiting" in entry)), listed.body);
    assert.equal((await call("GET", "/api/attention", { token: key })).status, 403);
    assert.equal((await call("POST", "/api/attention/view", { token: key, body: { view: "agent", room, looking: true } })).status, 403);
    assert.equal((await call("POST", "/api/attention/seen", { token: key, body: { room } })).status, 403);
    assert.equal((await call("POST", "/api/attention/seen", { token: key, body: { all: true } })).status, 403);
  }
  assert.equal((await itemOf(room))?.reason, "mention", "an agent's attempt changed nothing");

  const bad = [
    ["/api/attention/view", { view: "", room, looking: true }],
    ["/api/attention/view", { view: "has space", room, looking: true }],
    ["/api/attention/view", { view: "v1", room: 42, looking: true }],
    ["/api/attention/view", { view: "v1", room, looking: "yes" }],
    ["/api/attention/view", ["v1"]],
    ["/api/attention/seen", {}],
    ["/api/attention/seen", { room: "" }],
    ["/api/attention/seen", { all: "yes" }],
  ] as const;
  for (const [path, body] of bad) assert.equal((await call("POST", path, { body })).status, 400, `${path} ${JSON.stringify(body)}`);
  assert.equal((await call("POST", "/api/attention")).status, 405);
  assert.equal((await call("GET", "/api/attention/view")).status, 405);
  assert.equal((await call("GET", "/api/attention/other")).status, 404);
  // A room nobody knows is a no-op.
  assert.equal((await call("POST", "/api/attention/seen", { body: { room: "no-such-room" } })).status, 200);
  await seen(room);
});

test("a restart on the same home keeps the same items with the same seq, and what was cleared stays cleared", async () => {
  setRules([
    { id: "claude", match: "keep-8", reply: "@ivan keep this?", once: true },
    { id: "claude", match: "clear-8", reply: "@ivan clear this?", once: true },
  ]);
  const kept = await newRoom("Kept");
  const cleared = await newRoom("Cleared");
  await say(kept, "keep-8");
  await say(cleared, "clear-8");
  await seen(cleared);
  const beforeRestart = await attention();
  assert.ok(beforeRestart.some((item) => item.room === kept && item.reason === "mention"));
  assert.ok(!beforeRestart.some((item) => item.room === cleared));

  await daemon.close();
  const file = join(home, "agora", "attention.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await startDaemon();
  assert.deepEqual(await attention(), beforeRestart);
  assert.equal(await itemOf(cleared), undefined);

  await call("POST", "/api/attention/seen", { body: { all: true } });
  assert.deepEqual(await attention(), []);
});
