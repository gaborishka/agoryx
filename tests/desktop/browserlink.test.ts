import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { BrowserRelay } from "../../internal/agora/browser.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import type { ActorOrigin } from "../../internal/agora/types.js";
import { BrowserLink, type BrowserAnswer, type BrowserCommandWire } from "../../internal/desktop/browserlink.js";
import { writeFakeBins } from "../agora/helpers.js";

// The app's host link against a real daemon in a temporary AGORYX_HOME on port 0. A small proxy sits in front of
// it, so a test can refuse an answer once and move the daemon to another port behind the same url.

const scratch = mkdtempSync(join(tmpdir(), "agoryx-browserlink-"));
const { fakeClaude, fakeCodex } = writeFakeBins(scratch);
writeFileSync(join(scratch, "rules.json"), "[]");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGORYX_HOME: join(scratch, "agora"),
  AGORYX_USER: "Ivan",
  AGORYX_JEV: "off",
  FAKE_LOG: join(scratch, "fake.log"),
  FAKE_STATE: join(scratch, "fake-state"),
  FAKE_RULES: join(scratch, "rules.json"),
  CLAUDE_CONFIG_DIR: join(scratch, "claude-config"),
  CODEX_HOME: join(scratch, "codex-home"),
};

const newDaemon = () =>
  new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    opsPollMs: 50,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });

let daemon: AgoraDaemon;
let daemonPort = 0;
/** The daemon's relay, where an agent's POST /api/browser lands once the daemon has checked the agent. */
const relay = (): BrowserRelay => (daemon as unknown as { browser: BrowserRelay }).browser;

/** What the proxy saw, and what it should do next. */
const proxy = { port: 0, answers: [] as number[], refuseAnswers: 0 };
let proxyServer: Server;

