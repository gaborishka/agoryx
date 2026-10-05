import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentKey } from "../../internal/agora/actor.js";
import { BrowserFailure, BrowserRelay, type BrowserCommand, type BrowserHost } from "../../internal/agora/browser.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import type { ActorOrigin } from "../../internal/agora/types.js";
import { writeFakeBins } from "./helpers.js";

// The room's browser, agents' side: the relay, the daemon's routes, and the whole chain from a fake agent's turn
// through `$AGORYX_CLI mcp` to a host that answers like the app's pane. Every daemon lives in a temporary
// AGORYX_HOME on port 0; nothing here reaches a daemon or state of the human's own.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mcpCall = join(repo, "tests", "agora", "fixtures", "mcp-call.mjs");
const slowPost = join(repo, "tests", "agora", "fixtures", "slow-browser-post.mjs");

const NO_HOST = "The room's browser needs the Agoryx desktop app, and it is not running (or not connected to this daemon). Nothing was opened.";
const NETWORK_OFF = "This room's network is off, so its browser is off too. The human can turn the network on in the room settings.";

const PAGE = { url: "http://127.0.0.1:1/", title: "Fixture", viewport: { width: 1280, height: 1330 } };

// ---------------------------------------------------------------------------
// 1. The relay, with a fake host
// ---------------------------------------------------------------------------

const origin = (room = "r1", agent = "claude"): ActorOrigin => ({ room, roomName: `Room ${room}`, agent, label: agent === "claude" ? "Claude" : "Codex", kind: agent === "claude" ? "claude" : "codex" });

const fakeHost = () => {
  const sent: BrowserCommand[] = [];
  const closedRooms: string[] = [];
  const closes: string[] = [];
  const cancelled: string[] = [];
  const host: BrowserHost = {
    send: (command) => sent.push(command),
    cancel: (id) => cancelled.push(id),
    closeRoom: (room) => closedRooms.push(room),
    close: (reason) => closes.push(reason),
  };
  return { host, sent, closedRooms, closes, cancelled };
};

/** The failure a command ended with (the promise must fail). */
const failure = async (promise: Promise<unknown>): Promise<BrowserFailure> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BrowserFailure, String(error));
    return error;
  }
  assert.fail("the command should have failed");
};

const thrown = (fn: () => void): BrowserFailure => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BrowserFailure, String(error));
    return error;
  }
  assert.fail("expected a BrowserFailure");
};

