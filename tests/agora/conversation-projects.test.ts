import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { agentKey } from "../../internal/agora/actor.js";
import {
  projectHash,
  projectKey,
  setProjectField,
} from "../../internal/agora/projects.js";
import { buildBriefing } from "../../internal/agora/prompts.js";
import { createRoom, changeRoomMode } from "../../internal/agora/service.js";
import { RoomStore } from "../../internal/agora/store.js";
import { layoutRooms } from "../../ui/src/lib/sidebar.js";

test("one project contains Chat, Work and private modes; membership survives replay and mode switches without moving files", () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-membership-")),
    key = join(home, "project"),
    env = { ...process.env, AGORYX_HOME: join(home, "state") };
  mkdirSync(key);
  try {
    const alias = join(home, "project-link");
    symlinkSync(key, alias);
    const linked = createRoom({ name: "Linked project", mode: "chat", projectKey: alias, env });
    assert.equal(projectKey(linked.state), alias);
    const chat = createRoom({
      name: "Discuss",
      mode: "chat",
      projectKey: key,
      env,
    });
    const work = createRoom({
      name: "Build",
      mode: "work",
      dir: key,
      projectKey: key,
      env,
    });
    const outside = createRoom({
      name: "Standalone work",
      mode: "work",
      projectKey: null,
      env,
    });
    assert.notEqual(chat.state.workspace, key);
    assert.equal(chat.summary().projectHash, work.summary().projectHash);
    assert.equal(chat.summary().folder, undefined);
    assert.equal(outside.summary().projectHash, undefined);
    writeFileSync(
      join(chat.state.workspace, "draft.txt"),
      "conversation artifact",
    );
    writeFileSync(join(key, "source.txt"), "project artifact");
    changeRoomMode(chat, { mode: "work", dir: key }, env);
    changeRoomMode(chat, { mode: "chat" }, env);
    assert.equal(projectKey(chat.state), key);
    assert.equal(
      readFileSync(join(chat.state.workspace, "draft.txt"), "utf8"),
      "conversation artifact",
    );
    assert.equal(
      readFileSync(join(key, "source.txt"), "utf8"),
      "project artifact",
    );
    changeRoomMode(outside, { mode: "chat" }, env);
    changeRoomMode(outside, { mode: "work" }, env);
    assert.equal(projectKey(outside.state), null);
    assert.deepEqual(
      RoomStore.open(join(env.AGORYX_HOME, "rooms"), chat.id).state,
      chat.state,
    );
    const grouped = layoutRooms(
      [
        chat.summary(),
        {
          ...work.summary(),
          workflow: {
            id: "run",
            mode: "debate",
            phase: "verdict",
            status: "completed",
            updatedAt: work.summary().updatedAt,
          },
        },
        outside.summary(),
      ],
      null,
      false,
    );
    assert.deepEqual(
      grouped.groups
        .find((g) => g.project === projectHash(key))!
        .rooms.map((r) => r.id),
      [chat.id, work.id],
    );
    const brief = buildBriefing({
      state: chat.state,
      agent: chat.state.agents[0]!,
      agentCli: { command: "agoryx" },
      project: "Shared project instructions",
    });
    assert.match(brief, /Shared project instructions/);
    assert.match(brief, /Switch to Work before editing/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("human project reassignment is durable, leaves execution untouched, and is blocked during private work", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-membership-api-")),
    a = join(home, "a"),
    b = join(home, "b");
  mkdirSync(a);
  mkdirSync(b);
  const env = {
    ...process.env,
    AGORYX_HOME: join(home, "state"),
    AGORYX_JEV: "off",
    AGORYX_LIVE: "0",
  };
  setProjectField(a, "name", "First project", { by: "Test" }, env);
  const daemon = new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    watchDays: 0,
    runners: {},
    workflowCapability: async () => ({ available: true, backend: "test" }),
    workflowExecutor: async (input) => {
      await new Promise<void>((resolve) =>
        input.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { text: "stopped" };
    },
  });
  try {
    await daemon.start();
    const call = async (path: string, body?: unknown, token = daemon.token) => {
      const res = await fetch(daemon.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-agoryx-token": token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const created = await call("/api/rooms", {
      name: "Project conversation",
      mode: "chat",
      projectKey: a,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.room.id,
      path = `/api/rooms/${id}`,
      workspace = created.body.room.workspace;
    const projects = await call("/api/projects");
    assert.ok(
      projects.body.projects.find((p: any) => p.key === a).rooms.includes(id),
    );
    assert.equal(
      (
        await call(
          `${path}/project`,
          { projectKey: b },
          agentKey(daemon.token, id, "codex"),
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(`${path}/project`, { projectKey: 9 })).status,
      400,
    );
    assert.equal((await call(`${path}/project`, null)).status, 400);
    assert.equal((await call(`${path}/project`, { projectKey: join(home, "missing") })).status, 400);
    const changed = await call(`${path}/project`, { projectKey: b });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.state.workspace, workspace);
    assert.equal(changed.body.state.mode, "chat");
    assert.equal(changed.body.state.projectKey, b);
    assert.deepEqual(changed.body.state.sessions, {});
    assert.equal(
      RoomStore.open(join(env.AGORYX_HOME, "rooms"), id).state.projectKey,
      b,
    );
    assert.ok(
      (await call("/api/projects")).body.projects
        .find((p: any) => p.key === b)
        .rooms.includes(id),
    );
    const start = await call(`${path}/workflow/start`, {
      mode: "council",
      task: "Choose",
      criteria: ["Clear"],
      participantIds: ["claude", "codex"],
    });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    assert.equal(
      (await call(`${path}/project`, { projectKey: null })).status,
      409,
    );
    await call(`${path}/workflow/stop`, { runId: start.body.workflow.id });
    assert.equal(
      (await call(`${path}/project`, { projectKey: null })).status,
      200,
    );
    assert.equal(
      (await call("/api/rooms")).body.rooms.find((r: any) => r.id === id)
        .projectHash,
      undefined,
    );
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a child thread inherits logical membership but branches from the actual working repository", () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-thread-membership-")),
    repository = join(home, "code"),
    project = join(home, "project");
  mkdirSync(repository);
  mkdirSync(project);
  const env = { ...process.env, AGORYX_HOME: join(home, "state") };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  try {
    git("init", "-q");
    writeFileSync(join(repository, "code.txt"), "correct source");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base",
    );
    for (const membership of [project, null]) {
      const parent = createRoom({
        name: "Parent",
        mode: "work",
        dir: repository,
        projectKey: membership,
        env,
      });
      const child = createRoom({ name: "Child", from: parent.id, env });
      assert.equal(child.state.worktree?.source, repository);
      assert.equal(projectKey(child.state), membership);
      assert.equal(
        readFileSync(join(child.state.workspace, "code.txt"), "utf8"),
        "correct source",
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test("project reassignment cannot masquerade as fresh native conversation activity", () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-activity-"));
  try {
    const store = createRoom({ name: "Remember last mode", mode: "chat", projectKey: null, env: { ...process.env, AGORYX_HOME: home } });
    const before = store.summary().nativeActivityAt;
    store.append({ type: "room.project.changed", projectKey: home, by: "Test" });
    assert.equal(store.summary().nativeActivityAt, before);
    store.append({ type: "message.posted", message: { id: "m1", author: "Test", kind: "human", text: "Back to conversation", mentions: [], wakes: false } });
    assert.equal(store.summary().nativeActivityAt, store.state.messages.at(-1)!.ts);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
