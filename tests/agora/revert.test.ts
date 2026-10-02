import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planRevert, RevertError, undoableRevert } from "../../internal/agora/revert.js";
import { RoomEngine } from "../../internal/agora/engine.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { RoomStore } from "../../internal/agora/store.js";
import { DEFAULT_SETTINGS, type RoomAgent } from "../../internal/agora/types.js";
import {
  checkpointCommit,
  checkpointFolder,
  checkpointRef,
  markRevert,
  prepareWorkspace,
  restoreWorkspace,
  revertPreview,
  revertRef,
  snapshotTree,
} from "../../internal/agora/workspace.js";
import { createTestRoom, withTimeout, writeFakeBins } from "./helpers.js";

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const commitAll = (root: string, message: string) => {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD").trim();
};
const read = (root: string, path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null);

test("restoreWorkspace returns the files, keeps the folder as it was under a ref, and leaves HEAD, the index and ignored files", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-revert-"));
  try {
    prepareWorkspace(root, { initGit: true });
    writeFileSync(join(root, ".gitignore"), "*.log\n");
    writeFileSync(join(root, "a.txt"), "v1\n");
    writeFileSync(join(root, "gone.txt"), "was here\n");
    const first = commitAll(root, "first");
    writeFileSync(join(root, "a.txt"), "v2\n");
    rmSync(join(root, "gone.txt"));
    mkdirSync(join(root, "new"));
    writeFileSync(join(root, "new", "b.txt"), "new\n");
    const second = commitAll(root, "second");
    writeFileSync(join(root, "untracked.txt"), "not committed\n");
    writeFileSync(join(root, "debug.log"), "ignored\n");
    writeFileSync(join(root, "a.txt"), "v3 unstaged\n");
    git(root, "add", "a.txt");
    const staged = git(root, "diff", "--cached");

    const preview = revertPreview(root, first);
    assert.ok(!("error" in preview));
    assert.deepEqual(
      preview.changes.map((change) => `${change.status} ${change.path}`).sort(),
      ["A gone.txt", "D new/b.txt", "D untracked.txt", "M a.txt"],
    );
    assert.deepEqual(restoreWorkspace(root, first, "refs/agoryx/revert/x/1", "m", "0".repeat(40)), { error: "changed" });
    assert.equal(read(root, "untracked.txt"), "not committed\n", "a stale preview changes nothing");

    const ref = revertRef("room-1", 1);
    const result = restoreWorkspace(root, first, ref, "before", preview.tree);
    assert.ok(!("error" in result));
    assert.deepEqual(result.left, []);
    assert.equal(read(root, "a.txt"), "v1\n");
    assert.equal(read(root, "gone.txt"), "was here\n");
    assert.equal(read(root, "new/b.txt"), null);
    assert.equal(existsSync(join(root, "new")), false, "an emptied folder goes with its files");
    assert.equal(read(root, "untracked.txt"), null);
    assert.equal(read(root, "debug.log"), "ignored\n", "ignored files are never part of a return");
    assert.ok(existsSync(join(root, ".agoryx")));
    assert.equal(git(root, "rev-parse", "HEAD").trim(), second, "HEAD stays");
    assert.equal(git(root, "diff", "--cached"), staged, "the index stays");
    assert.equal(git(root, "rev-parse", ref).trim(), result.undo);
    assert.equal(git(root, "show", `${result.undo}:untracked.txt`), "not committed\n", "the undo point holds untracked files too");

    // Undo: the same return, to the undo point.
    const back = restoreWorkspace(root, result.undo, revertRef("room-1", 2), "before undo");
    assert.ok(!("error" in back));
    assert.equal(read(root, "a.txt"), "v3 unstaged\n");
    assert.equal(read(root, "new/b.txt"), "new\n");
    assert.equal(read(root, "untracked.txt"), "not committed\n");
    assert.equal(read(root, "gone.txt"), null);
    assert.deepEqual(restoreWorkspace(root, result.undo, revertRef("room-1", 3), "again"), { error: "same" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a room in a subdirectory, or in a worktree, returns only its own folder", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-revert-"));
  try {
    prepareWorkspace(root, { initGit: true });
    const sub = join(root, "sub");
    mkdirSync(sub);
    writeFileSync(join(root, "outside.txt"), "one\n");
    writeFileSync(join(sub, "in.txt"), "one\n");
    const first = commitAll(root, "first");
    writeFileSync(join(root, "outside.txt"), "two\n");
    writeFileSync(join(sub, "in.txt"), "two\n");
    writeFileSync(join(root, "outside-new.txt"), "new\n");
    const result = restoreWorkspace(sub, first, revertRef("r", 1), "before");
    assert.ok(!("error" in result));
    assert.deepEqual(result.changes.map((change) => change.path), ["in.txt"]);
    assert.equal(read(sub, "in.txt"), "one\n");
    assert.equal(read(root, "outside.txt"), "two\n");
    assert.equal(read(root, "outside-new.txt"), "new\n");

    const tree = join(root, "..", `${root.split("/").at(-1)}-wt`);
    git(root, "worktree", "add", "-q", "-b", "room", tree, first);
    try {
      writeFileSync(join(tree, "sub", "in.txt"), "worktree\n");
      writeFileSync(join(tree, "extra.txt"), "x\n");
      const inTree = restoreWorkspace(tree, first, revertRef("r", 2), "before");
      assert.ok(!("error" in inTree));
      assert.equal(read(tree, "sub/in.txt"), "one\n");
      assert.equal(read(tree, "extra.txt"), null);
      assert.equal(read(sub, "in.txt"), "one\n", "the main checkout is not touched");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the human returns the room's folder to a checkpoint and undoes it; agents read it next turn; refused while a turn runs", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "alpha", write: [{ path: "a.txt", content: "v1\n" }, { path: "notes.md", content: "n1\n" }], reply: "Wrote v1.", once: true },
      { agent: "claude", match: "beta", write: [{ path: "a.txt", content: "v2\n" }, { path: "b.txt", content: "new\n" }, { path: "notes.md", content: "n2\n" }], reply: "Wrote v2.", once: true },
      { agent: "claude", match: "gamma", sleepMs: 5_000, reply: "Slow.", once: true },
      { agent: "claude", match: "look", reply: "Seen.", once: true },
    ],
    agents: [{ id: "claude", kind: "claude", label: "Claude" }],
    settings: { autoCommit: true, doc: "notes.md" },
  });
  const ws = room.store.state.workspace;
  try {
    room.engine.postHuman("alpha");
    await withTimeout(room.engine.waitIdle());
    room.engine.postHuman("beta");
    await withTimeout(room.engine.waitIdle());
    const [first, second] = room.store.state.commits;
    assert.ok(first && second, "two checkpoints");
    writeFileSync(join(ws, "scratch.txt"), "the human's untracked notes\n");
    const messages = room.store.state.messages.length;
    const table = JSON.stringify(room.store.state.table);

    // An agent never returns the folder.
    assert.throws(() => room.engine.revertWorkspace({ sha: first.sha }, "claude"), (error: unknown) => error instanceof RevertError && error.code === "agent");
    assert.throws(() => planRevert(room.store.state, { sha: "deadbeef" }), (error: unknown) => error instanceof RevertError && error.code === "missing");

    const plan = planRevert(room.store.state, { sha: first.sha.slice(0, 8) });
    assert.deepEqual(plan.changes.map((change) => `${change.status} ${change.path}`).sort(), ["D b.txt", "D scratch.txt", "M a.txt", "M notes.md"]);
    const revert = room.engine.revertWorkspace({ sha: first.sha.slice(0, 8), tree: plan.tree });
    assert.equal(read(ws, "a.txt"), "v1\n");
    assert.equal(read(ws, "b.txt"), null);
    assert.equal(read(ws, "scratch.txt"), null);
    assert.equal(read(ws, "notes.md"), "n1\n");
    assert.equal(revert.total, 4);
    assert.equal(revert.by, "Ivan");
    assert.equal(git(ws, "rev-parse", revert.ref).trim(), revert.undo, "the undo point is a commit under refs/agoryx/");
    assert.match(revert.ref, /^refs\/agoryx\/revert\//);
    assert.throws(() => git(ws, "rev-parse", "--verify", "HEAD"), "recovery never creates a branch commit");
    assert.equal(room.store.state.messages.length, messages, "history is not touched");
    assert.equal(JSON.stringify(room.store.state.table), table, "the table stays: it is what was said");
    assert.deepEqual(room.store.events.slice(-3).map((entry) => entry.type), ["workspace.reverted", "doc.revised", "commit.created"]);
    const revision = room.store.events.at(-2)!;
    assert.ok(revision.type === "doc.revised" && revision.by === "Ivan" && revision.text === "n1\n", "the canonical file moved with the folder, by the human");
    // With checkpoints on, the return is a checkpoint of its own: the next run's is not credited with it.
    const own = room.store.state.commits.at(-1)!;
    assert.match(own.subject, new RegExp(`Ivan returned the folder to ${first.sha.slice(0, 8)}$`));
    assert.equal(git(ws, "show", `${own.sha}:a.txt`).trim(), "v1");

    // The agent is told in its next turn, before it builds on files it remembers otherwise.
    room.engine.postHuman("look again");
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.store.state.commits.length, 3, "a run that changed nothing makes no checkpoint after a return");
    const prompt = room.invocations("claude").at(-1)!.prompt!;
    assert.match(prompt, new RegExp(`Ivan \\(human\\) returned the folder to checkpoint ${first.sha.slice(0, 8)}`));
    assert.match(prompt, /b\.txt \(removed\)/);
    assert.match(prompt, /a\.txt \(as it was\)/);

    // Undo brings back what the return took, the human's untracked notes too.
    const undo = room.engine.revertWorkspace({ undoOf: revert.seq });
    assert.equal(undo.undoOf, revert.seq);
    assert.equal(read(ws, "a.txt"), "v2\n");
    assert.equal(read(ws, "b.txt"), "new\n");
    assert.equal(read(ws, "notes.md"), "n2\n");
    assert.equal(read(ws, "scratch.txt"), "the human's untracked notes\n");
    assert.equal(room.store.state.reverts[0]!.undone, undo.seq);
    assert.throws(() => room.engine.revertWorkspace({ undoOf: revert.seq }), (error: unknown) => error instanceof RevertError && error.code === "undone");
    // An undo is not undone (that would redo the return); nothing is left to undo.
    assert.throws(() => room.engine.revertWorkspace({ undoOf: undo.seq }), (error: unknown) => error instanceof RevertError && error.code === "bad");
    assert.equal(undoableRevert(room.store.state), undefined);

    // While a turn runs the folder is the agents'; the human stops the run first.
    room.engine.postHuman("gamma");
    await withTimeout(
      (async () => {
        while (room.engine.presence().claude !== "working") await new Promise((resolve) => setTimeout(resolve, 20));
      })(),
    );
    assert.match(room.engine.revertBusy() ?? "", /stop the run/);
    assert.throws(() => room.engine.revertWorkspace({ sha: first.sha }), (error: unknown) => error instanceof RevertError && error.code === "busy");
    assert.equal(read(ws, "a.txt"), "v2\n");
    await room.engine.stop();
    assert.equal(room.engine.revertBusy(), null);
  } finally {
    await room.cleanup();
  }
});

