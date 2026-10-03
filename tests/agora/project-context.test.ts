import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import {
  addProjectContext,
  contextFolders,
  projectBriefing,
  projectHash,
  projectUpdate,
  readProject,
  removeProjectContext,
  setProjectField,
} from "../../internal/agora/projects.js";
import { buildClaudeArgs, createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { buildCodexArgs, buildCodexThreadParams, createCodexRunner } from "../../internal/agora/runners/codex.js";
import type { TurnRequest } from "../../internal/agora/runners/types.js";
import { DEFAULT_SETTINGS } from "../../internal/agora/types.js";
import { createTestRoom, withTimeout, writeFakeBins } from "./helpers.js";

const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-context-"));
  const env = { ...process.env, HOME: home, AGORYX_HOME: join(home, "agora"), AGORYX_LIVE: "0" };
  const key = join(home, "app");
  const lib = join(home, "lib");
  mkdirSync(join(key, "src"), { recursive: true });
  mkdirSync(lib);
  return { home, env, key, lib };
};

test("a context folder is a write with who made it; inside, above or missing is refused, twice is once", () => {
  const { home, env, key, lib } = scratch();
  try {
    const added = addProjectContext(key, `${lib}/`, { by: "Ivan" }, env);
    assert.deepEqual(added.context, [lib]);
    assert.equal(added.events.at(-1)!.by, "Ivan");
    assert.equal(addProjectContext(key, "~/lib", { by: "codex" }, env).seq, added.seq, "the same folder again writes nothing");
    assert.throws(() => addProjectContext(key, join(key, "src"), { by: "Ivan" }, env), /inside the project's own folder/);
    assert.throws(() => addProjectContext(key, home, { by: "Ivan" }, env), /holds the project's own folder/);
    assert.throws(() => addProjectContext(key, "/", { by: "Ivan" }, env), /holds the project's own folder/, "the filesystem root holds every project");
    assert.throws(() => addProjectContext(key, join(home, "nope"), { by: "Ivan" }, env), /no folder at/);
    assert.throws(() => addProjectContext(key, "lib", { by: "Ivan" }, env), /absolute path/);

    rmSync(lib, { recursive: true });
    assert.deepEqual(readProject(key, env).context, [lib], "a folder gone stays written");
    assert.deepEqual(contextFolders(readProject(key, env)), [], "but its agents are not given it");
    mkdirSync(lib);

    const removed = removeProjectContext(key, "~/lib", { by: "claude", from: { room: "r1", roomName: "R", agent: "claude", label: "Claude", kind: "claude" } }, env);
    assert.deepEqual(removed.context, []);
    assert.equal(removed.events.at(-1)!.by, "claude");
    assert.throws(() => removeProjectContext(key, lib, { by: "Ivan" }, env), /not a context folder/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the briefing names the context folders, and a running session hears who added or removed one", () => {
  const { home, env, key, lib } = scratch();
  try {
    setProjectField(key, "goal", "G", { by: "Ivan" }, env);
    const seen = readProject(key, env).seq;
    addProjectContext(key, lib, { by: "Ivan" }, env);
    const project = readProject(key, env);
    assert.match(projectBriefing(project, "agoryx", env), new RegExp(`Context folders — you can read and write them as you do this folder:\\n {4}${lib}`));
    assert.match(projectUpdate(project, seen, { room: "r", agent: "claude" })!, new RegExp(`Ivan added the context folder ${lib} — you can read and write it from this turn on`));
    removeProjectContext(key, lib, { by: "Ivan" }, env);
    const after = readProject(key, env);
    assert.doesNotMatch(projectBriefing(after, "agoryx", env), /Context folders/);
    assert.match(projectUpdate(after, project.seq, { room: "r", agent: "claude" })!, new RegExp(`Ivan removed the context folder ${lib}\\.`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const request = (patch: Partial<TurnRequest> = {}, settings: Partial<typeof DEFAULT_SETTINGS> = {}): TurnRequest => ({
  prompt: "x",
  cwd: "/tmp/w",
  sessionId: "s1",
  roomName: "r",
  settings: { ...DEFAULT_SETTINGS, network: false, ...settings },
  env: { A: "1" },
  signal: new AbortController().signal,
  ...patch,
});

test("Claude gets the folders as --add-dir, Codex as writable roots, and a live process is started again when they change", () => {
  const addDirs = ["/tmp/lib", "/tmp/docs"];
  const claude = buildClaudeArgs(request({ addDirs }), "s1", false);
  const at = claude.indexOf("--add-dir");
  assert.deepEqual(claude.slice(at + 1, at + 3), addDirs);
  assert.ok(claude[at + 3]!.startsWith("--"), "a flag ends the folders' list");
  assert.equal(buildClaudeArgs(request(), "s1", false).includes("--add-dir"), false);

  const codex = buildCodexArgs(request({ addDirs }));
  assert.ok(codex.includes('sandbox_workspace_write.writable_roots=["/tmp/lib","/tmp/docs"]'));
  assert.equal(buildCodexArgs(request()).some((arg) => arg.includes("writable_roots")), false);
  const params = buildCodexThreadParams(request({ addDirs }, { network: true })) as { config: { sandbox_workspace_write: unknown } };
  assert.deepEqual(params.config.sandbox_workspace_write, { writable_roots: addDirs, network_access: true });

  for (const runner of [createClaudeRunner("claude"), createCodexRunner("codex")]) {
    const base = runner.liveFingerprint!(request());
    assert.notEqual(runner.liveFingerprint!(request({ addDirs })), base);
    assert.notEqual(runner.liveFingerprint!(request({ addDirs: ["/tmp/lib"] })), runner.liveFingerprint!(request({ addDirs })));
  }
});

test("a Work room's agents are given the project's context folders on their next turn", async () => {
  const room = createTestRoom({ agoraHome: true, rules: [{ reply: "::pass::" }] });
  const lib = join(room.home, "lib");
  mkdirSync(lib);
  try {
    room.engine.postHuman("Start");
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.invocations("claude")[0]!.args!.includes("--add-dir"), false);
    addProjectContext(room.store.state.workspace, lib, { by: "Ivan" }, room.env);
    room.engine.postHuman("Again");
    await withTimeout(room.engine.waitIdle());
    const claude = room.invocations("claude")[1]!;
    assert.equal(claude.args![claude.args!.indexOf("--add-dir") + 1], lib);
    assert.ok(room.invocations("codex")[1]!.args!.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([lib])}`));
    assert.match(claude.prompt!, /Ivan added the context folder/);
  } finally {
    await room.cleanup();
  }
});

test("the daemon adds and removes context folders, by whoever asks", async () => {
  const { home, env, key, lib } = scratch();
  const bins = writeFakeBins(home);
  const daemon = new AgoraDaemon({
    env: { ...env, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") },
    runners: { claude: createClaudeRunner(bins.fakeClaude), codex: createCodexRunner(bins.fakeCodex) },
    port: 0,
  });
  try {
    const info = await daemon.start();
    const call = async (method: string, path: string, body?: unknown, token = daemon.token) => {
      const res = await fetch(`${info.url}${path}`, {
        method,
        headers: { "x-agoryx-token": token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const room = (await call("POST", "/api/rooms", { name: "Work here", dir: key, mode: "work" })).body.room;
    const hash = projectHash(key);
    const added = await call("POST", `/api/projects/${hash}/context`, { path: lib }, agentKey(daemon.token, room.id, "codex"));
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(added.body.project.context, [lib]);
    assert.equal(added.body.project.events.at(-1).by, "codex");
    assert.equal((await call("POST", `/api/projects/${hash}/context`, { path: key })).status, 400);
    const removed = await call("DELETE", `/api/projects/${hash}/context?path=${encodeURIComponent(lib)}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.project.context, []);
    assert.equal(removed.body.project.events.at(-1).by, "Ivan");
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