describe("the relay", () => {
  test("commands reach the host at once, however many; the 21st in flight in a room is 429", async () => {
    const lines: string[] = [];
    const relay = new BrowserRelay({ log: (line) => lines.push(line) });
    const { host, sent } = fakeHost();
    relay.attach(host);
    const first = relay.command(origin(), { op: "navigate", args: { url: "http://localhost:5173/?secret=1" } });
    const second = relay.command(origin("r1", "codex"), { op: "snapshot" });
    assert.equal(sent.length, 2, "both are on the host before either is answered");
    assert.deepEqual(
      { ...sent[0], id: "", deadline: 0 },
      { id: "", deadline: 0, room: "r1", roomName: "Room r1", agent: "claude", label: "Claude", op: "navigate", args: { url: "http://localhost:5173/?secret=1" } },
    );
    assert.match(sent[0]!.id, /^[0-9a-f]{32}$/);
    assert.ok(sent[0]!.deadline > Date.now() + 55_000 && sent[0]!.deadline <= Date.now() + 60_000);
    assert.deepEqual(sent[1]!.args, {}, "no args is an empty object");

    const more = Array.from({ length: 18 }, () => relay.command(origin(), { op: "snapshot" }));
    for (const pending of more) pending.catch(() => {});
    const over = await failure(relay.command(origin(), { op: "click", args: { ref: "e1" } }));
    assert.equal(over.status, 429);
    assert.match(over.message, /Too many browser commands are in flight in this room \(20\)/);
    // Another room is not held up by this one.
    const elsewhere = relay.command(origin("r2"), { op: "snapshot" });
    assert.equal(sent.length, 21);

    relay.answer(sent[0]!.id, { ok: true, result: { ...PAGE, text: "Loaded." } });
    assert.deepEqual(await first, { ...PAGE, text: "Loaded." });
    relay.answer(sent[1]!.id, { ok: false, error: "Could not load http://localhost:5173/: net::ERR_CONNECTION_REFUSED" });
    const refused = await failure(second);
    assert.equal(refused.status, 422);
    assert.equal(refused.message, "Could not load http://localhost:5173/: net::ERR_CONNECTION_REFUSED");
    relay.close();
    await failure(elsewhere);

    // One line per command: who, where, which op, the outcome, the time. No argument, URL or result.
    assert.ok(lines.some((line) => /^browser: claude@Room r1 navigate ok \(\d+ ms\)$/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /^browser: codex@Room r1 snapshot 422 \(\d+ ms\)$/.test(line)));
    assert.ok(lines.some((line) => /^browser: claude@Room r1 click 429 \(\d+ ms\)$/.test(line)));
    assert.ok(!lines.some((line) => /localhost|secret|Loaded|ERR_/.test(line)), lines.join("\n"));
  });

  test("the deadline gives 504, and a late answer gets 404", async () => {
    const relay = new BrowserRelay({ timeoutMs: 50 });
    const { host, sent } = fakeHost();
    relay.attach(host);
    const late = await failure(relay.command(origin(), { op: "eval", args: { expression: "1" } }));
    assert.equal(late.status, 504);
    assert.match(late.message, /did not finish this command within 0 s\. Commands in a room run one at a time/);
    assert.equal(thrown(() => relay.answer(sent[0]!.id, { ok: true, result: PAGE })).status, 404);
  });

  test("no host gives 503 at once, and nothing waits for one", async () => {
    const relay = new BrowserRelay();
    const started = Date.now();
    const none = await failure(relay.command(origin(), { op: "snapshot" }));
    assert.equal(none.status, 503);
    assert.equal(none.message, NO_HOST);
    assert.ok(Date.now() - started < 1000);
    const { host, sent } = fakeHost();
    relay.attach(host);
    assert.equal(sent.length, 0, "a command made before the host came is not kept for it");
  });

  test("a new host replaces the old one; the old one's late detach leaves the new one attached", async () => {
    const relay = new BrowserRelay();
    const a = fakeHost();
    const b = fakeHost();
    const detachA = relay.attach(a.host);
    const onA = relay.command(origin(), { op: "snapshot" });
    const detachB = relay.attach(b.host);
    assert.deepEqual(a.closes, ["replaced"]);
    const gone = await failure(onA);
    assert.equal(gone.status, 503);
    assert.match(gone.message, /disconnected while running this command/);
    // The old stream's close event fires now: it must not take the new host down.
    detachA();
    assert.equal(relay.hasHost(), true);
    const onB = relay.command(origin(), { op: "snapshot" });
    assert.equal(b.sent.length, 1);
    // An answer for A's command, which is gone, is refused.
    assert.equal(thrown(() => relay.answer(a.sent[0]!.id, { ok: true, result: PAGE })).status, 404);
    relay.answer(b.sent[0]!.id, { ok: true, result: PAGE });
    assert.deepEqual(await onB, PAGE);

    // Detaching the current host fails what it runs, and leaves none.
    const running = relay.command(origin(), { op: "snapshot" });
    detachB();
    detachB();
    assert.equal((await failure(running)).status, 503);
    assert.equal(relay.hasHost(), false);
    assert.equal((await failure(relay.command(origin(), { op: "snapshot" }))).message, NO_HOST);
  });

  test("closeRoom fails that room's commands with 403 and tells the host; other rooms go on", async () => {
    const relay = new BrowserRelay();
    const { host, sent, closedRooms } = fakeHost();
    relay.attach(host);
    const here = relay.command(origin("r1"), { op: "snapshot" });
    const there = relay.command(origin("r2"), { op: "snapshot" });
    relay.closeRoom("r1");
    const off = await failure(here);
    assert.equal(off.status, 403);
    assert.equal(off.message, NETWORK_OFF);
    assert.deepEqual(closedRooms, ["r1"]);
    relay.answer(sent[1]!.id, { ok: true, result: PAGE });
    assert.deepEqual(await there, PAGE);
  });

  test("the end of an agent's turn withdraws its commands: they fail, the host is told, a late answer gets 404", async () => {
    const relay = new BrowserRelay();
    const { host, sent, cancelled } = fakeHost();
    relay.attach(host);
    const mine = relay.command(origin("r1", "claude"), { op: "click", args: { x: 1, y: 2 } });
    const other = relay.command(origin("r1", "codex"), { op: "snapshot" });
    const elsewhere = relay.command(origin("r2", "claude"), { op: "snapshot" });
    relay.endTurn("r1", "claude");
    const ended = await failure(mine);
    assert.equal(ended.status, 409);
    assert.match(ended.message, /Your turn ended/);
    assert.deepEqual(cancelled, [sent[0]!.id]);
    assert.equal(thrown(() => relay.answer(sent[0]!.id, { ok: true, result: PAGE })).status, 404);
    relay.answer(sent[1]!.id, { ok: true, result: PAGE });
    relay.answer(sent[2]!.id, { ok: true, result: PAGE });
    assert.deepEqual(await other, PAGE);
    assert.deepEqual(await elsewhere, PAGE);
  });

  test("a command whose caller gave up is withdrawn and frees its place in the room", async () => {
    const relay = new BrowserRelay({ maxPerRoom: 1 });
    const { host, sent, cancelled } = fakeHost();
    relay.attach(host);
    const gone = new AbortController();
    const abandoned = relay.command(origin(), { op: "navigate", args: { url: "http://127.0.0.1:1/" } }, gone.signal);
    assert.equal((await failure(relay.command(origin(), { op: "snapshot" }))).status, 429);
    gone.abort();
    assert.equal((await failure(abandoned)).status, 499);
    assert.deepEqual(cancelled, [sent[0]!.id]);
    const next = relay.command(origin(), { op: "snapshot" });
    relay.answer(sent[1]!.id, { ok: true, result: PAGE });
    assert.deepEqual(await next, PAGE);
    const already = new AbortController();
    already.abort();
    assert.equal((await failure(relay.command(origin(), { op: "snapshot" }, already.signal))).status, 499);
    assert.equal(sent.length, 2, "a command given up before it was sent never reaches the host");
  });

  test("commands and answers are checked: 400 for a bad shape, 404 for an unknown id", async () => {
    const relay = new BrowserRelay();
    const { host, sent } = fakeHost();
    relay.attach(host);
    const bad = [
      null,
      "navigate",
      [],
      { op: "download" },
      { op: "navigate", args: [] },
      { op: "navigate", args: { url: { href: "x" } } },
      { op: "type", args: { ref: "e1", text: "x".repeat(10_001) } },
      { op: "eval", args: { expression: "x".repeat(100_001) } },
    ];
    for (const body of bad) assert.equal((await failure(relay.command(origin(), body))).status, 400, JSON.stringify(body)?.slice(0, 80));
    assert.equal(sent.length, 0, "a refused command never reaches the host");

    const long = relay.command(origin(), { op: "eval", args: { expression: "x".repeat(100_000) } });
    assert.equal(sent.length, 1, "an expression may be up to 100 000 characters");
    const id = sent[0]!.id;
    for (const answer of [
      {},
      { ok: "yes" },
      { ok: false },
      { ok: false, error: " " },
      { ok: true },
      { ok: true, result: { ...PAGE, url: 1 } },
      { ok: true, result: { ...PAGE, viewport: { width: "1280", height: 1 } } },
      { ok: true, result: { ...PAGE, text: 5 } },
      { ok: true, result: { ...PAGE, image: { data: "not base64!", mimeType: "image/png" } } },
      { ok: true, result: { ...PAGE, image: { data: "AAAA", mimeType: "image/jpeg" } } },
      { ok: true, result: { ...PAGE, notes: ["fine", 3] } },
    ]) {
      assert.equal(thrown(() => relay.answer(id, answer)).status, 400, JSON.stringify(answer));
    }
    // A malformed answer is refused, and the command still waits for a proper one.
    relay.answer(id, { ok: true, result: { ...PAGE, image: { data: "iVBORw0KGgo=", mimeType: "image/png" }, notes: ["n"], extra: "dropped" } });
    assert.deepEqual(await long, { ...PAGE, image: { data: "iVBORw0KGgo=", mimeType: "image/png" }, notes: ["n"] });
    assert.equal(thrown(() => relay.answer(id, { ok: true, result: PAGE })).status, 404, "answered already");
    assert.equal(thrown(() => relay.answer("0".repeat(32), { ok: true, result: PAGE })).status, 404);
  });

  test("close(): everything in flight fails, the host is told, and no host can attach after", async () => {
    const relay = new BrowserRelay();
    const { host, closes } = fakeHost();
    relay.attach(host);
    const running = relay.command(origin(), { op: "snapshot" });
    relay.close();
    const stopping = await failure(running);
    assert.equal(stopping.status, 503);
    assert.match(stopping.message, /daemon is stopping/);
    assert.deepEqual(closes, ["stopping"]);
    const late = fakeHost();
    relay.attach(late.host)();
    assert.deepEqual(late.closes, ["stopping"]);
    assert.equal(relay.hasHost(), false);
  });
});

