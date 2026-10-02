import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkpointBody, checkpointSubject, runSteps, stepsInSubject } from "../../internal/agora/checkpoint-message.js";
import { buildBriefing } from "../../internal/agora/prompts.js";
import type { RoomEvent, TableItem } from "../../internal/agora/types.js";
import { stepCommitsSince } from "../../internal/agora/workspace.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;

// P10's checkpoints were named by the words that started the run (d72418c: the human's "…прибери з усіх комітів
// згадування T3") and listed turns with the files they were credited with: t13 "[1 files]" where it changed five,
// t15 missing. A checkpoint is named by the steps the run finished, and lists the files the commit holds.
test("a run's checkpoint is named by the steps it finished and lists every file it holds with the turns that changed it", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "Please", write: [{ path: "a.txt", content: "a\n" }], table: [["table", "next", "Write a"], ["table", "done", "X1"]], reply: "Wrote a.", once: true },
      { agent: "claude", match: "Please", sleepMs: 300, write: [{ path: "b.txt", content: "b\n" }], reply: "Wrote b.", once: true },
    ],
    settings: { autoCommit: true },
  });
  const ws = room.store.state.workspace;
  try {
    // Already in the folder before the run: committed with it, credited to no turn.
    writeFileSync(join(ws, "c.txt"), "c\n");
    room.engine.postHuman("Please do the work, and remove T3 from every commit");
    await withTimeout(room.engine.waitIdle());
    const snapshot = room.store.state.commits.at(-1)!;
    assert.equal(snapshot.internal, true);
    assert.equal(snapshot.subject, "agoryx: X1 Write a");
    assert.equal(git(ws, ["rev-parse", "--verify", "HEAD"]), "", "no branch commit was made");
    assert.deepEqual(git(ws, ["ls-tree", "-r", "--name-only", snapshot.sha]).split("\n").filter(Boolean).sort(), ["a.txt", "b.txt", "c.txt"]);
    assert.equal(room.store.state.table.next[0]!.commit, undefined, "done does not imply committed");
  } finally {
    await room.cleanup();
  }
});

const step = (id: string, text: string, by: string, done?: string): TableItem => ({ id, text, by, seq: 0, ...(done ? { done: true, doneBy: done } : {}) });
const op = (seq: number, value: Record<string, unknown>): RoomEvent => ({ seq, ts: "", type: "table.op", op: { by: "codex", ...value } }) as RoomEvent;

test("a run's steps: done during it, or put on the table during it and still to do; with none done, the run and who changed files", () => {
  const next = [step("X1", "Old step", "codex", "codex"), step("X2", "Quote chips\nand more", "claude", "codex"), step("X3", "Commit button", "codex")];
  const events = [op(3, { op: "next", text: "Old step", id: "X1" }), op(4, { op: "done", target: "X1" }), op(10, { op: "next", text: "Quote chips", id: "X2" }), op(11, { op: "next", text: "Commit button", id: "X3" }), op(12, { op: "done", target: "X2" }), op(13, { op: "next", text: "gone", id: "X4" })];
  const steps = runSteps(events, next, 9);
  assert.deepEqual(steps.map((entry) => entry.id), ["X2", "X3"], "X1 was done before the run; X4 was deleted");
  assert.equal(checkpointSubject(steps, "r2", ["claude"]), "X2 Quote chips");
  assert.equal(checkpointSubject([...steps, { ...next[0]! }], "r2", []), "X2, X1 done");
  assert.equal(checkpointSubject(steps.filter((entry) => !entry.done), "r2", ["claude", "codex"]), "run r2 by claude, codex");
  assert.equal(
    checkpointBody(steps, ["ui/a.ts", "notes.md"], [{ id: "t5", agent: "claude", files: ["ui/a.ts"] }, { id: "t6", agent: "codex", files: ["ui/a.ts"] }]),
    "Steps done:\n- X2 Quote chips (done by codex)\n\nSteps still to do:\n- X3 Commit button (codex)\n\nFiles:\n- ui/a.ts (t5 claude, t6 codex)\n- notes.md (no turn of this run)",
  );
});

// P10: Codex slept inside its turn waiting for Claude's review (m45–m50, then the turn limit), "done" came before any
// check, settle was used for work, and nothing was committed between steps.
test("the briefing: a step is checked without requiring a commit; no waiting inside a turn; settle is not for work", async () => {
  const room = createTestRoom({});
  try {
    const { state } = room.store;
    const [claude] = state.agents;
    const briefing = (tracking: "git" | "shadow" | "none", agents = state.agents) =>
      buildBriefing({ state: { ...state, agents }, agent: claude!, agentCli: { command: "agoryx" }, tracking });
    const git = briefing("git");
    assert.match(git, /Ask for its check \(`table review X1`\) and @mention another agent\. Say "done", "ready" or "verified" only after that check has passed/);
    assert.doesNotMatch(git, /its author commits it|git add|git commit/, "native agents decide when to commit");
    assert.match(git, /Don't wait inside your turn for a reply or a check: no sleeping, no polling\./);
    assert.match(git, /settle is for what the room has concluded, not for work: work is steps/);
    // No git of the folder's own: nothing to commit. Alone: the agent checks its own step.
    assert.doesNotMatch(briefing("shadow"), /its author commits it/);
    assert.match(briefing("git", [claude!]), /Check it yourself \(run it, test it\), say how, then `table done X1`/);
    assert.doesNotMatch(briefing("git", [claude!]), /someone else's to check/);
    // Writes off in the room: nobody commits.
    const readonly = buildBriefing({ state: { ...state, settings: { ...state.settings, access: "readonly" } }, agent: claude!, agentCli: { command: "agoryx" }, tracking: "git" });
    assert.doesNotMatch(readonly, /its author commits it/);
  } finally {
    await room.cleanup();
  }
});

test("a step its author committed during the run is named in that commit, not again in the checkpoint", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "codex",
        match: "Please",
        table: [["table", "next", "Write a"], ["table", "done", "X1"]],
        write: [{ path: "a.txt", content: "a\n" }],
        git: [["add", "a.txt"], ["commit", "-q", "-m", "X1 Write a"]],
        reply: "Wrote a, committed it.",
        once: true,
      },
      { agent: "claude", match: "Please", sleepMs: 300, write: [{ path: "b.txt", content: "b\n" }], reply: "Wrote b.", once: true },
    ],
    settings: { autoCommit: true },
  });
  const ws = room.store.state.workspace;
  try {
    room.engine.postHuman("Please do the work");
    await withTimeout(room.engine.waitIdle());
    assert.equal(git(ws, ["log", "-1", "--format=%s"]).trim(), "X1 Write a");
    assert.equal(git(ws, ["rev-list", "--count", "HEAD"]).trim(), "1", "only the agent's requested commit is on the branch");
    const snapshot = room.store.state.commits.at(-1)!;
    assert.equal(snapshot.internal, true);
    assert.deepEqual(git(ws, ["ls-tree", "-r", "--name-only", snapshot.sha]).split("\n").filter(Boolean), ["a.txt", "b.txt"]);
    assert.deepEqual(git(ws, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean), ["a.txt"]);
  } finally {
    await room.cleanup();
  }
});

