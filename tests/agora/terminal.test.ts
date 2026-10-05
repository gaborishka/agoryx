import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { agentKey } from "../../internal/agora/actor.js";
import { sanitizeForReplay, terminalEnv } from "../../internal/agora/terminal.js";

let home: string;
let daemon: AgoraDaemon;
let port: number;

const call = (method: string, path: string, body?: unknown, token = daemon.token): Promise<{ status: number; json: () => any }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          "x-agoryx-token": token,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const socket = (path: string, headers: Record<string, string> = {}) =>
  new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { "x-agoryx-token": daemon.token, origin: `http://127.0.0.1:${port}`, ...headers },
  });

/** What the terminal prints, until `until` shows up in it. */
const readUntil = (ws: WebSocket, until: string, ms = 15_000) =>
  new Promise<{ text: string; messages: any[] }>((resolve, reject) => {
    let text = "";
    const messages: any[] = [];
    const timer = setTimeout(() => reject(new Error(`no "${until}" in: ${JSON.stringify(text.slice(-400))}`)), ms);
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.t === "out" || message.t === "replay") text += message.d;
      if (text.includes(until)) {
        clearTimeout(timer);
        resolve({ text, messages });
      }
    });
  });

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-terminal-"));
  daemon = new AgoraDaemon({
    env: { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_USER: "Ivan", AGORYX_WORKSPACES: join(home, "ws"), SHELL: "/bin/sh" },
    port: 0,
    advertise: false,
    watchDays: 0,
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("the human opens a shell in the room's folder, types into it over a WebSocket, and a new page gets what it printed", async () => {
  const room = (await call("POST", "/api/rooms", { name: "Shells" })).json().room as { id: string };
  const opened = await call("POST", `/api/rooms/${room.id}/terminals`, { cols: 90, rows: 20 });
  assert.equal(opened.status, 201);
  const terminal = opened.json().terminal as { id: string; cwd: string; cols: number };
  assert.equal(terminal.cols, 90);
  const snapshot = (await call("GET", `/api/rooms/${room.id}`)).json();
  assert.equal(terminal.cwd, snapshot.state.workspace);

  const path = `/api/rooms/${room.id}/terminals/${terminal.id}/socket`;
  const ws = socket(path);
  await new Promise((resolve) => ws.once("open", resolve));
  const printed = readUntil(ws, "sum=5");
  ws.send(JSON.stringify({ t: "in", d: "echo sum=$((2+3)); pwd\r" }));
  assert.match((await printed).text, /sum=5/);
  ws.close();

  // Another page attaches later: it gets the output so far first.
  const again = socket(path);
  const replay = await readUntil(again, "sum=5");
  assert.equal(replay.messages[0].t, "replay");
  assert.equal(replay.messages[0].info.id, terminal.id);
  again.close();

  // Typed in over the API (the session panel's «continue in the terminal»).
  const third = socket(path);
  await new Promise((resolve) => third.once("open", resolve));
  const typed = readUntil(third, "from-api-7");
  assert.equal((await call("POST", `/api/rooms/${room.id}/terminals/${terminal.id}/input`, { text: "echo from-api-$((3+4))\r" })).status, 200);
  await typed;

  const listed = (await call("GET", `/api/rooms/${room.id}/terminals`)).json().terminals as Array<{ id: string }>;
  assert.deepEqual(listed.map((t) => t.id), [terminal.id]);

  const closedFrame = new Promise<void>((resolve) => third.on("message", (data) => JSON.parse(data.toString()).t === "closed" && resolve()));
  assert.equal((await call("POST", `/api/rooms/${room.id}/terminals/${terminal.id}/close`, {})).status, 200);
  await closedFrame;
  assert.deepEqual((await call("GET", `/api/rooms/${room.id}/terminals`)).json().terminals, []);
});

test("terminals are the human's: an agent's key, a page from elsewhere, and an unknown terminal are refused", async () => {
  const room = (await call("POST", "/api/rooms", { name: "Guarded" })).json().room as { id: string; };
  const state = (await call("GET", `/api/rooms/${room.id}`)).json().state as { agents: Array<{ id: string }> };
  const key = agentKey(daemon.token, room.id, state.agents[0]!.id);
  assert.equal((await call("POST", `/api/rooms/${room.id}/terminals`, {}, key)).status, 403);
  assert.equal((await call("GET", `/api/rooms/${room.id}/terminals`, undefined, key)).status, 403);

  const terminal = (await call("POST", `/api/rooms/${room.id}/terminals`, {})).json().terminal as { id: string };
  const path = `/api/rooms/${room.id}/terminals/${terminal.id}/socket`;
  const refused = (ws: WebSocket) =>
    new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => {});
    });
  assert.equal(await refused(socket(path, { origin: "http://evil.example" })), 403);
  assert.equal(await refused(socket(path, { "x-agoryx-token": key })), 403);
  assert.equal(await refused(socket(path, { "x-agoryx-token": "wrong" })), 401);
  assert.equal(await refused(socket(`/api/rooms/${room.id}/terminals/term999/socket`)), 404);
  await call("POST", `/api/rooms/${room.id}/terminals/${terminal.id}/close`, {});
});

test("the shell does not inherit what Agoryx gives agents' turns", () => {
  const env = terminalEnv({ PATH: "/bin", AGORYX_HOME: "/h", AGORYX_AGENT_KEY: "k", AGORYX_TURN_FILE: "/t", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.AGORYX_HOME, "/h");
  assert.equal(env.AGORYX_AGENT_KEY, undefined);
  assert.equal(env.AGORYX_TURN_FILE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.TERM, "xterm-256color");
});

test("what is kept for replay drops the terminal's questions, also when one is cut between chunks", () => {
  assert.equal(sanitizeForReplay("", "a\u001b[6nb\u001b[31mred\u001b[0m").text, "ab\u001b[31mred\u001b[0m");
  const first = sanitizeForReplay("", "x\u001b]11;?");
  assert.equal(first.text, "x");
  const second = sanitizeForReplay(first.pending, "\u0007y\u001b]0;title\u0007");
  assert.equal(second.text, "y\u001b]0;title\u0007");
  assert.equal(sanitizeForReplay("", "\u001bP$qm\u001b\\ok").text, "ok");
});