// ---------------------------------------------------------------------------
// 2. The daemon's routes and 3. the whole chain
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = any>(): T;
}

let home: string;
let daemon: AgoraDaemon;
let port: number;
let rulesPath: string;
let logPath: string;
const daemonLog: string[] = [];

const call = (
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string>; to?: number } = {},
): Promise<Reply> =>
  new Promise((resolveCall, reject) => {
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const token = options.token === undefined ? daemon.token : options.token;
    const target = options.to ?? port;
    const req = request(
      {
        host: "127.0.0.1",
        port: target,
        method,
        path,
        headers: {
          host: `127.0.0.1:${target}`,
          ...(token ? { "x-agoryx-token": token } : {}),
          ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolveCall({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("condition not met in time");
};

const setRules = (rules: unknown[]) => {
  writeFileSync(rulesPath, JSON.stringify(rules));
  rmSync(join(home, "fake-state", "used-rules.json"), { force: true });
};

const newRoom = async (name: string, extra: Record<string, unknown> = {}) => {
  const reply = await call("POST", "/api/rooms", { body: { name, human: "Ivan", ...extra } });
  assert.equal(reply.status, 201, reply.body);
  return reply.json<{ room: { id: string } }>().room.id;
};

const snapshot = async (room: string) => (await call("GET", `/api/rooms/${room}`)).json<any>();
const idle = (room: string) => waitFor(async () => !(await snapshot(room)).state.runs.some((run: any) => run.status === "active"));
const setNetwork = async (room: string, network: boolean) =>
  assert.equal((await call("POST", `/api/rooms/${room}/settings`, { body: { network } })).status, 200);
const runOutputs = (): string[] =>
  existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .flatMap((entry) => (entry.runOutputs as string[] | undefined) ?? [])
    : [];

interface Frame {
  event: string;
  data: any;
}

/**
 * A minimal host, as the app's link is: GET /api/browser/host with the human token, SSE frames in, answers out
 * with POST /api/browser/answer/<id>. (The desktop's own BrowserLink has its own tests.)
 */
const openHost = (target = port, token = daemon.token) => {
  const frames: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  let status = 0;
  let resolveEnded: () => void;
  const ended = new Promise<void>((resolveEnd) => (resolveEnded = resolveEnd));
  let resolveOpen: () => void;
  const opened = new Promise<void>((resolveOpened) => (resolveOpen = resolveOpened));
  const req: ClientRequest = request(
    { host: "127.0.0.1", port: target, path: "/api/browser/host", headers: { host: `127.0.0.1:${target}`, "x-agoryx-token": token } },
    (res) => {
      status = res.statusCode ?? 0;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (!event || data === undefined) continue;
          const frame = { event, data: JSON.parse(data) };
          frames.push(frame);
          if (event === "hello") resolveOpen();
          for (const waiter of [...waiters]) {
            if (waiter.match(frame)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(frame);
            }
          }
        }
      });
      res.on("end", () => resolveEnded());
      res.on("close", () => resolveEnded());
    },
  );
  req.on("error", () => resolveEnded());
  req.end();
  return {
    frames,
    opened,
    ended,
    get status() {
      return status;
    },
    next(match: (frame: Frame) => boolean, ms = 20_000): Promise<Frame> {
      const seen = frames.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolveFrame, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching host frame within ${ms} ms (got ${frames.map((f) => f.event).join(",")})`)), ms);
        waiters.push({ match, resolve: (frame) => (clearTimeout(timer), resolveFrame(frame)) });
      });
    },
    close() {
      req.destroy();
    },
  };
};

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-browser-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  rulesPath = join(home, "rules.json");
  logPath = join(home, "fake.log");
  writeFileSync(rulesPath, "[]");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_HUMAN: "Ivan",
    AGORYX_JEV: "off",
    FAKE_LOG: logPath,
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: rulesPath,
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  // Advertised: daemon.json in the temporary home, which the agents' MCP server finds (and no other daemon).
  daemon = new AgoraDaemon({
    env,
    port: 0,
    opsPollMs: 50,
    watchDays: 0,
    log: (line) => daemonLog.push(line),
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the daemon's routes", () => {
  test("every request from the pane is refused before its token is looked at", async () => {
    const room = await newRoom("Pane marker");
    const pane = { "x-agoryx-pane": "1" };
    const raw = (await snapshot(room)).rawBase as string;
    for (const [path, token] of [
      ["/api/health", null],
      [`/?t=${daemon.token}`, null],
      ["/api/rooms", daemon.token],
      [`${raw}index.html`, null],
      ["/", null],
      ["/api/browser/host", daemon.token],
    ] as const) {
      const reply = await call("GET", path, { token, headers: pane });
      assert.equal(reply.status, 403, path);
      assert.equal(reply.json().error, "the room's browser cannot open Agoryx itself");
      assert.equal(reply.headers["set-cookie"], undefined, `${path}: no cookie is set`);
    }
    assert.equal((await call("GET", "/api/health", { token: null })).status, 200, "the same request without the marker is fine");
  });

  test("POST /api/browser: an agent's key only, while its turn runs, with the network on, from its own processes", async () => {
    const room = await newRoom("Browser checks");
    const key = agentKey(daemon.token, room, "claude");
    const command = { op: "snapshot", args: {} };
    const human = await call("POST", "/api/browser", { body: command });
    assert.equal(human.status, 403);
    assert.match(human.json().error, /come from agents, under their own key/);
    assert.equal((await call("POST", "/api/browser", { token: null, body: command })).status, 401);
    assert.equal((await call("POST", "/api/browser", { token: agentKey("x".repeat(32), room, "claude"), body: command })).status, 401);
    const idleAgent = await call("POST", "/api/browser", { token: key, body: command });
    assert.equal(idleAgent.status, 409);
    assert.equal(idleAgent.json().error, "The room's browser works only while your turn runs.");
    assert.equal((await call("GET", "/api/browser", { token: key })).status, 405);

    setRules([{ id: "claude", match: "Browse slowly", sleepMs: 30_000, reply: "done" }]);
    await setNetwork(room, false);
    await call("POST", `/api/rooms/${room}/messages`, { body: { text: "@claude Browse slowly" } });
    await waitFor(async () => (await snapshot(room)).presence?.claude === "working");
    const offline = await call("POST", "/api/browser", { token: key, body: command });
    assert.equal(offline.status, 403);
    assert.equal(offline.json().error, NETWORK_OFF);
    await setNetwork(room, true);
    // The key is right and the turn runs, but this request comes from the test, not from the agent's processes.
    const outsider = await call("POST", "/api/browser", { token: key, body: command });
    assert.equal(outsider.status, 403);
    assert.equal(outsider.json().error, "Browser commands must come from your own turn: your CLI, or a process it started.");
    assert.equal((await call("POST", `/api/rooms/${room}/stop`)).status, 200);
    await idle(room);
    setRules([]);
  });

  test("the host stream and answers take the human's token only; answers up to 8 MB", async () => {
    const room = await newRoom("Browser host");
    const key = agentKey(daemon.token, room, "codex");
    const asAgent = openHost(port, key);
    await asAgent.ended;
    assert.equal(asAgent.status, 403);
    assert.equal(asAgent.frames.length, 0);
    const answerAsAgent = await call("POST", `/api/browser/answer/${"0".repeat(32)}`, { token: key, body: { ok: true, result: PAGE } });
    assert.equal(answerAsAgent.status, 403);

    const host = openHost();
    await host.opened;
    assert.equal(host.status, 200);
    assert.deepEqual(host.frames[0], { event: "hello", data: { version: 1 } });
    // 2 MB is read (and refused only for its unknown id); 9 MB is not read at all.
    const twoMb = JSON.stringify({ ok: true, result: { ...PAGE, image: { data: "A".repeat(2 * 1024 * 1024), mimeType: "image/png" } } });
    assert.equal((await call("POST", `/api/browser/answer/${"0".repeat(32)}`, { raw: twoMb })).status, 404);
    const nineMb = JSON.stringify({ ok: true, result: { ...PAGE, image: { data: "A".repeat(9 * 1024 * 1024), mimeType: "image/png" } } });
    const tooBig = await call("POST", `/api/browser/answer/${"0".repeat(32)}`, { raw: nineMb }).catch((error: NodeJS.ErrnoException) => error);
    // The daemon stops reading at the limit and answers 413; the client may see the connection reset instead.
    if ("status" in tooBig) assert.equal(tooBig.status, 413, tooBig.body);
    else assert.match(String(tooBig.code), /ECONNRESET|EPIPE/);
    host.close();
    await host.ended;
  });

  test("turning a room's network off tells the host to close that room's page", async () => {
    const room = await newRoom("Browser network");
    const host = openHost();
    await host.opened;
    await setNetwork(room, true);
    await setNetwork(room, false);
    const closed = await host.next((frame) => frame.event === "close");
    assert.deepEqual(closed.data, { room });
    host.close();
    await host.ended;
  });

  test("daemon.close() with a host attached ends the stream and resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-browser-close-"));
    const other = new AgoraDaemon({ env: { ...process.env, AGORYX_HOME: join(dir, "agora"), AGORYX_JEV: "off" }, port: 0, advertise: false, watchDays: 0 });
    const otherPort = (await other.start()).port;
    try {
      const host = openHost(otherPort, other.token);
      await host.opened;
      const closing = other.close();
      await Promise.race([
        Promise.all([closing, host.ended]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close() did not finish with a host attached")), 5000).unref()),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the whole chain", () => {
  test("a fake agent's turn runs the MCP client through $AGORYX_CLI mcp; the host sees the command; the result comes back", async () => {
    const room = await newRoom("Browser chain");
    await setNetwork(room, true);
    const host = openHost();
    await host.opened;
    const navigate = [process.execPath, mcpCall, "browser_navigate", JSON.stringify({ url: "http://127.0.0.1:1/" })];
    const screenshot = [process.execPath, mcpCall, "browser_screenshot", "{}"];
    setRules([{ id: "claude", match: "Open the page", run: [navigate, screenshot], reply: "opened" }]);
    const answered = (async () => {
      const first = await host.next((frame) => frame.event === "command" && frame.data.op === "navigate");
      const reply = await call("POST", `/api/browser/answer/${first.data.id}`, {
        body: { ok: true, result: { ...PAGE, text: "Loaded.", notes: ["Codex used this browser since your last command: snapshot"] } },
      });
      assert.equal(reply.status, 200, reply.body);
      const second = await host.next((frame) => frame.event === "command" && frame.data.op === "screenshot");
      // A screenshot of 2 MB (base64) passes the answer's limit.
      const shot = await call("POST", `/api/browser/answer/${second.data.id}`, {
        body: { ok: true, result: { ...PAGE, text: "Screenshot of the viewport (1280×1330 CSS px).", image: { data: "A".repeat(2 * 1024 * 1024), mimeType: "image/png" } } },
      });
      assert.equal(shot.status, 200, shot.body);
      return first.data as BrowserCommand;
    })();
    await call("POST", `/api/rooms/${room}/messages`, { body: { text: "@claude Open the page" } });
    const command = await answered;
    await idle(room);

    assert.equal(command.room, room);
    assert.equal(command.roomName, "Browser chain");
    assert.equal(command.agent, "claude");
    assert.equal(command.label, "Claude");
    assert.equal(command.op, "navigate");
    assert.deepEqual(command.args, { url: "http://127.0.0.1:1/" });

    const outputs = runOutputs();
    assert.ok(
      outputs.includes(
        "Page: Fixture\nURL: http://127.0.0.1:1/\nViewport: 1280×1330 CSS px\nNotes:\n- Codex used this browser since your last command: snapshot\n\nLoaded.",
      ),
      JSON.stringify(outputs),
    );
    assert.ok(
      outputs.includes("Page: Fixture\nURL: http://127.0.0.1:1/\nViewport: 1280×1330 CSS px\n\nScreenshot of the viewport (1280×1330 CSS px).\n[image image/png, 2097152 base64 characters]"),
      JSON.stringify(outputs.map((output) => output.slice(0, 300))),
    );
    const lines = daemonLog.filter((line) => line.startsWith("browser: "));
    assert.ok(lines.some((line) => /^browser: claude@Browser chain navigate ok \(\d+ ms\)$/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /^browser: claude@Browser chain screenshot ok \(\d+ ms\)$/.test(line)), lines.join("\n"));
    assert.ok(!lines.some((line) => line.includes("127.0.0.1:1") || line.includes("Loaded")), "the log keeps no URL or result");
    host.close();
    await host.ended;
  });

  test("a stopped turn's command is withdrawn: the host is told, and a late answer gets 404", async () => {
    const room = await newRoom("Browser stop");
    await setNetwork(room, true);
    const host = openHost();
    await host.opened;
    setRules([{ id: "claude", match: "Hold the page", run: [[process.execPath, mcpCall, "browser_snapshot", "{}"]], reply: "held" }]);
    await call("POST", `/api/rooms/${room}/messages`, { body: { text: "@claude Hold the page" } });
    const command = await host.next((frame) => frame.event === "command" && frame.data.op === "snapshot");
    assert.equal((await call("POST", `/api/rooms/${room}/stop`)).status, 200);
    const cancel = await host.next((frame) => frame.event === "cancel");
    assert.deepEqual(cancel.data, { id: command.data.id });
    await idle(room);
    assert.equal((await call("POST", `/api/browser/answer/${command.data.id}`, { body: { ok: true, result: PAGE } })).status, 404);
    setRules([]);
    host.close();
    await host.ended;
  });

  test("the network going off while a command's body is still arriving refuses the command", async () => {
    const room = await newRoom("Browser late body");
    await setNetwork(room, true);
    const host = openHost();
    await host.opened;
    const dir = mkdtempSync(join(tmpdir(), "agora-browser-late-"));
    const started = join(dir, "started");
    const go = join(dir, "go");
    try {
      const before = runOutputs().length;
      setRules([{ id: "claude", match: "Post slowly", run: [[process.execPath, slowPost, started, go]], reply: "posted" }]);
      await call("POST", `/api/rooms/${room}/messages`, { body: { text: "@claude Post slowly" } });
      await waitFor(() => existsSync(started));
      // The turn and network checks have passed; the process check may still run. Then the network goes off.
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
      await setNetwork(room, false);
      writeFileSync(go, "");
      await waitFor(() => runOutputs().length > before);
      await idle(room);
      assert.equal(runOutputs().at(-1), `403 ${NETWORK_OFF}`);
      assert.ok(!host.frames.some((frame) => frame.event === "command" && frame.data.room === room), "no command reached the host");
    } finally {
      setRules([]);
      rmSync(dir, { recursive: true, force: true });
      host.close();
      await host.ended;
    }
  });

  test("without the app, the agent's call reaches the relay and gets the desktop-app error as a tool error", async () => {
    const room = await newRoom("Browser no app");
    await setNetwork(room, true);
    await waitFor(() => !daemon["browser"].hasHost());
    const before = runOutputs().length;
    setRules([{ id: "claude", match: "Try the browser", run: [[process.execPath, mcpCall, "browser_snapshot", "{}"]], reply: "tried" }]);
    await call("POST", `/api/rooms/${room}/messages`, { body: { text: "@claude Try the browser" } });
    await waitFor(() => runOutputs().length > before);
    await idle(room);
    assert.equal(runOutputs().at(-1), `TOOL ERROR: ${NO_HOST}`);
    assert.ok(daemonLog.some((line) => /^browser: claude@Browser no app snapshot 503 \(\d+ ms\)$/.test(line)), "it reached the relay");
    setRules([]);
  });
});
