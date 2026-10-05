import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoomEngine } from "../../internal/agora/engine.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { RoomStore } from "../../internal/agora/store.js";
import { DEFAULT_SETTINGS, type RoomAgent } from "../../internal/agora/types.js";
import { markTurnLive, otherRoomTurns } from "../../internal/agora/workspace.js";
import { createTestRoom, trackRoom, withTimeout, writeFakeBins } from "./helpers.js";

/**
 * Two rooms in one workspace, driven in this process like the daemon drives them: room A has Claude,
 * room B has Codex, each with its own fake CLI rules. autoCommit on, so each run ends in a checkpoint.
 * Rules order their turns against the other room's by marks, as a sleep cannot under load: room A's rule makes
 * "a-started" once its turn has begun (mark), and "b-ended" is made when room B's turn is over.
 */
const twoRooms = (rules: { a: unknown[]; b: unknown[] }, docA?: string) => {
  const home = mkdtempSync(join(tmpdir(), "agora-cross-"));
  const roomsRoot = join(home, "rooms");
  const workspace = join(home, "ws");
  mkdirSync(workspace, { recursive: true });
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  const open = (name: string, agent: RoomAgent, roomRules: unknown[], doc?: string) => {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rules.json"), JSON.stringify(roomRules));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FAKE_LOG: join(dir, "fake.log"),
      FAKE_STATE: join(dir, "fake-state"),
      FAKE_RULES: join(dir, "rules.json"),
      CLAUDECODE: "1",
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
      CODEX_HOME: join(dir, "codex-home"),
      FAKE_MARKS: home,
    };
    const store = RoomStore.create(roomsRoot, {
      name,
      workspace,
      createdWorkspace: true,
      human: "Ivan",
      agents: [agent],
      settings: { ...DEFAULT_SETTINGS, network: false, autoCommit: true, ...(doc ? { doc } : {}) },
    });
    const engine = new RoomEngine({
      store,
      runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
      env,
      opsPollMs: 50,
      nativePollMs: 0,
    });
    untrack.push(trackRoom({ store, engine, logPath: env.FAKE_LOG! }));
    return engine;
  };
  const untrack: Array<() => void> = [];
  const a = open("Room A", { id: "claude", kind: "claude", label: "Claude" }, rules.a, docA);
  const b = open("Room B", { id: "codex", kind: "codex", label: "Codex" }, rules.b);
  b.store.subscribe((event) => {
    if (event.type === "turn.ended") writeFileSync(join(home, "b-ended"), "");
    if (event.type === "commit.created") writeFileSync(join(home, "b-snapshotted"), "");
  });
  return {
    workspace,
    a,
    b,
    async both(text: string) {
      a.postHuman(text);
      b.postHuman(text);
      await withTimeout(Promise.all([a.waitIdle(), b.waitIdle()]));
    },
    async cleanup() {
      for (const forget of untrack) forget();
      await a.close();
      await b.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
};

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;
const turnOf = (engine: RoomEngine) => engine.store.state.turns.find((turn) => turn.agent !== undefined)!;
const committedFiles = (workspace: string, sha: string) => git(workspace, ["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean).sort();
const commitOf = (engine: RoomEngine) => engine.store.events.find((event) => event.type === "commit.created");

test("a file another room's agent edits during this room's turn is not this room's", async () => {
  const rooms = twoRooms({
    // Wait for B's recovery snapshot too, so the two snapshots have deterministic contents.
    a: [{ agent: "claude", match: "go", mark: "a-started", waitForMark: "b-snapshotted", write: { path: "a.txt", content: "from room A\n" }, reply: "Wrote a.", once: true }],
    // Codex (room B) writes its file while Claude's turn in room A is running.
    b: [{ agent: "codex", match: "go", waitForMark: "a-started", write: { path: "b.txt", content: "from room B\n" }, reply: "Wrote b.", once: true }],
  });
  try {
    await rooms.both("go");
    const a = turnOf(rooms.a);
    const b = turnOf(rooms.b);
    assert.deepEqual(a.files, ["a.txt"], "room B's file is not put on room A's agent");
    assert.deepEqual(a.changes?.map((change) => change.path), ["a.txt"]);
    assert.doesNotMatch(rooms.a.turnPatch(a.id)!.patch, /b\.txt/, "nor in room A's patch");
    assert.deepEqual(b.files, ["b.txt"]);

    // Recovery snapshots capture the whole folder at their respective times.
    const commitA = commitOf(rooms.a);
    const commitB = commitOf(rooms.b);
    assert.ok(commitA?.type === "commit.created" && commitB?.type === "commit.created");
    assert.deepEqual(committedFiles(rooms.workspace, commitA.sha), ["a.txt", "b.txt"], "recovery preserves the whole folder, without crediting foreign changes to the turn");
    assert.deepEqual(committedFiles(rooms.workspace, commitB.sha), ["b.txt"]);
  } finally {
    await rooms.cleanup();
  }
});

test("a shell change made while another room's turn runs is credited to nobody, and not committed", async () => {
  const rooms = twoRooms({
    a: [{ agent: "claude", match: "go", mark: "a-started", waitForMark: "b-ended", reply: "Only thinking.", once: true }],
    b: [{ agent: "codex", match: "go", waitForMark: "a-started", write: { path: "b.txt", content: "via sed\n", via: "shell" }, reply: "Ran a script.", once: true }],
  });
  try {
    await rooms.both("go");
    assert.equal(turnOf(rooms.a).files, undefined, "Claude in room A did not write b.txt");
    assert.equal(turnOf(rooms.b).files, undefined, "which room's agent ran the script is not known: nobody's");
    assert.equal(commitOf(rooms.a), undefined);
    assert.equal(commitOf(rooms.b), undefined);
    assert.match(git(rooms.workspace, ["status", "--porcelain"]), /\?\? b\.txt/, "the file stays in the working tree for the human");
  } finally {
    await rooms.cleanup();
  }
});

test("a change made after the other room's turn ended is this turn's, whatever tool made it", async () => {
  const rooms = twoRooms({
    // The turns overlap (B waits for A's to begin), and A's change comes after B's turn ended.
    a: [{ agent: "claude", match: "go", mark: "a-started", waitForMark: "b-ended", write: { path: "a.txt", content: "late script\n", via: "shell" }, reply: "Ran it.", once: true }],
    b: [{ agent: "codex", match: "go", waitForMark: "a-started", write: { path: "b.txt", content: "from room B\n" }, reply: "Wrote b.", once: true }],
  });
  try {
    await rooms.both("go");
    assert.deepEqual(turnOf(rooms.a).files, ["a.txt"], "room B's turn was over when a.txt changed");
    assert.deepEqual(turnOf(rooms.b).files, ["b.txt"]);
  } finally {
    await rooms.cleanup();
  }
});

test("a room in another process running a turn here counts as a parallel turn", async () => {
  const rooms = twoRooms({
    a: [{ agent: "claude", match: "go", sleepMs: 300, write: [{ path: "a.txt", content: "edited\n" }, { path: "c.txt", content: "scripted\n", via: "shell" }], reply: "Done.", once: true }],
    b: [],
  });
  try {
    // The marker a room in another daemon leaves while its turn runs (its pid is alive: this one's parent).
    markTurnLive(rooms.workspace, { room: "elsewhere", turn: "t4", pid: process.ppid, startedAt: Date.now() });
    rooms.a.postHuman("go");
    await withTimeout(rooms.a.waitIdle());
    assert.deepEqual(turnOf(rooms.a).files, ["a.txt"], "the shell change could be the other process's agent: not credited");
    const commit = commitOf(rooms.a);
    assert.ok(commit?.type === "commit.created");
    assert.deepEqual(committedFiles(rooms.workspace, commit.sha), ["a.txt", "c.txt"]);
  } finally {
    await rooms.cleanup();
  }
});

test("one room alone in the workspace credits and commits a shell change as before", async () => {
  const rooms = twoRooms({
    a: [{ agent: "claude", match: "go", write: { path: "a.txt", content: "scripted\n", via: "shell" }, reply: "Done.", once: true }],
    b: [],
  });
  try {
    rooms.a.postHuman("go");
    await withTimeout(rooms.a.waitIdle());
    assert.deepEqual(turnOf(rooms.a).files, ["a.txt"]);
    const commit = commitOf(rooms.a);
    assert.ok(commit?.type === "commit.created");
    assert.deepEqual(committedFiles(rooms.workspace, commit.sha), ["a.txt"]);
  } finally {
    await rooms.cleanup();
  }
});

test("recovery snapshots preserve all files in both private and shared directories without committing them", async () => {
  const alone = createTestRoom({
    rules: [{ agent: "claude", match: "go", write: { path: "a.txt", content: "agent\n" }, reply: "Done.", once: true }],
    agents: [{ id: "claude", kind: "claude", label: "Claude" }],
    settings: { autoCommit: true },
  });
  try {
    // The human's own edit, credited to no turn: a room alone has always swept it into its checkpoint.
    writeFileSync(join(alone.store.state.workspace, "notes.txt"), "mine\n");
    alone.engine.postHuman("go");
    await withTimeout(alone.engine.waitIdle());
    const commit = commitOf(alone.engine);
    assert.ok(commit?.type === "commit.created");
    assert.deepEqual(committedFiles(alone.store.state.workspace, commit.sha), ["a.txt", "notes.txt"]);
  } finally {
    await alone.cleanup();
  }

  const rooms = twoRooms({ a: [{ agent: "claude", match: "go", write: { path: "a.txt", content: "agent\n" }, reply: "Done.", once: true }], b: [] });
  try {
    writeFileSync(join(rooms.workspace, "notes.txt"), "mine\n");
    rooms.a.postHuman("go");
    await withTimeout(rooms.a.waitIdle());
    const commit = commitOf(rooms.a);
    assert.ok(commit?.type === "commit.created");
    // Room B may own it: a room sharing the directory leaves what it was not credited with alone.
    assert.deepEqual(committedFiles(rooms.workspace, commit.sha), ["a.txt", "notes.txt"]);
    assert.match(git(rooms.workspace, ["status", "--porcelain"]), /notes\.txt/);
  } finally {
    await rooms.cleanup();
  }
});

test("a canonical-file change another room's agent made between this room's turns is not put on the human", async () => {
  const rooms = twoRooms(
    { a: [], b: [{ agent: "codex", match: "go", write: { path: "README.md", content: "# From room B\n" }, reply: "Wrote it.", once: true }] },
    "README.md",
  );
  try {
    rooms.b.postHuman("go");
    await withTimeout(rooms.b.waitIdle());
    // Room A was idle the whole time; its between-turns sync now finds the file changed.
    (rooms.a as unknown as { syncDoc(): void }).syncDoc();
    const revision = rooms.a.store.state.docRevisions.at(-1)!;
    assert.deepEqual(revision.among, ["Ivan", 'room "Room B"']);
    assert.notEqual(revision.by, "Ivan", "not the human's alone");
  } finally {
    await rooms.cleanup();
  }
});

test("a turn left running by a dead process ends when first seen dead, and still overlaps the turns that saw it", async () => {
  const rooms = twoRooms({
    a: [{ agent: "claude", match: "go", sleepMs: 300, write: { path: "c.txt", content: "scripted\n", via: "shell" }, reply: "Done.", once: true }],
    b: [],
  });
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    markTurnLive(rooms.workspace, { room: "elsewhere", turn: "t9", pid: dead, startedAt: Date.now() - 60_000 });
    rooms.a.postHuman("go");
    await withTimeout(rooms.a.waitIdle());
    assert.equal(turnOf(rooms.a).files, undefined, "when that process's agent stopped writing is not known");
    const [marker] = otherRoomTurns(rooms.workspace, "Room A", 0);
    assert.ok(marker?.endedAt !== undefined && marker.endedAt >= Date.parse(turnOf(rooms.a).startedAt), "its end is fixed when seen, not its start");
  } finally {
    await rooms.cleanup();
  }
});