before(async () => {
  daemon = newDaemon();
  daemonPort = (await daemon.start()).port;
  proxyServer = createServer((req, res) => {
    const answer = req.method === "POST" && (req.url ?? "").startsWith("/api/browser/answer/");
    if (answer && proxy.refuseAnswers > 0) {
      proxy.refuseAnswers -= 1;
      proxy.answers.push(403);
      req.resume();
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "refused by the test proxy" }));
      return;
    }
    const upstream = request(
      { host: "127.0.0.1", port: daemonPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${daemonPort}` } },
      (reply) => {
        if (answer) proxy.answers.push(reply.statusCode ?? 0);
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  proxy.port = (proxyServer.address() as AddressInfo).port;
});

after(async () => {
  proxyServer.closeAllConnections();
  await new Promise((resolve) => proxyServer.close(resolve));
  await daemon.close();
  rmSync(scratch, { recursive: true, force: true });
});

const origin = (room = "r1", agent = "claude"): ActorOrigin => ({
  room,
  roomName: `Room ${room}`,
  agent,
  label: agent === "claude" ? "Claude" : "Codex",
  kind: agent === "claude" ? "claude" : "codex",
});

const PAGE = { url: "http://127.0.0.1:1/", title: "Fixture", viewport: { width: 1280, height: 1330 } };

const waitFor = async (check: () => boolean, ms = 10_000, what = "condition"): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what} not met within ${ms} ms`);
};

/** A link through the proxy whose handler answers from `answer` and records what it was handed. */
const newLink = (answer: (command: BrowserCommandWire) => Promise<BrowserAnswer> | BrowserAnswer = () => ({ ok: true, result: PAGE })) => {
  const commands: BrowserCommandWire[] = [];
  const closed: string[] = [];
  const cancelled: string[] = [];
  const lines: string[] = [];
  const link = new BrowserLink({
    url: `http://127.0.0.1:${proxy.port}`,
    token: daemon.token,
    handle: async (command) => {
      commands.push(command);
      return answer(command);
    },
    closeRoom: (room) => closed.push(room),
    cancel: (id) => cancelled.push(id),
    log: (line) => lines.push(line),
  });
  return { link, commands, closed, cancelled, lines };
};

test("hello, then a command, then the posted answer; a handler that throws is an error answer", async () => {
  const { link, commands, lines } = newLink(async (command) => {
    if (command.op === "eval") throw new Error("the page is gone");
    return { ok: true, result: { ...PAGE, text: `did ${command.op}` } };
  });
  assert.equal(relay().hasHost(), false);
  link.start();
  assert.equal(link.running, true);
  await waitFor(() => link.connected, 10_000, "hello");
  assert.equal(relay().hasHost(), true);

  const result = await relay().command(origin(), { op: "snapshot", args: { waitForText: "Готово" } });
  assert.deepEqual(result, { ...PAGE, text: "did snapshot" });
  assert.equal(commands.length, 1);
  assert.deepEqual({ ...commands[0], id: "", deadline: 0 }, {
    id: "", deadline: 0, room: "r1", roomName: "Room r1", agent: "claude", label: "Claude", op: "snapshot", args: { waitForText: "Готово" },
  });

  await assert.rejects(relay().command(origin("r1", "codex"), { op: "eval", args: { expression: "1" } }), (error: Error & { status?: number }) => {
    assert.equal(error.status, 422);
    assert.equal(error.message, "the page is gone");
    return true;
  });
  // The token never went into a URL, and nothing of the page went into the log.
  assert.ok(!lines.some((line) => line.includes(daemon.token) || /Готово|did snapshot|page is gone/.test(line)), lines.join("\n"));
  link.stop();
  await waitFor(() => !relay().hasHost(), 5_000, "the host to detach");
  assert.equal(link.running, false);
  assert.equal(link.connected, false);
});

test("an answer refused with 403 is posted once more; refused twice, it is logged and the command stays unanswered", async () => {
  const { link, lines } = newLink();
  link.start();
  await waitFor(() => link.connected, 10_000, "hello");
  proxy.answers = [];
  proxy.refuseAnswers = 1;
  assert.deepEqual(await relay().command(origin(), { op: "press", args: { key: "Enter" } }), PAGE);
  // The daemon settles the command before its 200 is back through the proxy.
  await waitFor(() => proxy.answers.length === 2, 5_000, "the second answer's status");
  assert.deepEqual(proxy.answers, [403, 200]);

  proxy.answers = [];
  proxy.refuseAnswers = 2;
  const pending = relay().command(origin(), { op: "click", args: { ref: "e1" } });
  await waitFor(() => lines.some((line) => /answer to a click command was not taken \(403\)/.test(line)), 5_000, "the log line");
  assert.deepEqual(proxy.answers, [403, 403], "never a third time");
  // The relay still waits for it; the host going away ends it.
  link.stop();
  await assert.rejects(pending, (error: Error & { status?: number }) => error.status === 503);
});

test("an answer the daemon refuses as not valid is replaced by a short error, so the agent does not wait for a 504", async () => {
  const { link, lines } = newLink((command) =>
    command.op === "eval" ? { ok: true, result: { ...PAGE, viewport: { width: "wide" } } as unknown as typeof PAGE } : { ok: true, result: PAGE },
  );
  link.start();
  await waitFor(() => link.connected, 10_000, "hello");
  proxy.answers = [];
  const started = Date.now();
  await assert.rejects(relay().command(origin(), { op: "eval", args: { expression: "1" } }), (error: Error & { status?: number }) => {
    assert.equal(error.status, 422);
    assert.match(error.message, /finished this command, but its result could not be delivered/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000);
  await waitFor(() => proxy.answers.length === 2, 5_000, "both answers' statuses");
  assert.deepEqual(proxy.answers, [400, 200]);
  assert.ok(lines.some((line) => /answer to a eval command was not taken \(400\)/.test(line)), lines.join("\n"));
  link.stop();
});

test("a command the daemon withdraws reaches the link as cancel(id)", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const { link, commands, cancelled } = newLink(async () => {
    await held;
    return { ok: true, result: PAGE };
  });
  link.start();
  await waitFor(() => link.connected, 10_000, "hello");
  const gaveUp = new AbortController();
  const pending = relay().command(origin("r-cancel"), { op: "snapshot", args: {} }, gaveUp.signal);
  await waitFor(() => commands.length === 1, 5_000, "the command at the link");
  gaveUp.abort();
  await assert.rejects(pending, (error: Error & { status?: number }) => error.status === 499);
  await waitFor(() => cancelled.length === 1, 5_000, "cancel");
  assert.deepEqual(cancelled, [commands[0]!.id]);
  release();
  link.stop();
  await waitFor(() => !relay().hasHost(), 5_000, "the host to detach");
});

test("the room's network going off calls closeRoom", async () => {
  const { link, closed } = newLink();
  link.start();
  await waitFor(() => link.connected, 10_000, "hello");
  const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify({ name: "net-room" });
    const req = request(
      {
        host: "127.0.0.1",
        port: daemonPort,
        method: "POST",
        path: "/api/rooms",
        headers: { host: `127.0.0.1:${daemonPort}`, "x-agoryx-token": daemon.token, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(reply.status, 201, reply.body);
  const room = (JSON.parse(reply.body) as { room: { id: string } }).room.id;
  for (const network of [true, false]) {
    const body = JSON.stringify({ network });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: daemonPort,
          method: "POST",
          path: `/api/rooms/${room}/settings`,
          headers: { host: `127.0.0.1:${daemonPort}`, "x-agoryx-token": daemon.token, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(status, 200);
  }
  await waitFor(() => closed.includes(room), 5_000, "closeRoom");
  assert.deepEqual(closed, [room]);
  link.stop();
});

test("the link opens the stream again after the daemon restarts on another port", async () => {
  const { link, commands } = newLink();
  link.start();
  await waitFor(() => link.connected, 10_000, "hello");
  await daemon.close();
  await waitFor(() => !link.connected, 5_000, "the stream to drop");
  assert.equal(link.running, true, "it keeps trying");
  // The same home, so the same token; a new port behind the proxy's url.
  daemon = newDaemon();
  const previous = daemonPort;
  daemonPort = (await daemon.start()).port;
  assert.notEqual(daemonPort, previous);
  await waitFor(() => link.connected, 15_000, "hello from the new daemon");
  assert.deepEqual(await relay().command(origin(), { op: "screenshot", args: {} }), PAGE);
  assert.equal(commands.at(-1)?.op, "screenshot");
  link.stop();
});

test("a second app replaces the first, which stops and does not come back", async () => {
  const first = newLink();
  const second = newLink(() => ({ ok: true, result: { ...PAGE, title: "second" } }));
  first.link.start();
  await waitFor(() => first.link.connected, 10_000, "first hello");
  second.link.start();
  await waitFor(() => second.link.connected, 10_000, "second hello");
  await waitFor(() => !first.link.running, 5_000, "the first link to stop");
  assert.equal(first.link.connected, false);
  // Its owner reads this and does not start it again for the same daemon.
  assert.equal(first.link.replaced, true);
  assert.equal(second.link.replaced, false);
  assert.ok(first.lines.some((line) => /another Agoryx app hosts the room's browser now/.test(line)));
  // Longer than the first backoff: the first link never opened its stream again.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(second.link.connected, true);
  assert.equal((await relay().command(origin(), { op: "snapshot", args: {} })).title, "second");
  assert.equal(first.commands.length, 0);
  second.link.stop();
});

test("stop() leaves no timer and no socket: nothing reaches the daemon's port afterwards", async () => {
  // A port nobody listens on yet: the link fails, and waits to try again.
  const spare = createServer();
  await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
  const port = (spare.address() as AddressInfo).port;
  await new Promise((resolve) => spare.close(resolve));
  const lines: string[] = [];
  const link = new BrowserLink({
    url: `http://127.0.0.1:${port}`,
    token: "t",
    handle: async () => ({ ok: true, result: PAGE }),
    closeRoom: () => {},
    log: (line) => lines.push(line),
  });
  link.start();
  await waitFor(() => lines.length > 0, 5_000, "the first failure");
  assert.equal(link.connected, false);
  link.stop();
  assert.equal((link as unknown as { timer: unknown }).timer, null);
  // Something listens there now; a pending retry would reach it within its 1 s backoff.
  let reached = 0;
  const listener = createServer((_req, res) => {
    reached += 1;
    res.end();
  });
  listener.on("connection", () => (reached += 1));
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await new Promise((resolve) => listener.close(resolve));
  assert.equal(reached, 0);
  assert.equal(link.running, false);
});
