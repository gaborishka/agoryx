import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentKey, readAgentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { docHash } from "../../internal/agora/doc.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { eventPatch } from "../../internal/agora/snapshot.js";
import { RoomStore } from "../../internal/agora/store.js";
import { DEFAULT_SETTINGS, type RoomEvent, type RoomState } from "../../internal/agora/types.js";
import { sysText } from "../../ui/src/lib/format.js";
import { participant } from "../../ui/src/lib/room.js";
import { createTestRoom, withTimeout, writeFakeBins } from "./helpers.js";

// Agents' keys: what an agent does with the human's own CLI (or the API) inside its turn is its own,
// never the human's. Every daemon here lives in a temporary AGORYX_HOME on a port of its own.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The human's global `agoryx`, as an agent's login shell may find it ahead of the room's shim. */
const humanCli = (...argv: string[]) => [process.execPath, "--import", pathToFileURL(join(repo, "node_modules/tsx/dist/loader.mjs")).href, join(repo, "cmd/agoryx/main.ts"), ...argv];

let home: string;
let daemon: AgoraDaemon;
let port: number;
let rulesPath: string;
let logPath: string;

const call = (method: string, path: string, options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}) =>
  new Promise<{ status: number; body: string; json<T = any>(): T }>((resolveCall, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const token = options.token === undefined ? daemon.token : options.token;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(token ? { "x-agoryx-token": token } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolveCall({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("condition not met in time");
};

/** New rules for the fake agents ("once" is remembered by index, so the memory goes with the old rules). */
const setRules = (rules: unknown[]) => {
  writeFileSync(rulesPath, JSON.stringify(rules));
  rmSync(join(home, "fake-state", "used-rules.json"), { force: true });
};

const newRoom = async (name: string, extra: Record<string, unknown> = {}) => {
  const reply = await call("POST", "/api/rooms", { body: { name, human: "Ivan", ...extra } });
  assert.equal(reply.status, 201, reply.body);
  return reply.json<{ room: { id: string } }>().room.id;
};

const state = async (room: string): Promise<RoomState> => (await call("GET", `/api/rooms/${room}`)).json().state;
const events = (room: string): RoomEvent[] => RoomStore.open(join(home, "agora", "rooms"), room).events;
const idle = (room: string) => waitFor(async () => !(await state(room)).runs.some((run) => run.status === "active"));
const logLines = () =>
  existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-actors-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  rulesPath = join(home, "rules.json");
  logPath = join(home, "fake.log");
  writeFileSync(rulesPath, "[]");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_HUMAN: "Ivan",
    FAKE_LOG: logPath,
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: rulesPath,
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  // Advertised (daemon.json in the temporary home), so the CLI an agent runs finds this daemon and no other.
  daemon = new AgoraDaemon({
    env,
    port: 0,
    opsPollMs: 50,
    watchDays: 0,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("an agent's key names its room and agent, and only under the secret that signed it", () => {
  const key = agentKey("s".repeat(32), "my-room-1a2b3c", "codex");
  assert.deepEqual(readAgentKey("s".repeat(32), key), { room: "my-room-1a2b3c", agent: "codex" });
  assert.equal(readAgentKey("t".repeat(32), key), null, "another daemon's token does not accept it");
  assert.equal(readAgentKey("s".repeat(32), key.replace(".codex.", ".claude.")), null, "the agent cannot be swapped");
  assert.equal(readAgentKey("s".repeat(32), key.replace("my-room", "my-rooms")), null, "nor the room");
  assert.equal(readAgentKey("s".repeat(32), "s".repeat(32)), null, "the human's token is not an agent key");
});

test("the human's CLI in an agent's turn acts as that agent: settings, another round, a new room — never as the human", async () => {
  setRules([
      {
        id: "claude",
        match: "Plan the release",
        once: true,
        run: [humanCli("settings", "--network", "on"), humanCli("more"), humanCli("new", "Side room", "-m", "look at the flaky test")],
        reply: "claude done",
      },
    ]);
  const room = await newRoom("Release", { budget: 2 });
  assert.equal((await call("POST", `/api/rooms/${room}/messages`, { body: { text: "Plan the release" } })).status, 201);
  await waitFor(() => logLines().some((line) => line.runOutputs));
  await idle(room);

  const ran = logLines().find((line) => line.runOutputs)!.runOutputs as string[];
  for (const output of ran) assert.doesNotMatch(output, /^ERR/, output);
  const turn = logLines().find((line) => line.env?.AGORYX_AGENT === "claude" && line.env?.AGORYX_ROOM === room)!;
  assert.match(turn.env.AGORYX_AGENT_KEY, /^agx1\./, "the turn's environment carries the agent's own key");
  assert.equal((await call("GET", "/api/rooms", { token: turn.env.AGORYX_AGENT_KEY })).status, 200, "the daemon accepts it");

  const log = events(room);
  const settings = log.filter((event) => event.type === "settings.changed");
  assert.deepEqual(
    settings.map((event) => event.type === "settings.changed" && [event.by, event.patch]),
    [["claude", { network: true }]],
  );
  const extended = log.filter((event) => event.type === "run.extended");
  assert.ok(extended.length > 0, "another round in a budgeted run extends it");
  for (const event of extended) assert.equal(event.type === "run.extended" && event.by, "claude", "the round is Claude's, not Ivan's");
  const after = await state(room);
  const lines = after.messages.filter((message) => message.kind === "system").map((message) => [message.author, message.text]);
  assert.deepEqual(lines, [
    ["claude", "Claude changed the settings: network on."],
    ["claude", "Claude asked for another round."],
  ]);
  assert.equal(after.messages.filter((message) => message.kind === "human").length, 1, "only Ivan's own message is the human's");

  // The new room: opened by Claude from this room; its human is still Ivan; its first message is Claude's.
  const side = (await call("GET", "/api/rooms")).json<{ rooms: Array<{ id: string; name: string }> }>().rooms.find((entry) => entry.name === "Side room")!;
  assert.ok(side, "the agent's `agoryx new` created the room");
  await idle(side.id);
  const sideState = await state(side.id);
  assert.equal(sideState.human, "Ivan");
  assert.deepEqual(sideState.createdBy, { room, roomName: "Release", agent: "claude", label: "Claude", kind: "claude" });
  const first = sideState.messages[0]!;
  assert.equal(first.kind, "agent", "an agent's message is never the human's");
  assert.equal(first.author, `claude@${room}`);
  assert.equal(first.from?.room, room);
  assert.equal(first.text, "look at the flaky test");
  assert.ok(sideState.turns.length > 0, "it woke the new room's agents");
  assert.match(logLines().find((line) => line.env?.AGORYX_ROOM === side.id)!.prompt, /Claude \(from room "Release"\)/);
});

test("an agent stopping its room with the human's CLI is recorded as that agent", async () => {
  setRules([{ id: "codex", match: "Long job", once: true, run: [humanCli("stop")], reply: "never" }, { id: "claude", match: "Long job", sleepMs: 20_000 }]);
  const room = await newRoom("Stoppable");
  await call("POST", `/api/rooms/${room}/messages`, { body: { text: "Long job" } });
  await waitFor(() => events(room).some((event) => event.type === "run.ended"));
  const ended = events(room).find((event) => event.type === "run.ended")!;
  assert.equal(ended.type === "run.ended" && ended.reason, "stopped");
  assert.equal(ended.type === "run.ended" && ended.by, "codex");
  const s = await state(room);
  const line = s.messages.find((message) => message.kind === "system")!;
  assert.deepEqual([line.author, line.text], ["codex", "Codex stopped the run."]);
  assert.ok(!s.messages.some((message) => /Ivan stopped/.test(message.text)));
});

test("the room's own agoryx is the full CLI too: an agent's settings change through it is made, and is the agent's", async () => {
  // `agoryx` here is whatever the turn's PATH finds first: the room's shim.
  setRules([{ id: "claude", match: "Shim settings", once: true, run: [["agoryx", "settings", "--budget", "9"]], reply: "set" }, { id: "codex", match: "Shim settings", once: true, reply: "ok" }]);
  const room = await newRoom("Shim settings");
  await call("POST", `/api/rooms/${room}/messages`, { body: { text: "Shim settings" } });
  await idle(room);
  const changed = events(room).find((event) => event.type === "settings.changed");
  assert.ok(changed && changed.type === "settings.changed", JSON.stringify(logLines().filter((line) => line.runOutputs)));
  assert.equal(changed.by, "claude");
  assert.equal((await state(room)).settings.budget, 9);
});

test("an agent's turn without a key of its own is refused, not sent as the human's", async () => {
  const room = await newRoom("Keyless");
  const [bin, ...args] = humanCli("settings", "--network", "off", "--room", room);
  const env = { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_ROOM: room, AGORYX_AGENT: "codex", AGORYX_TURN: "t9" };
  delete env.AGORYX_AGENT_KEY;
  // Not spawnSync: the daemon lives in this process and must answer while the CLI runs.
  const result = await new Promise<{ code: number | null; stderr: string }>((done) => {
    execFile(bin!, args, { env, encoding: "utf8" }, (error, _stdout, stderr) => done({ code: error ? ((error.code as number) ?? 1) : 0, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /codex's turn, but it has no AGORYX_AGENT_KEY/);
  assert.ok(!events(room).some((event) => event.type === "settings.changed"), "nothing was done in the human's name");
});

test("a key used in another room signs as that agent from its room; a bad key gets a clear refusal", async () => {
  setRules([]);
  const home = await newRoom("Home room");
  const other = await newRoom("Other room", { doc: "notes.md" });
  const key = agentKey(daemon.token, home, "codex");

  const posted = await call("POST", `/api/rooms/${other}/messages`, { token: key, body: { text: "hello from next door" } });
  assert.equal(posted.status, 201, posted.body);
  const message = posted.json().message;
  assert.equal(message.kind, "agent");
  assert.equal(message.author, `codex@${home}`);
  assert.deepEqual(message.from, { room: home, roomName: "Home room", agent: "codex", label: "Codex", kind: "codex" });
  await idle(other);

  const op = await call("POST", `/api/rooms/${other}/table`, { token: key, body: { op: "ask", text: "Who owns the flaky test?" } });
  assert.equal(op.status, 201, op.body);
  assert.equal(op.json().op.by, `codex@${home}`);
  assert.equal(op.json().op.from.room, home);
  await idle(other);

  assert.equal((await call("POST", `/api/rooms/${other}/rename`, { token: key, body: { name: "Shared work" } })).status, 200);
  const doc = await call("GET", `/api/rooms/${other}/doc`);
  const saved = await call("POST", `/api/rooms/${other}/doc`, { token: key, body: { text: "# notes\nby codex\n", base: doc.json().hash ?? docHash(doc.json().text ?? "") } });
  assert.equal(saved.status, 200, saved.body);

  const s = await state(other);
  assert.equal(s.name, "Shared work");
  assert.equal(s.guests[`codex@${home}`]?.roomName, "Home room");
  assert.equal(s.docRevisions.at(-1)?.by, `codex@${home}`);
  const renamed = events(other).find((event) => event.type === "room.renamed")!;
  assert.equal(renamed.type === "room.renamed" && renamed.by, `codex@${home}`);
  assert.ok(s.messages.some((entry) => entry.author === `codex@${home}` && entry.text === 'Codex (from room "Home room") renamed the room to "Shared work".'));
  assert.ok(!s.agents.some((agent) => agent.id.includes("@")), "a guest is not seated in the room");

  // Refused, with a reason: another daemon's key, a tampered one, a room that does not exist, an agent not in the room.
  const refusals = [
    agentKey("x".repeat(32), home, "codex"),
    `${key.slice(0, -2)}AA`,
    agentKey(daemon.token, "no-such-room-000000", "codex"),
    agentKey(daemon.token, home, "gemini"),
  ];
  for (const bad of refusals) {
    const reply = await call("POST", `/api/rooms/${other}/stop`, { token: bad });
    assert.equal(reply.status, 401, bad);
    assert.match(reply.json().error, /agent key/);
  }
  // An agent key is not a browser login.
  assert.equal((await call("GET", `/api/rooms?token=${encodeURIComponent(key)}`, { token: null })).status, 401);
  assert.equal((await call("GET", "/api/rooms", { token: null, headers: { cookie: `agoryx_token=${encodeURIComponent(key)}` } })).status, 401);
});

test("the human's token is still the human's: messages, stop and settings as before", async () => {
  setRules([{ match: "Think slowly", sleepMs: 20_000 }]);
  const room = await newRoom("Human room");
  const posted = await call("POST", `/api/rooms/${room}/messages`, { body: { text: "Think slowly" } });
  assert.equal(posted.json().message.kind, "human");
  assert.equal(posted.json().message.author, "Ivan");
  await waitFor(async () => (await state(room)).turns.length > 0);
  assert.equal((await call("POST", `/api/rooms/${room}/stop`)).status, 200);
  assert.equal((await call("POST", `/api/rooms/${room}/settings`, { body: { network: true } })).status, 200);
  const s = await state(room);
  const stop = s.messages.find((message) => message.kind === "system")!;
  assert.deepEqual([stop.author, stop.text], ["agoryx", "Ivan stopped the run."], "the human's stop line is as it was");
  assert.equal(s.messages.filter((message) => message.kind === "system").length, 1, "the human's own settings change posts no line");
  const changed = events(room).find((event) => event.type === "settings.changed")!;
  assert.equal(changed.type === "settings.changed" && changed.by, "Ivan");
});

test("the engine records who did what: an agent's post, round, settings, rename and stop are its own", async () => {
  const room = createTestRoom({ rules: [{ match: "slow", sleepMs: 20_000 }] });
  try {
    const { engine, store } = room;
    const message = engine.post("I will take the parser", "codex");
    assert.equal(message.kind, "agent");
    assert.equal(message.author, "codex");
    engine.continueRun("claude");
    engine.updateSettings({ budget: 3 }, "claude");
    engine.rename("Parser work", "codex");
    engine.postHuman("slow");
    await waitFor(() => store.state.turns.some((turn) => turn.status === "running"));
    await withTimeout(engine.stop("human", "codex"));
    const log = store.events;
    const by = (type: string) => log.filter((event) => event.type === type).map((event) => (event as { by?: string }).by);
    assert.deepEqual(by("settings.changed"), ["claude"]);
    assert.deepEqual(by("room.renamed"), ["codex"]);
    assert.deepEqual(by("run.ended").filter(Boolean), ["codex"]);
    assert.ok(!by("run.extended").includes("Ivan"));
    const lines = store.state.messages.filter((entry) => entry.kind === "system").map((entry) => `${entry.author}: ${entry.text}`);
    assert.deepEqual(lines, [
      "claude: Claude asked for another round.",
      "claude: Claude changed the settings: budget 3 turns per run.",
      'codex: Codex renamed the room to "Parser work".',
      "codex: Codex stopped the run.",
    ]);
  } finally {
    await room.cleanup();
  }
});

test("the room list names a guest's message by the guest, not as the human's", () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-guestsum-"));
  try {
    const store = RoomStore.create(dir, {
      name: "Next door",
      workspace: join(dir, "ws"),
      createdWorkspace: false,
      human: "Ivan",
      agents: [{ id: "claude", kind: "claude", label: "Claude" }],
      settings: DEFAULT_SETTINGS,
    });
    const from = { room: "home-1", roomName: "Home", agent: "codex", label: "Codex", kind: "codex" as const };
    store.append({ type: "message.posted", message: { id: "m1", author: "codex@home-1", kind: "agent", text: "hello", mentions: [], wakes: true, from } });
    assert.equal(store.summary().lastMessage?.label, 'Codex (from room "Home")');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log from before authors were recorded reads as it did", () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-oldlog-"));
  try {
    const store = RoomStore.create(dir, {
      name: "Old",
      workspace: join(dir, "ws"),
      createdWorkspace: false,
      human: "Ivan",
      agents: [{ id: "claude", kind: "claude", label: "Claude" }],
      settings: { ...DEFAULT_SETTINGS, network: false },
    });
    store.append({ type: "settings.changed", patch: { network: true } });
    store.append({ type: "room.renamed", name: "Older" });
    store.append({ type: "run.started", runId: "r1", trigger: null, budget: 2 });
    store.append({ type: "run.extended", runId: "r1", by: "Ivan", turns: 1 });
    store.append({ type: "run.ended", runId: "r1", reason: "stopped", turns: 0 });
    const reopened = RoomStore.open(dir, store.id).state;
    assert.equal(reopened.name, "Older");
    assert.equal(reopened.settings.network, true);
    assert.deepEqual(reopened.guests, {});
    assert.equal(reopened.createdBy, undefined);
    assert.equal(reopened.runs[0]?.status, "ended");
    assert.equal(eventPatch(reopened, store.events.at(-1)!).guests, undefined, "no guests in a patch that names none");
    // The UI's lines from those logs are unchanged.
    assert.equal(sysText("Ivan stopped the run."), "Розмову зупинено.");
    assert.equal(sysText("Ivan asked for another round."), "Ivan просить ще один раунд.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the UI says which agent acted, and names an agent of another room with its room", () => {
  assert.equal(sysText("Codex stopped the run.", "Codex"), "Codex зупиняє розмову.");
  assert.equal(sysText("Claude changed the settings: budget 5 turns per run, network off.", "Claude"), "Claude змінює налаштування: ліміт 5 ходів на розмову, мережа вимкнена.");
  assert.equal(sysText('Codex renamed the room to "Parser".', "Codex"), "Codex перейменовує кімнату на «Parser».");
  const seating = {
    agents: [{ id: "claude", kind: "claude" as const, label: "Claude" }],
    human: "Ivan",
    guests: { "codex@home-1": { room: "home-1", roomName: "Home", agent: "codex", label: "Codex", kind: "codex" as const } },
  };
  const guest = participant(seating, "codex@home-1");
  assert.equal(guest.label, "Codex (з кімнати «Home»)");
  assert.equal(guest.agent, false, "not one of this room's agents");
  assert.equal(guest.tone, "codex");
});

test("an agent running `agoryx down` in its turn is named in the room whose run the daemon stopped", async () => {
  // A daemon of its own (its own home and port): this one is stopped by the test.
  const own = mkdtempSync(join(tmpdir(), "agora-down-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(own);
  writeFileSync(
    join(own, "rules.json"),
    JSON.stringify([
      { id: "codex", match: "Wind down", run: [humanCli("down")], reply: "never" },
      { id: "claude", match: "Wind down", sleepMs: 20_000 },
    ]),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGORYX_HOME: join(own, "agora"),
    AGORYX_HUMAN: "Ivan",
    FAKE_LOG: join(own, "fake.log"),
    FAKE_STATE: join(own, "fake-state"),
    FAKE_RULES: join(own, "rules.json"),
    CLAUDE_CONFIG_DIR: join(own, "claude-config"),
    CODEX_HOME: join(own, "codex-home"),
  };
  const second = new AgoraDaemon({ env, port: 0, opsPollMs: 50, watchDays: 0, runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) } });
  const info = await second.start();
  try {
    const created = await fetch(`${info.url}/api/rooms`, {
      method: "POST",
      headers: { "x-agoryx-token": info.token, "content-type": "application/json" },
      body: JSON.stringify({ name: "Winding", text: "Wind down" }),
    });
    assert.equal(created.status, 201);
    const room = ((await created.json()) as { room: { id: string } }).room.id;
    const roomsRoot = join(own, "agora", "rooms");
    await waitFor(() => RoomStore.open(roomsRoot, room).events.some((event) => event.type === "run.ended"));
    await waitFor(() => !existsSync(join(own, "agora", "daemon.json")), 20_000);
    const log = RoomStore.open(roomsRoot, room);
    const ended = log.events.find((event) => event.type === "run.ended")!;
    assert.equal(ended.type === "run.ended" && ended.by, "codex");
    const line = log.state.messages.find((message) => message.kind === "system")!;
    assert.deepEqual([line.author, line.text], ["codex", "Codex stopped the daemon, so the run was stopped."]);
  } finally {
    await second.close();
    rmSync(own, { recursive: true, force: true });
  }
});