test("in a shared folder a checkpoint keeps the whole folder, so returning to it keeps the human's untracked and uncommitted files", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-revert-"));
  try {
    prepareWorkspace(root, { initGit: true });
    writeFileSync(join(root, "base.txt"), "base\n");
    commitAll(root, "base");
    writeFileSync(join(root, "notes.txt"), "the human's notes\n");
    writeFileSync(join(root, "base.txt"), "edited, not committed\n");
    writeFileSync(join(root, "agent.txt"), "from the agent\n");
    // A room sharing the folder commits only what its turns were credited with.
    const cp = checkpointCommit(root, "cp1", "", ["agent.txt"])!;
    assert.deepEqual(git(root, "show", "--name-only", "--format=", cp.sha).split("\n").filter(Boolean), ["agent.txt"]);
    const partial = revertPreview(root, cp.sha);
    assert.ok(!("error" in partial) && partial.changes.length > 0, "the commit alone is not the folder");
    const folder = checkpointFolder(root, cp.sha, checkpointRef("room-a", cp.sha))!;
    assert.notEqual(folder, cp.sha);
    assert.equal(git(root, "rev-parse", checkpointRef("room-a", cp.sha)).trim(), folder, "kept under a ref, so gc never drops it");
    const same = revertPreview(root, folder);
    assert.ok(!("error" in same));
    assert.deepEqual(same.changes, [], "nothing changed since the checkpoint: nothing to return");

    rmSync(join(root, "notes.txt"));
    writeFileSync(join(root, "agent.txt"), "later edit\n");
    writeFileSync(join(root, "later.txt"), "later\n");
    const result = restoreWorkspace(root, folder, revertRef("room-a", 1), "before");
    assert.ok(!("error" in result));
    assert.equal(read(root, "notes.txt"), "the human's notes\n");
    assert.equal(read(root, "base.txt"), "edited, not committed\n");
    assert.equal(read(root, "agent.txt"), "from the agent\n");
    assert.equal(read(root, "later.txt"), null);

    // A room alone in its folder commits all of it: the commit is the folder.
    writeFileSync(join(root, "c.txt"), "c\n");
    const whole = checkpointCommit(root, "cp2", "")!;
    assert.equal(checkpointFolder(root, whole.sha, checkpointRef("room-a", whole.sha)), whole.sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an edit in the same second as git's index, keeping the file's size, is still seen by a snapshot and undone by a return", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-revert-"));
  try {
    prepareWorkspace(root, { initGit: true });
    // The same second, pinned: the file and the index share one mtime and the edit keeps size and inode.
    // ctime cannot be pinned, so git is told not to look at it, as on a fast machine where it matches too.
    git(root, "config", "core.trustctime", "false");
    const then = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    writeFileSync(join(root, "hello.txt"), "v1\n");
    utimesSync(join(root, "hello.txt"), then, then);
    const first = commitAll(root, "first");
    writeFileSync(join(root, "hello.txt"), "v2\n");
    utimesSync(join(root, "hello.txt"), then, then);
    utimesSync(join(root, ".git", "index"), then, then);
    // --no-optional-locks: status must not rewrite the index (that would smudge the entry and hide the race).
    assert.equal(git(root, "--no-optional-locks", "status", "--porcelain").trim(), "M hello.txt", "git itself sees the edit");

    const tree = snapshotTree(root);
    assert.equal(git(root, "show", `${tree}:hello.txt`), "v2\n", "the snapshot has the edit, not the stale stat");
    const back = restoreWorkspace(root, first, revertRef("r", 1), "before");
    assert.ok(!("error" in back));
    assert.deepEqual(back.changes.map((change) => change.path), ["hello.txt"]);
    assert.equal(read(root, "hello.txt"), "v1\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a return is all or nothing: a lock on git's index does not stop it, and a file that cannot be written puts the folder back", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-revert-"));
  try {
    prepareWorkspace(root, { initGit: true });
    mkdirSync(join(root, "ro"));
    writeFileSync(join(root, "ro", "x.txt"), "v1\n");
    writeFileSync(join(root, "hello.txt"), "v1\n");
    const first = commitAll(root, "first");
    writeFileSync(join(root, "ro", "x.txt"), "v2\n");
    writeFileSync(join(root, "hello.txt"), "v2\n");
    writeFileSync(join(root, "mine.txt"), "mine\n");

    // Someone's git (an IDE…) holds the index: the return never uses it.
    writeFileSync(join(root, ".git", "index.lock"), "");
    const locked = restoreWorkspace(root, first, revertRef("r", 1), "before");
    assert.ok(!("error" in locked));
    assert.deepEqual(locked.left, []);
    assert.equal(read(root, "hello.txt"), "v1\n");
    assert.equal(read(root, "mine.txt"), null);
    rmSync(join(root, ".git", "index.lock"));
    assert.ok(!("error" in restoreWorkspace(root, locked.undo, revertRef("r", 2), "undo")));
    assert.equal(read(root, "mine.txt"), "mine\n");

    // ro/x.txt cannot be written: mine.txt, already removed by then, comes back, and nothing changed.
    chmodSync(join(root, "ro"), 0o555);
    try {
      assert.deepEqual(restoreWorkspace(root, first, revertRef("r", 3), "before"), { error: "failed" });
    } finally {
      chmodSync(join(root, "ro"), 0o755);
    }
    assert.equal(read(root, "mine.txt"), "mine\n");
    assert.equal(read(root, "hello.txt"), "v2\n");
    assert.equal(read(root, "ro/x.txt"), "v2\n");
    assert.equal(git(root, "for-each-ref", "refs/agoryx/revert/r/3"), "", "no undo point is left for a return that did not happen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the latest return is undone, and an undo warns what changed after the return", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "one", write: [{ path: "a.txt", content: "1\n" }], reply: "1.", once: true },
      { agent: "claude", match: "two", write: [{ path: "a.txt", content: "2\n" }], reply: "2.", once: true },
      { agent: "claude", match: "three", write: [{ path: "b.txt", content: "3\n" }], reply: "3.", once: true },
    ],
    agents: [{ id: "claude", kind: "claude", label: "Claude" }],
    settings: { autoCommit: true },
  });
  const ws = room.store.state.workspace;
  try {
    room.engine.postHuman("one");
    await withTimeout(room.engine.waitIdle());
    room.engine.postHuman("two");
    await withTimeout(room.engine.waitIdle());
    const [first, second] = room.store.state.commits;
    const r1 = room.engine.revertWorkspace({ sha: first!.sha });
    const r2 = room.engine.revertWorkspace({ sha: second!.sha });
    assert.throws(() => planRevert(room.store.state, { undoOf: r1.seq }), (error: unknown) => error instanceof RevertError && error.code === "later");
    assert.equal(undoableRevert(room.store.state)?.seq, r2.seq);
    assert.equal(planRevert(room.store.state, { undoOf: r2.seq }).since, undefined, "nothing changed since");
    room.engine.postHuman("three");
    await withTimeout(room.engine.waitIdle());
    const plan = planRevert(room.store.state, { undoOf: r2.seq });
    assert.deepEqual(plan.since, ["b.txt"], "the agent's later work goes too, and the plan says so");
    room.engine.revertWorkspace({ undoOf: r2.seq, tree: plan.tree });
    assert.equal(read(ws, "a.txt"), "1\n");
    assert.equal(read(ws, "b.txt"), null);
  } finally {
    await room.cleanup();
  }
});

