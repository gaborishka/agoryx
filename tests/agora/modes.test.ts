import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { agentKey } from "../../internal/agora/actor.js";
import { buildBriefing } from "../../internal/agora/prompts.js";
import { RoomStore } from "../../internal/agora/store.js";
import { changeRoomMode, createRoom } from "../../internal/agora/service.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { workspaceAt } from "../../internal/agora/room-mode.js";
import { recoverySnapshot } from "../../internal/agora/workspace.js";
import { createTestRoom, writeFakeBins, withTimeout } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const scratch = () => { const home = mkdtempSync(join(tmpdir(), "agoryx-modes-")); return { home, env: { ...process.env, AGORYX_HOME: home, AGORYX_LIVE: "0" } }; };

test("Chat needs no project, keeps native tools, and has no required steps or commit policy", () => {
  const { home, env } = scratch();
  try {
    const room = createRoom({ name: "A question", env });
    assert.equal(room.state.mode, "chat");
    assert.equal(room.summary().folder, undefined);
    assert.equal(room.state.workspace, join(room.dir, "materials"));
    assert.equal(existsSync(join(home, "workspaces")), false);
    assert.equal(existsSync(join(room.state.workspace, ".git")), false);
    assert.equal(room.state.settings.autoCommit, false);
    const brief = buildBriefing({ state: room.state, agent: room.state.agents[0]!, agentCli: { command: "agoryx" } });
    assert.match(brief, /Mode: Chat. No project is connected/);
    assert.doesNotMatch(brief, /Work goes in steps|author commits it|git add|git commit/);
    assert.equal(room.state.settings.access, "workspace");
    assert.throws(() => createRoom({ name: "bad", mode: "chat", dir: home, env }), /Chat uses conversation materials/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Chat → Work → Chat → Work preserves history, artifacts, settings and project edits across replay", () => {
  const { home, env } = scratch();
  try {
    const room = createRoom({ name: "Keep this conversation", env });
    const chatDir = room.state.workspace;
    writeFileSync(join(chatDir, "notes.txt"), "chat material");
    room.append({ type: "message.posted", message: { id: "m1", author: "Ivan", kind: "human", text: "Remember my idea", mentions: [], wakes: false } });
    room.append({ type: "table.op", op: { op: "ask", text: "Which approach?", by: "Ivan", id: "Q1" } });
    const table = JSON.stringify(room.state.table);
    const dir = join(home, "project"); mkdirSync(dir);
    writeFileSync(join(dir, "notes.txt"), "project changes");
    changeRoomMode(room, { mode: "work", dir }, env);
    assert.equal(room.id, room.state.id);
    assert.equal(room.state.workspace, dir);
    assert.equal(room.state.messages[0]!.text, "Remember my idea");
    assert.equal(workspaceAt(room.state, 2), chatDir);
    room.state.settings.doc = "notes.txt";
    changeRoomMode(room, { mode: "chat" }, env);
    assert.equal(room.state.workspace, chatDir);
    assert.equal(room.state.settings.doc, null);
    assert.equal(readFileSync(join(chatDir, "notes.txt"), "utf8"), "chat material");
    assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "project changes");
    changeRoomMode(room, { mode: "work" }, env);
    assert.equal(room.state.settings.doc, "notes.txt");
    assert.equal(room.state.workspace, dir);
    assert.deepEqual(room.state.sessions, {});
    assert.equal(JSON.stringify(room.state.table), table);
    const replay = RoomStore.open(join(home, "rooms"), room.id);
    assert.deepEqual(replay.state, room.state);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("old rooms remain Work; their old autocommit flag cannot create branch commits", async () => {
  const room = createTestRoom({ settings: { autoCommit: true }, rules: [{ once: true, write: [{ path: "answer.txt", content: "answer" }], reply: "Done" }] });
  try {
    assert.equal(room.store.state.mode, "work");
    room.engine.postHuman("@codex write it");
    await withTimeout(room.engine.waitIdle());
    assert.throws(() => git(room.store.state.workspace, "rev-parse", "--verify", "HEAD"));
    assert.equal(git(room.store.state.workspace, "diff", "--cached"), "");
    const snapshot = room.store.state.commits.at(-1)!;
    assert.ok(snapshot.internal);
    assert.equal(git(room.store.state.workspace, "show", `${snapshot.sha}:answer.txt`), "answer");
  } finally { await room.cleanup(); }
});

test("recovery snapshots preserve HEAD and partial staging and can be read in a non-git chat folder", () => {
  const { home, env } = scratch();
  try {
    const room = createRoom({ name: "Work", mode: "work", env });
    const ws = room.state.workspace;
    writeFileSync(join(ws, "a"), "base\n"); git(ws, "add", "a");
    git(ws, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const head = git(ws, "rev-parse", "HEAD");
    writeFileSync(join(ws, "a"), "staged\n"); git(ws, "add", "a");
    const staged = git(ws, "diff", "--cached");
    writeFileSync(join(ws, "a"), "unstaged\n");
    const sha = recoverySnapshot(ws, room.id, "Recovery")!;
    assert.equal(git(ws, "rev-parse", "HEAD"), head);
    assert.equal(git(ws, "diff", "--cached"), staged);
    assert.equal(git(ws, "show", `${sha}:a`), "unstaged");
    const chat = createRoom({ name: "Chat", env });
    writeFileSync(join(chat.state.workspace, "result"), "value");
    assert.ok(recoverySnapshot(chat.state.workspace, chat.id, "Recovery"));
    assert.equal(existsSync(join(chat.state.workspace, ".git")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("HTTP mode changes retain files and participants, reject busy/agent changes, and survive restart", async () => {
  const { home, env } = scratch();
  const bins = writeFakeBins(home);
  const rules = join(home, "rules.json");
  writeFileSync(rules, JSON.stringify([{ reply: "::pass::", sleepMs: 400 }]));
  const daemon = new AgoraDaemon({ env: { ...env, FAKE_LOG: join(home, "fake.log"), FAKE_RULES: rules, FAKE_STATE: join(home, "fake"), CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") }, runners: { claude: createClaudeRunner(bins.fakeClaude), codex: createCodexRunner(bins.fakeCodex) }, port: 0 });
  try {
    const info = await daemon.start();
    const call = async (path: string, body?: unknown, token = daemon.token) => {
      const res = await fetch(`${info.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "x-agoryx-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() as any };
    };
    const created = await call("/api/rooms", { name: "Modes" });
    assert.equal(created.status, 201);
    const id = created.body.room.id;
    const path = `/api/rooms/${id}`;
    const before = await call(path);
    const original = before.body.state.workspace;
    writeFileSync(join(original, "same.txt"), "chat");
    const project = join(home, "project"); mkdirSync(project);
    writeFileSync(join(project, "same.txt"), "work");
    assert.equal((await call(`${path}/mode`, { mode: "work", dir: project }, agentKey(daemon.token, id, "codex"))).status, 403);
    const switched = await call(`${path}/mode`, { mode: "work", dir: project });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.state.mode, "work");
    assert.deepEqual(switched.body.state.agents, before.body.state.agents);
    const historical = await fetch(`${info.url}${switched.body.rawBase}~at/1/same.txt`);
    assert.equal(await historical.text(), "chat");
    const raw = await fetch(`${info.url}${switched.body.rawBase}same.txt`);
    assert.equal(await raw.text(), "work");
    const traversal = await fetch(`${info.url}${switched.body.rawBase}~at/1/%2e%2e%2fevents.jsonl`);
    assert.equal(traversal.status, 404);
    assert.equal((await call(`${path}/messages`, { text: "@codex hello" })).status, 201);
    assert.equal((await call(`${path}/mode`, { mode: "chat" })).status, 409);
    const deadline = Date.now() + 15000;
    while ((await call(path)).body.state.runs.at(-1)?.status === "active") {
      if (Date.now() > deadline) throw Error("fake agents did not finish");
      await new Promise((r) => setTimeout(r, 30));
    }
    const back = await call(`${path}/mode`, { mode: "chat" });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.state.workspace, original);
    assert.equal(back.body.state.project.workspace, project);
    const saved = RoomStore.open(join(home, "rooms"), id);
    assert.equal(saved.state.mode, "chat");
    assert.ok(saved.state.messages.some((m) => m.text === "@codex hello"));
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("sessions with the retired briefing restart once with conversation history and no commit requirement", async () => {
  const room = createTestRoom({ rules: [{ reply: "::pass::" }] });
  try {
    room.engine.postHuman("@codex Remember the original request");
    await withTimeout(room.engine.waitIdle());
    room.store.append({ type: "session.bound", agent: "codex", sessionId: "old-session" });
    room.engine.postHuman("@codex continue");
    await withTimeout(room.engine.waitIdle());
    const prompt = room.invocations("codex").at(-1)!.prompt!;
    assert.match(prompt, /Remember the original request/);
    assert.doesNotMatch(prompt, /Once it is checked, its author commits it/);
    assert.equal(room.store.state.turns.at(-1)!.resume, false);
    room.engine.postHuman("@codex another question");
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.store.state.turns.at(-1)!.resume, true);
  } finally { await room.cleanup(); }
});

test("a room may connect an isolated worktree and resume the same branch after Chat", () => {
  const { home, env } = scratch();
  try {
    const project = join(home, "repo"); mkdirSync(project);
    git(project, "init", "-q");
    writeFileSync(join(project, "code.txt"), "base"); git(project, "add", "code.txt");
    git(project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const head = git(project, "rev-parse", "HEAD");
    const room = createRoom({ name: "Discuss first", env });
    changeRoomMode(room, { mode: "work", dir: project, worktree: true }, env);
    const workspace = room.state.workspace;
    const branch = room.state.worktree!.branch;
    assert.notEqual(workspace, project);
    writeFileSync(join(workspace, "code.txt"), "uncommitted work");
    changeRoomMode(room, { mode: "chat" }, env);
    assert.equal(room.state.project!.worktree!.branch, branch);
    changeRoomMode(room, { mode: "work" }, env);
    assert.equal(room.state.workspace, workspace);
    assert.equal(git(workspace, "branch", "--show-current"), branch);
    assert.equal(git(workspace, "rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(workspace, "code.txt"), "utf8"), "uncommitted work");
    assert.equal(readFileSync(join(project, "code.txt"), "utf8"), "base");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
