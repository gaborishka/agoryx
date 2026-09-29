import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// The room's MCP server (bin/agoryx-mcp.mjs), started the way the room hands it to the CLIs: the agents' shim
// with `mcp`. It talks to a tiny fake daemon here, whose daemon.json is in a temporary home.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shim = join(repo, "bin", "agoryx-agent.mjs");
const HUMAN_TOKEN = "human-token-that-must-never-be-sent";
const PAGE = { url: "http://localhost:5173/settings", title: "Settings", viewport: { width: 1280, height: 1330 } };
const TOOL_NAMES = ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_screenshot", "browser_eval"];

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let home: string;
let agora: string;
let server: Server;
let daemonUrl: string;
const seen: Seen[] = [];
/** What the fake daemon answers; each test sets its own. */
let answer: (body: any, res: ServerResponse) => void = (_body, res) => json(res, 200, { ok: true, result: PAGE });

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-mcp-"));
  agora = join(home, "agora");
  mkdirSync(agora, { recursive: true });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      answer(JSON.parse(body || "{}"), res);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  daemonUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  writeFileSync(join(agora, "daemon.json"), JSON.stringify({ pid: process.pid, port: 0, url: daemonUrl, token: HUMAN_TOKEN, startedAt: new Date().toISOString() }));
});

after(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(home, { recursive: true, force: true });
});