test("a return made in one room reaches the agents of the other rooms sharing the folder", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-revert-rooms-"));
  const workspace = join(home, "ws");
  mkdirSync(workspace, { recursive: true });
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  const open = (name: string, agent: RoomAgent, rules: unknown[]) => {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
    const store = RoomStore.create(join(home, "rooms"), {
      name,
      workspace,
      createdWorkspace: true,
      human: "Ivan",
      agents: [agent],
      settings: { ...DEFAULT_SETTINGS, network: false, autoCommit: true },
    });
    const engine = new RoomEngine({
      store,
      runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
      env: { ...process.env, FAKE_LOG: join(dir, "fake.log"), FAKE_STATE: join(dir, "fake-state"), FAKE_RULES: join(dir, "rules.json"), CLAUDECODE: "1", CLAUDE_CONFIG_DIR: join(dir, "cc"), CODEX_HOME: join(dir, "cx") },
      opsPollMs: 50,
      nativePollMs: 0,
    });
    return { engine, prompts: () => readFileSync(join(dir, "fake.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { prompt?: string }).filter((entry) => entry.prompt) };
  };
  const a = open("Room A", { id: "claude", kind: "claude", label: "Claude" }, [{ agent: "claude", match: "go", write: { path: "a.txt", content: "a\n" }, reply: "a.", once: true }]);
  const b = open("Room B", { id: "codex", kind: "codex", label: "Codex" }, [
    { agent: "codex", match: "go", write: { path: "b.txt", content: "b\n" }, reply: "b.", once: true },
    { agent: "codex", match: "look", reply: "ok.", once: true },
  ]);
  try {
    a.engine.postHuman("go");
    await withTimeout(a.engine.waitIdle());
    const checkpoint = a.engine.store.state.commits[0]!;
    b.engine.postHuman("go");
    await withTimeout(b.engine.waitIdle());
    assert.equal(read(workspace, "b.txt"), "b\n");

    const revert = a.engine.revertWorkspace({ sha: checkpoint.sha });
    assert.equal(read(workspace, "b.txt"), null, "room B's file went with the folder");
    const seen = b.engine.store.state.reverts;
    assert.equal(seen.length, 1, "room B records room A's return");
    assert.deepEqual(seen[0]!.fromRoom, { room: a.engine.store.state.id, name: "Room A", seq: revert.seq });
    assert.throws(() => planRevert(b.engine.store.state, { undoOf: seen[0]!.seq }), (error: unknown) => error instanceof RevertError && error.code === "missing", "room B cannot undo room A's return");

    b.engine.postHuman("look");
    await withTimeout(b.engine.waitIdle());
    const prompt = b.prompts().at(-1)!.prompt!;
    assert.match(prompt, /Ivan \(human\) from room "Room A", which shares this folder, returned the folder to checkpoint/);
    assert.match(prompt, /b\.txt \(removed\)/);

    // A room of another process tells by a marker in the folder; this room reads it before its next turn.
    markRevert(workspace, { room: "room-elsewhere", name: "Elsewhere", seq: 9, ts: new Date().toISOString(), to: checkpoint.sha, undo: revert.undo, changes: [], total: 0 });
    b.engine.absorbForeignReverts();
    b.engine.absorbForeignReverts();
    assert.deepEqual(b.engine.store.state.reverts.map((entry) => entry.fromRoom?.name), ["Room A", "Elsewhere"], "each return is recorded once");
    a.engine.absorbForeignReverts();
    assert.deepEqual(a.engine.store.state.reverts.map((entry) => entry.fromRoom?.name), [undefined, "Elsewhere"], "room A records the other one, not its own again");
  } finally {
    await a.engine.close();
    await b.engine.close();
    rmSync(home, { recursive: true, force: true });
  }
});
