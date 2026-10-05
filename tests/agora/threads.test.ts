import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { changeRoomMode, createRoom, openEngine } from "../../internal/agora/service.js";
import { applyTableOp, emptyTable, prepareTableOp } from "../../internal/agora/table.js";
import { tableItems, threadReport, threadText } from "../../internal/agora/threads.js";
import { writeFakeBins } from "./helpers.js";

let home: string;
let daemon: AgoraDaemon;
let url: string;
let env: NodeJS.ProcessEnv;

const call = async (method: string, path: string, body?: unknown) => {
  const send = () =>
    fetch(`${url}${path}`, {
      method,
      headers: { "x-agoryx-token": daemon.token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // A read that loses a reused keep-alive socket under load is sent again; a write is not.
  const res = await send().catch((error) => (method === "GET" ? send() : Promise.reject(error)));
  return { status: res.status, body: (await res.json()) as any };
};

const snapshot = async (room: string) => (await call("GET", `/api/rooms/${room}`)).body.state;

const waitFor = async <T>(check: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // A poll that loses its connection (a reused keep-alive socket, under load) is read again, not a failure.
    const got = await check().catch(() => undefined);
    if (got) return got;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition not met in time");
};

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const makeRepo = (name: string) => {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "parser.ts"), "export const parse = () => null;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "first");
  return repo;
};

const rules = (list: unknown[]) => writeFileSync(join(home, "rules.json"), JSON.stringify(list));

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-threads-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  rules([]);
  env = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_USER: "Ivan",
    AGORYX_LIVE: "0",
    AGORYX_ACK_MS: "60000",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    FAKE_MARKS: home,
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  daemon = new AgoraDaemon({ env, port: 0, opsPollMs: 50, runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) } });
  url = (await daemon.start()).url;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("an agent starts a thread; when its run ends the parent gets the report verbatim, and only the spawner wakes", async () => {
  const repo = makeRepo("agent-repo");
  rules([
    // In the thread: an edit left uncommitted, an item on its table, a last word.
    {
      agent: "claude",
      match: "THREAD-BRIEF",
      once: true,
      // Only once the parent went quiet: whatever wakes in it after this is the report's doing.
      waitForMark: "parent-quiet",
      write: [{ path: "parser.ts", content: "export const parse = (s: string) => s.split(',');\n" }],
      table: [["table", "ask", "Should empty fields be kept?"]],
      reply: "Fixed the parser.\nLeft it uncommitted for your review.",
    },
    // In the parent: start it.
    { agent: "claude", match: "Split the parser off", once: true, table: [["new", "--from", "here", "Parser fix", "-m", "THREAD-BRIEF: fix the parser"]], reply: "Started a thread for it." },
    { agent: "claude", match: 'Thread "Parser fix"', once: true, reply: "Seen the thread's report." },
  ]);
  const parent = (await call("POST", "/api/rooms", { name: "Main", dir: repo, mode: "work", text: "Split the parser off into a thread" })).body.room;

  await waitFor(async () => {
    const state = await snapshot(parent.id);
    return state.messages.some((m: any) => m.text === "Started a thread for it.") && state.runs.every((run: any) => run.status === "ended") && !state.turns.some((t: any) => t.status === "running");
  });
  writeFileSync(join(home, "parent-quiet"), "");
  const reply = await waitFor(async () => (await snapshot(parent.id)).messages.find((m: any) => m.text === "Seen the thread's report."));
  const state = await snapshot(parent.id);
  const report = state.messages.find((m: any) => m.sys?.code === "thread.reported");
  assert.ok(report, "the parent got a report");
  assert.equal(report.author, "agoryx");
  assert.deepEqual(report.mentions, ["claude"]);
  assert.equal(report.wakes, true);
  assert.equal(report.sys.name, "Parser fix");
  assert.deepEqual(report.sys.agents, ["Claude"]);
  assert.equal(report.sys.branch, "agoryx/parser-fix");
  assert.equal(report.sys.base, "main");
  assert.deepEqual(report.sys.files.map((f: any) => [f.status, f.path]), [["M", "parser.ts"]]);
  assert.equal(report.sys.uncommitted, 1);
  assert.deepEqual(report.sys.items, [{ id: "Q1", text: "Should empty fields be kept?" }]);
  assert.deepEqual(report.sys.last, { by: "Claude", text: "Fixed the parser.\nLeft it uncommitted for your review." });
  assert.equal(report.sys.wakes, "claude");
  assert.match(report.text, /Thread "Parser fix" \(.+, Claude\) went quiet\./);
  assert.match(report.text, /Branch agoryx\/parser-fix \(from main\): 1 file changed, 1 file uncommitted:\n  M parser\.ts \+1 −1/);
  assert.match(report.text, /Its last message, by Claude:\n    Fixed the parser\.\n    Left it uncommitted for your review\./);
  // The report woke the spawner, and nobody else: codex had no turn after it.
  assert.ok(reply.seq > report.seq);
  assert.equal(state.turns.filter((t: any) => t.agent === "codex" && t.seq > report.seq && t.seq < reply.seq).length, 0);

  const thread = await snapshot(report.sys.room);
  assert.equal(thread.parent, parent.id);
  assert.equal(thread.createdBy.agent, "claude");
  assert.deepEqual(thread.agents.map((a: any) => a.id), ["claude"]);
  // The thread's agent was told whose thread it is; the parent's, how to start one.
  const prompts = readFileSync(join(home, "fake.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).prompt ?? "");
  // Any order: under load the parent's codex (whose prompt may quote the command) can start before the thread does.
  assert.ok(prompts.some((prompt) => /Thread: this room is a thread of "Main" \(main-\w+\), on its own branch agoryx\/parser-fix\./.test(prompt)));
  assert.ok(prompts.some((prompt) => prompt.includes("Split the parser off") && /Threads: `.*new --from here --agents/.test(prompt)));
  const rooms = (await call("GET", "/api/rooms")).body.rooms;
  assert.equal(rooms.find((r: any) => r.id === thread.id).parent, parent.id);
  // An agent's thread is the agent's to read: the human is not called for it.
  const attention = (await call("GET", "/api/attention")).body;
  assert.ok(!attention.rooms.some((item: any) => item.reason === "thread"));
});

test("a thread the human starts wakes nobody when it reports and waits in Attention; Chat cannot have one", async () => {
  const repo = makeRepo("human-repo");
  rules([{ agent: "codex", match: "THREAD-BRIEF", reply: "Done, nothing to change." }]);
  const parent = (await call("POST", "/api/rooms", { name: "Main two", dir: repo, mode: "work", agents: [{ kind: "codex" }, { kind: "claude" }] })).body.room;
  const made = await call("POST", "/api/rooms", { name: "Look around", from: parent.id, text: "THREAD-BRIEF: look around" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // One agent unless the roster says otherwise: the parent's first.
  assert.deepEqual(made.body.room.agents.map((a: any) => a.id), ["codex"]);
  assert.equal(made.body.room.branch, "agoryx/look-around");

  const report = await waitFor(async () => (await snapshot(parent.id)).messages.find((m: any) => m.sys?.code === "thread.reported"));
  assert.equal(report.wakes, false);
  assert.deepEqual(report.mentions, []);
  assert.equal(report.sys.wakes, undefined);
  assert.deepEqual(report.sys.files, []);
  assert.match(report.text, /Branch agoryx\/look-around \(from main\): no changes\./);
  const item = await waitFor(async () => (await call("GET", "/api/attention")).body.rooms.find((entry: any) => entry.room === parent.id));
  assert.equal(item.reason, "thread");
  assert.equal(item.by, "Look around");
  assert.equal(item.text, "Done, nothing to change.");
  // Nobody in the parent was woken by it.
  assert.equal((await snapshot(parent.id)).turns.length, 0);

  const chat = (await call("POST", "/api/rooms", { name: "Just chat" })).body.room;
  const refused = await call("POST", "/api/rooms", { name: "No", from: chat.id });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Chat room: a thread needs a working folder/);
  const elsewhere = await call("POST", "/api/rooms", { name: "Elsewhere", from: parent.id, dir: makeRepo("other-repo") });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.body.error, /a thread works in its room's folder/);
});

test("a report whose room another process drives waits, and goes in once that room is free", async () => {
  const repo = makeRepo("held-repo");
  rules([{ agent: "codex", match: "HELD-BRIEF", reply: "Looked, all fine." }]);
  const parent = createRoom({ name: "Held", dir: repo, agents: [{ kind: "codex" }], env });
  // Driven elsewhere, as by an agent's `agoryx new --from here` in a terminal.
  const elsewhere = openEngine(parent, { env, runners: {} });
  const made = await call("POST", "/api/rooms", { name: "While held", from: parent.id, text: "HELD-BRIEF: look" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await waitFor(async () => (await snapshot(made.body.room.id)).runs.some((run: any) => run.status === "ended"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  parent.refresh();
  assert.ok(!parent.state.messages.some((m) => m.sys?.code === "thread.reported"), "not while the room is held");
  await elsewhere.close();
  await waitFor(async () => (await snapshot(parent.id)).messages.some((m: any) => m.sys?.code === "thread.reported"));
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const report = (await snapshot(parent.id)).messages.filter((m: any) => m.sys?.code === "thread.reported");
  assert.equal(report.length, 1, "posted once, not with every try");
  assert.equal(report[0].sys.room, made.body.room.id);
});

test("resolving a thread is the human's: it moves the thread on the board, posts nothing and wakes nobody", async () => {
  const repo = makeRepo("resolve-repo");
  rules([{ agent: "codex", match: "RESOLVE-BRIEF", reply: "Looked, all fine." }]);
  const parent = (await call("POST", "/api/rooms", { name: "Resolve main", dir: repo, mode: "work", agents: [{ kind: "codex" }] })).body.room;
  const thread = (await call("POST", "/api/rooms", { name: "Check it", from: parent.id, text: "RESOLVE-BRIEF: check it" })).body.room;
  await waitFor(async () => (await snapshot(parent.id)).messages.find((m: any) => m.sys?.code === "thread.reported"));
  await waitFor(async () => !(await snapshot(thread.id)).turns.some((turn: any) => turn.status === "running"));
  const before = await snapshot(thread.id);

  // An agent — the thread's own, or one of the room it came from — cannot.
  for (const [room, agent] of [[thread.id, "codex"], [parent.id, "codex"]]) {
    const res = await fetch(`${url}/api/rooms/${thread.id}/resolve`, {
      method: "POST",
      headers: { "x-agoryx-token": agentKey(daemon.token, room!, agent!), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
  }
  assert.equal((await call("POST", `/api/rooms/${parent.id}/resolve`, {})).status, 400, "only a thread is resolved");

  const resolved = await call("POST", `/api/rooms/${thread.id}/resolve`, {});
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.room.resolved.by, "Ivan");
  const after = await snapshot(thread.id);
  assert.deepEqual(after.resolved, resolved.body.room.resolved);
  assert.equal(after.messages.length, before.messages.length, "nothing posted");
  assert.equal(after.turns.length, before.turns.length, "nobody woken");
  const listed = (await call("GET", "/api/rooms")).body.rooms.find((room: any) => room.id === thread.id);
  assert.equal(listed.resolved.by, "Ivan");
  const overview = (await call("GET", `/api/projects/${listed.projectHash}/overview`)).body;
  assert.equal(overview.threads.find((entry: any) => entry.id === thread.id).resolved.by, "Ivan");

  // Twice is once; reopened, it is on the board as before.
  await call("POST", `/api/rooms/${thread.id}/resolve`, {});
  const reopened = await call("POST", `/api/rooms/${thread.id}/resolve`, { resolved: false });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.room.resolved, undefined);
  const events = readFileSync(join(env.AGORYX_HOME!, "rooms", thread.id, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type.startsWith("thread."));
  assert.deepEqual(events.map((event) => [event.type, event.by]), [["thread.resolved", "Ivan"], ["thread.reopened", "Ivan"]]);
});

test("a thread goes on from its parent's branch, in the parent's project folder", () => {
  const repo = makeRepo("branch-repo");
  const parent = createRoom({ name: "Feature", dir: repo, worktree: true, env });
  const thread = createRoom({ name: "Sub task", from: parent.state.id, env });
  assert.equal(thread.state.worktree?.source, repo);
  assert.equal(thread.state.worktree?.base, "agoryx/feature");
  assert.equal(thread.state.parent, parent.state.id);
  assert.equal(thread.state.mode, "work");
  // A thread is a Work room for its whole life, not only at its start.
  assert.throws(() => changeRoomMode(thread, { mode: "chat" }, env), /a thread is a Work room/);
  assert.equal(thread.state.mode, "work");
});

test("a thread keeps its spawner's choice not to be given the human's profile", () => {
  const repo = makeRepo("profile-repo");
  const parent = createRoom({ name: "Quiet", dir: repo, env });
  const agent = parent.state.agents[0]!;
  parent.append({ type: "agent.changed", agent: agent.id, profile: false, by: "Ivan" });
  const thread = createRoom({ name: "Sub", from: parent.state.id, createdBy: { room: parent.state.id, agent: agent.id }, env });
  assert.equal(thread.state.agents[0]?.profile, false);
});

test("a report names only its own run's items, not what came after the run ended", () => {
  const repo = makeRepo("bound-repo");
  const parent = createRoom({ name: "Bound", dir: repo, env });
  const thread = createRoom({ name: "Bounded", from: parent.state.id, env });
  const agent = thread.state.agents[0]!.id;
  const op = (raw: Record<string, unknown>, by: string) => thread.append({ type: "table.op", op: prepareTableOp(thread.state.table, raw, by, by === "Ivan") });
  thread.append({ type: "run.started", runId: "r1", trigger: null, budget: null });
  thread.append({ type: "turn.started", turnId: "t1", agent, runId: "r1", cursor: 0, resume: false, sessionId: null, promptChars: 0 });
  op({ op: "fact", text: "Parser handles empty input." }, agent);
  thread.append({ type: "run.ended", runId: "r1", reason: "quiet", turns: 1 });
  op({ op: "fact", text: "Added after the run." }, "Ivan");
  const report = threadReport(thread, "r1", parent.state, []);
  assert.ok(report);
  assert.deepEqual(report.sys.items.map((item) => item.text), ["Parser handles empty input."]);
});

test("the report's text says what the thread left and how to reach it", () => {
  const text = threadText({
    code: "thread.reported",
    room: "r1",
    name: "T",
    reason: "budget",
    agents: ["Codex"],
    branch: "agoryx/t",
    base: "main",
    files: [{ path: "a.png", status: "A", added: null, removed: null }],
    more: 2,
    uncommitted: 0,
    items: [],
    open: { id: "Q4", text: "Which format?" },
  });
  assert.match(text, /spent its turn limit/);
  assert.match(text, /3 files changed, all committed:\n  A a\.png binary\n  … and 2 more/);
  assert.match(text, /Still open there: Q4 Which format\?/);
  assert.match(text, /Nobody in it said anything this run\./);
  assert.match(text, /`agoryx tail -r r1` reads it; `agoryx say -r r1 "…"` steers it\./);
});

test("a report names a decision taken in the run: the decision is its own record, the option it chose is older", () => {
  const table = emptyTable();
  let seq = 0;
  const play = (by: string, op: Record<string, unknown>) => applyTableOp(table, prepareTableOp(table, op, by, by === "Ivan"), (seq += 1), { human: by === "Ivan" });
  play("claude", { op: "ask", text: "Which port?" });
  play("codex", { op: "propose", title: "7777", q: "Q1" });
  const before = seq;
  play("Ivan", { op: "decide", target: "P1", note: "easy to remember" });
  const gained = tableItems(table).filter((item) => item.seq > before);
  assert.deepEqual(gained.map(({ id, text }) => ({ id, text })), [{ id: "D1", text: 'Ivan chose P1 "7777" for Q1: easy to remember' }]);
});