/** A client on the server's stdio: requests by id, every line it wrote, and its stderr. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: any[] = [];
  stderr = "";
  private buffer = "";
  private readonly waiting = new Map<unknown, (message: any) => void>();
  private nextId = 1;
  readonly exited: Promise<number | null>;

  constructor(env: NodeJS.ProcessEnv) {
    const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, AGORYX_HOME: agora };
    this.child = spawn(process.execPath, [shim, "mcp"], { env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        const message = JSON.parse(line);
        this.lines.push(message);
        const waiter = this.waiting.get(message.id);
        if (waiter) {
          this.waiting.delete(message.id);
          waiter(message);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((resolveExit) => this.child.on("exit", (code) => resolveExit(code)));
  }

  write(text: string) {
    this.child.stdin.write(`${text}\n`);
  }

  /** The answer to a line that carries `id`. */
  answerTo(id: unknown, text: string): Promise<any> {
    return new Promise((resolveAnswer, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(id)} within 10 s: ${text}`)), 10_000);
      this.waiting.set(id, (message) => (clearTimeout(timer), resolveAnswer(message)));
      this.write(text);
    });
  }

  request(method: string, params?: unknown, id: unknown = this.nextId++): Promise<any> {
    return this.answerTo(id, JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  }

  notify(method: string, params?: unknown) {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
  }

  async tool(name: string, args?: unknown): Promise<{ content: any[]; isError?: boolean }> {
    const reply = await this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return reply.result;
  }

  async end(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

const text = (result: { content: any[] }) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");

test("initialize: the client's version when supported, else the newest; the server's name and instructions", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.test" });
  for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
    const reply = await client.request("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(reply.jsonrpc, "2.0");
    assert.equal(reply.result.protocolVersion, version);
  }
  const reply = await client.request("initialize", { protocolVersion: "2031-01-01", capabilities: {} });
  const result = reply.result;
  assert.equal(result.protocolVersion, "2025-11-25");
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(result.serverInfo.name, "agoryx_browser");
  assert.equal(result.serverInfo.title, "Agoryx room browser");
  assert.equal(result.serverInfo.version, JSON.parse((await import("node:fs")).readFileSync(join(repo, "package.json"), "utf8")).version);
  assert.match(result.instructions, /^The Agoryx room's browser: one real browser page per room/);
  assert.match(result.instructions, /Call browser tools one at a time and wait for each result\./);
  assert.equal(await client.end(), 0, "stdin end → exit 0");
  assert.equal(client.stderr, "", "stderr stays silent");
});

test("tools/list: the seven tools, each a plain object schema, with their hints", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.test" });
  const { result } = await client.request("tools/list");
  assert.deepEqual(result.tools.map((tool: any) => tool.name), TOOL_NAMES);
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    for (const combinator of ["oneOf", "anyOf", "allOf", "not"]) assert.equal(tool.inputSchema[combinator], undefined, `${tool.name}: no top-level ${combinator}`);
    assert.equal(typeof tool.inputSchema.properties, "object");
    assert.equal(tool.annotations.openWorldHint, true, tool.name);
    assert.equal(tool.annotations.readOnlyHint, tool.name === "browser_snapshot" || tool.name === "browser_screenshot" ? true : undefined, tool.name);
    assert.ok(tool.description.length > 20);
  }
  const byName = Object.fromEntries(result.tools.map((tool: any) => [tool.name, tool.inputSchema]));
  assert.deepEqual(byName.browser_type.required, ["ref", "text"]);
  assert.deepEqual(byName.browser_navigate.properties.go.enum, ["back", "forward", "reload"]);
  assert.equal(byName.browser_snapshot.properties.timeoutMs.maximum, 30000);
  await client.end();
});

test("protocol errors: notifications get no answer; -32601, -32700, -32600 and -32602 where due; ping", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.test" });
  client.notify("notifications/initialized");
  client.notify("notifications/whatever", { x: 1 });
  const ping = await client.request("ping");
  assert.deepEqual(ping, { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(client.lines.length, 1, "the notifications were not answered");

  const unknown = await client.request("resources/list");
  assert.equal(unknown.error.code, -32601);
  const parse = await client.answerTo(null, "{ not json");
  assert.deepEqual(parse, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  const batch = await client.answerTo(null, JSON.stringify([{ jsonrpc: "2.0", id: 9, method: "ping" }]));
  assert.equal(batch.error.code, -32600);
  const noTool = await client.request("tools/call", { name: "browser_download", arguments: {} });
  assert.equal(noTool.error.code, -32602);
  assert.match(noTool.error.message, /browser_download/);
  // String ids come back as they were sent.
  assert.deepEqual(await client.request("ping", undefined, "abc"), { jsonrpc: "2.0", id: "abc", result: {} });
  assert.equal(seen.length, 0, "nothing reached the daemon");
  await client.end();
});

test("wrong arguments are tool errors, checked before anything is sent", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.test" });
  const before = seen.length;
  const cases: Array<[string, unknown, RegExp]> = [
    ["browser_navigate", {}, /exactly one of url and go/],
    ["browser_navigate", { url: "http://x/", go: "back" }, /exactly one of url and go/],
    ["browser_navigate", { go: "up" }, /go must be/],
    ["browser_click", {}, /Give ref, or x and y/],
    ["browser_click", { ref: "e1", x: 1, y: 2 }, /not both/],
    ["browser_click", { x: 10 }, /both x and y/],
    ["browser_type", { ref: "e5" }, /text must be a string/],
    ["browser_type", { ref: "e5", text: "a", clear: "yes" }, /clear must be true or false/],
    ["browser_press", { key: "" }, /key must be a non-empty string/],
    ["browser_snapshot", { timeoutMs: 60000 }, /timeoutMs/],
    ["browser_eval", {}, /expression must be a non-empty string/],
    ["browser_screenshot", { ref: "e1", full: true }, /does not take "full"/],
    ["browser_snapshot", [1], /arguments as an object/],
  ];
  for (const [name, args, pattern] of cases) {
    const result = await client.tool(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(text(result), pattern);
  }
  assert.equal(seen.length, before, "nothing reached the daemon");
  await client.end();
});

test("a call carries the agent's key and never the human's token; the result has the page lines and notes", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.room.claude.mac" });
  const before = seen.length;
  answer = (_body, res) =>
    json(res, 200, { ok: true, result: { ...PAGE, text: "Loaded.", notes: ["Codex used this browser since your last command: click e3", "the page is still loading"] } });
  const result = await client.tool("browser_navigate", { url: "http://localhost:5173/settings", go: null });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "Page: Settings\nURL: http://localhost:5173/settings\nViewport: 1280×1330 CSS px\nNotes:\n- Codex used this browser since your last command: click e3\n- the page is still loading\n\nLoaded.",
    },
  ]);
  const request = seen[before]!;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/browser");
  assert.equal(request.headers["x-agoryx-token"], "agk.room.claude.mac");
  assert.match(String(request.headers["content-type"]), /^application\/json/);
  assert.deepEqual(JSON.parse(request.body), { op: "navigate", args: { url: "http://localhost:5173/settings" } }, "a null counts as left out");
  for (const entry of seen) assert.ok(!JSON.stringify(entry).includes(HUMAN_TOKEN), "the human's token is never sent");

  // A result without notes or text: just the page lines.
  answer = (_body, res) => json(res, 200, { ok: true, result: { ...PAGE, viewport: { width: 1280.4, height: 1329.6 } } });
  assert.equal(text(await client.tool("browser_press", { key: "PageDown" })), "Page: Settings\nURL: http://localhost:5173/settings\nViewport: 1280×1330 CSS px");
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { op: "press", args: { key: "PageDown" } });
  await client.end();
});

test("with AGORYX_TURN_FILE the key is read from it on every call, and only when the turn is this agent's", async () => {
  const turnFile = join(home, "turn.json");
  const env = { AGORYX_TURN_FILE: turnFile, AGORYX_AGENT: "claude", AGORYX_ROOM: "room-1", AGORYX_AGENT_KEY: "key-from-the-environment" };
  const write = (context: Record<string, unknown>) => writeFileSync(turnFile, JSON.stringify(context));
  answer = (_body, res) => json(res, 200, { ok: true, result: PAGE });
  write({ turn: "t1", seen: "m1", agent: "claude", room: "room-1", key: "key-one" });
  const client = new Client(env);
  const before = seen.length;
  assert.equal((await client.tool("browser_snapshot", {})).isError, undefined);
  write({ turn: "t2", seen: "m4", agent: "claude", room: "room-1", key: "key-two" });
  assert.equal((await client.tool("browser_snapshot", {})).isError, undefined);
  assert.deepEqual(
    seen.slice(before).map((entry) => entry.headers["x-agoryx-token"]),
    ["key-one", "key-two"],
    "the file is read again for each call",
  );

  const notInTurn = "Not in a turn: the room's browser works only while your turn runs.";
  for (const context of [
    { turn: "t3", seen: "m5", agent: "codex", room: "room-1", key: "codex-key" },
    { turn: "t3", seen: "m5", agent: "claude", room: "room-2", key: "other-room-key" },
    { turn: 3, seen: "m5", agent: "claude", room: "room-1", key: "bad-turn-key" },
    { turn: "t3", seen: "m5", agent: "claude", room: "room-1" },
  ]) {
    write(context);
    const result = await client.tool("browser_snapshot", {});
    assert.equal(result.isError, true, JSON.stringify(context));
    assert.equal(text(result), notInTurn);
  }
  rmSync(turnFile);
  const gone = await client.tool("browser_snapshot", {});
  assert.equal(text(gone), notInTurn, "no file: no turn, even with a key in the environment");
  assert.equal(seen.length, before + 2);
  await client.end();

  const keyless = new Client({});
  assert.equal(text(await keyless.tool("browser_snapshot", {})), notInTurn);
  await keyless.end();
});

test("results and failures: an image, the daemon's refusal text, no daemon, an unreachable daemon", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.test" });
  answer = (_body, res) =>
    json(res, 200, { ok: true, result: { ...PAGE, text: "Screenshot of the viewport (1280×1330 CSS px).", image: { data: "iVBORw0KGgo=", mimeType: "image/png" } } });
  const shot = await client.tool("browser_screenshot", {});
  assert.equal(shot.content.length, 2);
  assert.equal(shot.content[1].type, "image");
  assert.equal(shot.content[1].data, "iVBORw0KGgo=");
  assert.equal(shot.content[1].mimeType, "image/png");
  assert.match(shot.content[0].text, /\n\nScreenshot of the viewport \(1280×1330 CSS px\)\.$/);

  const refusal = "The room's browser needs the Agoryx desktop app, and it is not running (or not connected to this daemon). Nothing was opened.";
  answer = (_body, res) => json(res, 503, { error: refusal });
  const noApp = await client.tool("browser_navigate", { url: "localhost:5173" });
  assert.equal(noApp.isError, true);
  assert.equal(text(noApp), refusal);
  answer = (_body, res) => json(res, 422, { error: "ref e12 is not on the page anymore (it changed or navigated). Take a new browser_snapshot." });
  assert.match(text(await client.tool("browser_click", { ref: "e12" })), /^ref e12 is not on the page anymore/);
  answer = (_body, res) => {
    res.writeHead(500);
    res.end("oops");
  };
  assert.equal(text(await client.tool("browser_snapshot", {})), "The Agoryx daemon answered 500.");
  answer = (_body, res) => json(res, 200, { ok: true, result: { url: "x" } });
  assert.equal((await client.tool("browser_snapshot", {})).isError, true, "an answer of the wrong shape is an error");
  await client.end();

  const elsewhere = mkdtempSync(join(tmpdir(), "agora-mcp-none-"));
  try {
    const nobody = new Client({ AGORYX_AGENT_KEY: "agk.test", AGORYX_HOME: elsewhere });
    const none = await nobody.tool("browser_snapshot", {});
    assert.equal(none.isError, true);
    assert.equal(text(none), `No Agoryx daemon is running here (${join(elsewhere, "daemon.json")} not found).`);
    await nobody.end();

    // Without AGORYX_HOME, the state home's agoryx/agora/daemon.json (XDG_STATE_HOME, else ~/.local/state).
    const xdg = new Client({ AGORYX_AGENT_KEY: "agk.test", AGORYX_HOME: "", XDG_STATE_HOME: join(elsewhere, "state") });
    assert.equal(text(await xdg.tool("browser_snapshot", {})), `No Agoryx daemon is running here (${join(elsewhere, "state", "agoryx", "agora", "daemon.json")} not found).`);
    await xdg.end();

    // A daemon.json whose daemon is gone.
    writeFileSync(join(elsewhere, "daemon.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: HUMAN_TOKEN }));
    const gone = new Client({ AGORYX_AGENT_KEY: "agk.test", AGORYX_HOME: elsewhere });
    const unreachable = await gone.tool("browser_snapshot", {});
    assert.equal(unreachable.isError, true);
    assert.match(text(unreachable), /^Could not reach the Agoryx daemon at http:\/\/127\.0\.0\.1:1/);
    await gone.end();
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("calls run concurrently, and each answer carries its own id", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.test" });
  answer = (body, res) => {
    const delay = body.op === "eval" ? 400 : 0;
    setTimeout(() => json(res, 200, { ok: true, result: { ...PAGE, text: body.op } }), delay);
  };
  const slow = client.request("tools/call", { name: "browser_eval", arguments: { expression: "new Promise(r => setTimeout(r, 400))" } }, 101);
  const fast = client.request("tools/call", { name: "browser_snapshot", arguments: {} }, 102);
  const [slowReply, fastReply] = await Promise.all([slow, fast]);
  assert.equal(slowReply.id, 101);
  assert.equal(fastReply.id, 102);
  assert.match(slowReply.result.content[0].text, /\n\neval$/);
  assert.match(fastReply.result.content[0].text, /\n\nsnapshot$/);
  const order = client.lines.map((line) => line.id);
  assert.ok(order.indexOf(102) < order.indexOf(101), `the quick call was answered first (${order.join(",")})`);
  await client.end();
});

test("AGORYX_MCP_DEBUG=1 writes to stderr, never to stdout", async () => {
  const client = new Client({ AGORYX_AGENT_KEY: "agk.test", AGORYX_MCP_DEBUG: "1" });
  await client.request("ping");
  assert.equal(await client.end(), 0);
  assert.match(client.stderr, /agoryx mcp: ping/);
  assert.equal(client.lines.length, 1);
});