test("a commit names its steps first; a subject is one clean line, and many done steps still say they are done", () => {
  assert.deepEqual(stepsInSubject("X1 Quote chips"), ["X1"]);
  assert.deepEqual(stepsInSubject("[X2] header"), ["X2"]);
  assert.deepEqual(stepsInSubject("X1, X2: chips and header"), ["X1", "X2"]);
  assert.deepEqual(stepsInSubject("X3+X4 — commit button"), ["X3", "X4"]);
  assert.deepEqual(stepsInSubject("fix X1 later"), []);
  assert.deepEqual(stepsInSubject("X10x tidy"), []);
  const done = (id: string, text: string) => ({ id, text, by: "codex", done: true, doneBy: "claude" });
  assert.equal(checkpointSubject([done("X1", "Tab\there and\u0007more\nsecond line")], "r1", []), "X1 Tab here and more");
  // Cut by characters, not halves of one.
  const long = checkpointSubject([done("X1", `${"a".repeat(58)}😀😀😀`)], "r1", []);
  assert.equal(long, `X1 ${"a".repeat(58)}😀…`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long));
  const many = Array.from({ length: 30 }, (_, i) => done(`X${i + 1}`, "s"));
  const subject = checkpointSubject(many, "r1", []);
  assert.ok(subject.length <= 60 && subject.endsWith(", … done") && subject.startsWith("X1, X2, "), subject);
  // A step committed during the run is in its own commit.
  assert.equal(checkpointSubject([done("X1", "one"), done("X2", "two")], "r1", ["codex"], new Map([["X1", "abc"]])), "X2 two");
  assert.equal(checkpointSubject([done("X1", "one")], "r1", ["codex"], new Map([["X1", "abc"]])), "run r1 by codex");
  // C1 controls and bidi overrides are not part of a line; a step with no text is its id.
  assert.equal(checkpointSubject([done("X1", "a\u0085b\u202ec\u2066d")], "r1", []), "X1 a b c d");
  assert.equal(checkpointSubject([done("X1", "\n")], "r1", []), "X1");
  // Cut by what reads as one character: a flag, a family, an accent on its letter.
  const flags = checkpointSubject([done("X1", `${"a".repeat(57)}🇺🇦🇺🇦👨‍👩‍👧é`)], "r1", []);
  assert.equal(flags, `X1 ${"a".repeat(57)}🇺🇦🇺🇦…`);
});

test("a checkpoint's body lists 200 files and counts the rest: a run that touched thousands still commits", () => {
  const files = Array.from({ length: 250 }, (_, i) => `f${i}.txt`);
  const body = checkpointBody([], files, [{ id: "t1", agent: "codex", files }]);
  const lines = body.split("\n");
  assert.equal(lines[0], "Files:");
  assert.equal(lines.length, 1 + 200 + 1);
  assert.equal(lines[200], "- f199.txt (t1 codex)");
  assert.equal(lines.at(-1), "- … and 50 more");
});

// A step's commit is the run's when it was made during the run and holds what the run changed: not "X1 …" made
// before the run began, and not another room's "X1 …" on files this run never touched.
test("a step committed during the run: made since it began, holding files the run changed (paths in a subfolder workspace)", () => {
  const repo = mkdtempSync(join(tmpdir(), "agoryx-step-commits-"));
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    run(["init", "-q"]);
    run(["config", "user.name", "T"]);
    run(["config", "user.email", "t@example.com"]);
    run(["config", "commit.gpgsign", "false"]);
    mkdirSync(join(repo, "ws"));
    const commit = (path: string, subject: string, env: NodeJS.ProcessEnv = {}) => {
      writeFileSync(join(repo, path), `${subject}\n`);
      run(["add", path]);
      run(["commit", "-q", "-m", subject], env);
      return run(["rev-parse", "HEAD"]);
    };
    const old = "2020-01-01T00:00:00Z";
    commit("ws/a.txt", "X1 before the run", { GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old });
    const since = Date.now() - 5_000;
    const mine = commit("ws/a.txt", "X2 the run's step");
    commit("ws/other.txt", "X3 another room's step");
    commit("outside.txt", "X4 outside the workspace, same name");
    const found = stepCommitsSince(join(repo, "ws"), since, ["a.txt", "outside.txt"]);
    assert.deepEqual([...found], [["X2", mine]]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
