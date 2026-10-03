import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import {
  hasProjectData,
  listProjects,
  projectDir,
  projectHash,
  projectKey,
  projectKeyOfFolder,
  projectsDir,
  readProject,
  setProjectField,
} from "../../internal/agora/projects.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { changeRoomMode, createRoom } from "../../internal/agora/service.js";
import { RoomStore } from "../../internal/agora/store.js";
import { writeFakeBins } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-projects-"));
  return { home, env: { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_LIVE: "0" } };
};
const repo = (home: string) => {
  const dir = join(home, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
};

test("a Work room's project is its folder, a worktree's is the folder it came from, and Chat has none", () => {
  const { home, env } = scratch();
  try {
    const dir = repo(home);
    const plain = createRoom({ name: "Plain", dir, env });
    const tree = createRoom({ name: "Tree", dir, worktree: true, env });
    const chat = createRoom({ name: "Chat", env });
    assert.equal(projectKey(plain.state), dir);
    assert.notEqual(tree.state.workspace, dir);
    assert.equal(projectKey(tree.state), dir);
    assert.equal(projectKey(chat.state), null);
    assert.equal(plain.summary().projectHash, projectHash(dir));
    assert.equal(tree.summary().projectHash, projectHash(dir));
    assert.equal(chat.summary().projectHash, undefined);
    // Named by the worktree's own folder, it is still the source folder's project.
    const rooms = RoomStore.list(join(env.AGORYX_HOME, "rooms"));
    assert.equal(projectKeyOfFolder(tree.state.workspace, rooms), dir);
    assert.equal(projectKeyOfFolder(dir, rooms), dir);
    // A Work room switched to Chat leaves its project; back in Work, it is in it again.
    changeRoomMode(plain, { mode: "chat" }, env);
    assert.equal(projectKey(plain.state), null);
    changeRoomMode(plain, { mode: "work" }, env);
    assert.equal(projectKey(plain.state), dir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("nothing is written for a folder until someone writes; every write says who made it", () => {
  const { home, env } = scratch();
  try {
    const dir = repo(home);
    createRoom({ name: "Work", dir, env });
    assert.equal(existsSync(projectsDir(env)), false);
    assert.equal(hasProjectData(dir, env), false);
    assert.equal(readProject(dir, env).seq, 0);
    assert.deepEqual(listProjects(env), []);

    const origin = { room: "r1", roomName: "Work", agent: "codex", label: "Codex", kind: "codex" as const };
    setProjectField(dir, "goal", "Ship projects", { by: "codex", from: origin }, env);
    setProjectField(dir, "name", "Agoryx", { by: "Ivan" }, env);
    // The same text again changes nothing and appends nothing.
    const same = setProjectField(dir, "name", "  Agoryx ", { by: "Ivan" }, env);
    assert.equal(same.seq, 2);
    const project = readProject(dir, env);
    assert.equal(project.goal, "Ship projects");
    assert.equal(project.name, "Agoryx");
    assert.deepEqual(project.events.map((event) => [event.field, event.by, event.from?.room]), [["goal", "codex", "r1"], ["name", "Ivan", undefined]]);
    const json = JSON.parse(readFileSync(join(projectDir(dir, env), "project.json"), "utf8"));
    assert.equal(json.key, dir);
    assert.equal(json.goal, "Ship projects");
    assert.deepEqual(listProjects(env).map((entry) => entry.key), [dir]);

    // An empty text clears it, and that is recorded too.
    setProjectField(dir, "goal", "", { by: "Ivan" }, env);
    assert.equal(readProject(dir, env).goal, undefined);
    assert.equal(readProject(dir, env).events.at(-1)!.value, null);
    assert.throws(() => setProjectField(dir, "name", "two\nlines", { by: "Ivan" }, env), /one line/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the daemon serves projects: agents write with their key, a stale edit is refused, rooms carry the name", async () => {
  const { home, env } = scratch();
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
    const dir = repo(home);
    const room = (await call("POST", "/api/rooms", { name: "Work here", dir, mode: "work" })).body.room;
    await call("POST", "/api/rooms", { name: "Just chat" });
    const hash = projectHash(dir);
    assert.equal(room.projectHash, hash);

    const listed = (await call("GET", "/api/projects")).body.projects;
    assert.deepEqual(listed.map((project: any) => [project.hash, project.key, project.seq, project.rooms]), [[hash, dir, 0, [room.id]]]);
    assert.equal(existsSync(projectsDir(env)), false, "listing writes nothing");

    const key = agentKey(daemon.token, room.id, "codex");
    const written = await call("PATCH", `/api/projects/${hash}`, { goal: "Projects, the Agoryx way", seq: 0 }, key);
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.equal(written.body.project.goal, "Projects, the Agoryx way");
    assert.equal(written.body.project.events[0].by, "codex");
    assert.equal(written.body.project.events[0].from.room, room.id);
    assert.deepEqual(written.body.rooms.map((entry: any) => entry.id), [room.id]);

    const stale = await call("PATCH", `/api/projects/${hash}`, { goal: "Something else", seq: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.project.goal, "Projects, the Agoryx way");

    // Every field is checked before any is written: a refused name leaves the goal as it was.
    const half = await call("PATCH", `/api/projects/${hash}`, { goal: "Half written", name: "Two\nlines", seq: 1 });
    assert.equal(half.status, 400);
    assert.match(half.body.error, /one line/);
    assert.equal((await call("GET", `/api/projects/${hash}`)).body.project.goal, "Projects, the Agoryx way");

    assert.equal((await call("PATCH", `/api/projects/${hash}`, { name: "Agoryx", seq: 1 })).status, 200);
    const rooms = (await call("GET", "/api/rooms")).body.rooms;
    assert.equal(rooms.find((entry: any) => entry.id === room.id).projectName, "Agoryx");
    assert.equal(rooms.find((entry: any) => entry.id !== room.id).projectName, undefined);

    // A folder no room works in is reached by its path; an unknown hash is not a project.
    const other = join(home, "other");
    mkdirSync(other);
    assert.equal((await call("GET", `/api/projects/${projectHash(other)}`)).status, 404);
    const byKey = await call("PATCH", `/api/projects/${projectHash(other)}`, { key: other, instructions: "Be brief" });
    assert.equal(byKey.status, 200, JSON.stringify(byKey.body));
    assert.equal((await call("GET", `/api/projects/${projectHash(other)}`)).body.project.instructions, "Be brief");
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
