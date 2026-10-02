import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planStepCommit, StepCommitError } from "../../internal/agora/step-commit.js";
import { parseTableCommand } from "../../internal/agora/table-cli.js";
import { applyTableOp, describeTableOp, emptyTable, findingsOf, prepareTableOp, renderTableMarkdown, stepChecked, summarizeTable } from "../../internal/agora/table.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { createTestRoom, withTimeout, writeFakeBins } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;
const AS_CODEX = ["-c", "user.name=Codex", "-c", "user.email=codex@test"];

// P10 chose a route (P10: steps P1+P2 → P3 → P8 → P5) and worked it as X1–X7, with "done" written as settled
// points (S3, S4) and nothing to say which step was built, which was checked and which went into a commit.
test("a step is on its route, asks for its check, carries what the check found, and says where it stands", () => {
  const table = emptyTable();
  let seq = 0;
  const move = (raw: Record<string, unknown>, by: string) => {
    const op = prepareTableOp(table, raw, by, false);
    applyTableOp(table, op, (seq += 1));
    return op;
  };
  move({ op: "propose", title: "Route: quotes, then the composer, then panels" }, "codex");
  move({ op: "propose", title: "Everything at once" }, "claude");
  move({ op: "withdraw", target: "P2" }, "claude");
  assert.throws(() => prepareTableOp(table, { op: "next", text: "x", target: "P2" }, "codex", false), /P2 was withdrawn/);
  assert.throws(() => prepareTableOp(table, { op: "next", text: "x", target: "S1" }, "codex", false), /a step is on an option \(a route, like P2\), not S1/);
  assert.throws(() => prepareTableOp(table, { op: "next", text: "x", target: "P9" }, "codex", false), /no option P9/);

  const added = move({ op: "next", text: "Quote chips in the composer", target: "p1" }, "claude");
  assert.equal(table.next[0]!.target, "P1");
  assert.equal(describeTableOp(added, table), 'added next step X1 on P1: "Quote chips in the composer"');
  move({ op: "next", text: "Loose step" }, "codex");

  const asked = move({ op: "review", target: "X1" }, "claude");
  assert.equal(table.next[0]!.review, "claude");
  assert.equal(describeTableOp(asked, table), 'asked for a check of X1 "Quote chips in the composer"');
  assert.match(renderTableMarkdown(table, "room"), /- X1: Quote chips in the composer \[on P1\] \(claude\) — waiting for its check$/m);

  // The author fixes what was found and asks again; only someone else's check finds things.
  assert.throws(() => prepareTableOp(table, { op: "object", target: "X1", text: "hm" }, "claude", false), /X1 is your own step — fix it, then ask for its check again: review X1/);
  move({ op: "object", target: "X1", text: "the @ in a quote is not highlighted" }, "codex");
  move({ op: "object", target: "X1", text: "↑ loses the chip" }, "codex");
  assert.equal(findingsOf(table, "X1"), 2);
  move({ op: "done", target: "X1" }, "codex");
  assert.match(renderTableMarkdown(table, "room"), /- ~~X1: Quote chips in the composer~~ \[on P1\] \(claude; done by codex\) — checked, 2 findings$/m);
  assert.throws(() => prepareTableOp(table, { op: "review", target: "X1" }, "claude", false), /X1 is done/);
  // Done once: a second done would put a second name on it.
  assert.throws(() => prepareTableOp(table, { op: "done", target: "X1" }, "claude", false), /X1 is already done/);
  assert.throws(() => prepareTableOp(table, { op: "review", target: "X9" }, "claude", false), /no next step X9/);
  assert.match(summarizeTable(table)!, /to do: X2 "Loose step"$/m);

  // A step marked done with no check asked for is done, not checked.
  move({ op: "done", target: "X2" }, "codex");
  assert.match(renderTableMarkdown(table, "room"), /- ~~X2: Loose step~~ \(codex\) — done without a check$/m);

  // The one who asked for the check built the step: marking it done themselves is no check, and nor are their objections.
  move({ op: "next", text: "Header", target: "P1" }, "codex");
  move({ op: "review", target: "X3" }, "claude");
  assert.throws(() => prepareTableOp(table, { op: "object", target: "X3", text: "hm" }, "claude", false), /X3 is your own step/);
  move({ op: "object", target: "X3", text: "the name is cut" }, "codex");
  // One checking it answers with what it found; asking for its check again is its builder's.
  assert.throws(() => prepareTableOp(table, { op: "review", target: "X3" }, "codex", false), /X3 waits for the check claude asked for — checking it\? object X3 "what fails", or done X3 once it passes/);
  move({ op: "done", target: "X3" }, "claude");
  assert.equal(stepChecked(table.next[2]!), false);
  assert.match(renderTableMarkdown(table, "room"), /- ~~X3: Header~~ \[on P1\] \(codex; done by claude\) — done without a check, 1 finding$/m);

  // One put a step on the table, another built it and marked it done with no check asked for: done, not checked.
  // With none asked for, the one who put it there may well be its checker: its objections are findings.
  move({ op: "next", text: "Footer", target: "P1" }, "claude");
  move({ op: "object", target: "X4", text: "it overlaps the composer" }, "claude");
  move({ op: "done", target: "X4" }, "codex");
  assert.equal(stepChecked(table.next[3]!), false);
  assert.match(renderTableMarkdown(table, "room"), /- ~~X4: Footer~~ \[on P1\] \(claude; done by codex\) — done without a check, 1 finding$/m);

  // Whether it was checked is how things stood when it was marked done: the human's done is the human's check, and
  // alone in a room an agent's own check is the check — seating a second agent later changes neither.
  move({ op: "next", text: "Solo step" }, "claude");
  move({ op: "next", text: "Human step" }, "codex");
  applyTableOp(table, prepareTableOp(table, { op: "done", target: "X5" }, "claude", false), (seq += 1), { alone: true });
  applyTableOp(table, prepareTableOp(table, { op: "done", target: "X6" }, "Ivan", true), (seq += 1), { human: true });
  assert.deepEqual([stepChecked(table.next[4]!), stepChecked(table.next[5]!)], [true, true]);
  assert.match(renderTableMarkdown(table, "room"), /- ~~X5: Solo step~~ \(claude\) — checked$/m);

  // A check can say it passed with support: then its builder may mark it done. A support from before the check was
  // asked for is no check of what was built since.
  move({ op: "next", text: "Badge" }, "codex");
  move({ op: "review", target: "X7" }, "codex");
  move({ op: "support", target: "X7", text: "works on touch too" }, "claude");
  move({ op: "done", target: "X7" }, "codex");
  move({ op: "next", text: "Tab" }, "codex");
  move({ op: "support", target: "X8", text: "good idea" }, "claude");
  move({ op: "review", target: "X8" }, "codex");
  move({ op: "done", target: "X8" }, "codex");
  assert.deepEqual([stepChecked(table.next[6]!), stepChecked(table.next[7]!)], [true, false]);
  // Who passed each check: who marked it done, the human, or the one whose support let its builder close it.
  assert.deepEqual([table.next[0]!.checkedBy, table.next[5]!.checkedBy, table.next[6]!.checkedBy, table.next[4]!.checkedBy], ["codex", "Ivan", "claude", undefined]);
  // A support its author objected after is taken back: its builder closing it then is no check.
  move({ op: "next", text: "Toast" }, "codex");
  move({ op: "review", target: "X9" }, "codex");
  move({ op: "support", target: "X9", text: "looks right" }, "claude");
  move({ op: "object", target: "X9", text: "breaks on touch" }, "claude");
  move({ op: "done", target: "X9" }, "codex");
  assert.equal(stepChecked(table.next[8]!), false);

  // An option deleted takes its steps' route with it: they are loose steps again, not hidden with it.
  move({ op: "propose", title: "Spare route" }, "claude");
  move({ op: "next", text: "Spare step", target: "P3" }, "claude");
  move({ op: "delete", target: "P3" }, "claude");
  assert.equal(table.next.at(-1)!.target, undefined);

  assert.deepEqual(parseTableCommand("next", ["Quote", "chips", "--on", "P1"]), { op: "next", text: "Quote chips", target: "P1" });
  assert.deepEqual(parseTableCommand("review", ["X1"]), { op: "review", target: "X1" });
});

test("an agent's commit naming a step marks it committed; a commit naming none, or made by no turn of this room, does not", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "codex",
        match: "BUILD",
        once: true,
        write: [{ path: "quote.ts", content: "export const quote = 1;\n" }],
        table: [["table", "next", "Quote chips"], ["table", "next", "Notes"], ["table", "review", "X1"]],
        reply: "Built X1.",
      },
      { agent: "claude", match: "CHECK", once: true, table: [["table", "object", "X1", "stray console.log"], ["table", "done", "X1"]], reply: "Checked X1." },
      {
        agent: "codex",
        match: "COMMIT",
        once: true,
        command: 'git add quote.ts && git commit -m "X1 Quote chips"',
        run: [["git", "add", "quote.ts"], ["git", ...AS_CODEX, "commit", "-qm", "X1 Quote chips"]],
        reply: "Committed X1.",
      },
      {
        agent: "codex",
        match: "TIDY",
        once: true,
        command: "git add -A && git commit -m 'tidy the notes after X1'",
        run: [["sh", "-c", "echo notes > notes.md"], ["git", "add", "-A"], ["git", ...AS_CODEX, "commit", "-qm", "tidy the notes after X1"]],
        reply: "Tidied.",
      },
      {
        agent: "codex",
        match: "AGAIN",
        once: true,
        command: "git commit -am 'X1 Quote chips, again'",
        run: [["sh", "-c", "echo 2 >> quote.ts"], ["git", ...AS_CODEX, "commit", "-qam", "X1 Quote chips, again"]],
        reply: "Again.",
      },
      {
        agent: "codex",
        match: "EMPTY",
        once: true,
        command: "git commit --allow-empty -m 'X2 Notes'",
        run: [["git", ...AS_CODEX, "commit", "-q", "--allow-empty", "-m", "X2 Notes"]],
        reply: "Empty.",
      },
      {
        agent: "claude",
        match: "AFTER",
        once: true,
        sleepMs: 1200,
        command: "git add claude.txt && git commit -m 'claude wip'",
        run: [["sh", "-c", "echo c > claude.txt"], ["git", "add", "claude.txt"], ["git", ...AS_CODEX, "commit", "-qm", "claude wip"]],
        reply: "ok",
      },
    ],
    settings: { autoCommit: false },
  });
  const ws = room.store.state.workspace;
  try {
    for (const [who, word] of [["codex", "BUILD"], ["claude", "CHECK"], ["codex", "COMMIT"]] as const) {
      room.engine.postHuman(`@${who} ${word}`);
      await withTimeout(room.engine.waitIdle());
    }
    const step = room.store.state.table.next[0]!;
    const head = git(ws, "rev-parse", "HEAD").trim();
    assert.deepEqual(step.commit && { sha: step.commit.sha, by: step.commit.by }, { sha: head, by: "codex" });
    const event = room.store.events.find((entry) => entry.type === "step.committed");
    assert.ok(event?.type === "step.committed" && event.turnId === room.store.state.turns.at(-1)!.id && event.subject === "X1 Quote chips");
    assert.match(renderTableMarkdown(room.store.state.table, "room"), new RegExp(`— committed ${head.slice(0, 7)}, 1 finding$`, "m"));

    assert.match(readFileSync(room.engine.ws.tableFile, "utf8"), new RegExp(`— committed ${head.slice(0, 7)}, 1 finding$`, "m"), "TABLE.md hears of it");

    // A commit naming a step only further on in its subject does not hold it; one naming a step already in a
    // commit leaves it in that one.
    room.engine.postHuman("@codex TIDY");
    await withTimeout(room.engine.waitIdle());
    assert.equal(git(ws, "log", "-1", "--format=%s").trim(), "tidy the notes after X1");
    room.engine.postHuman("@codex AGAIN");
    await withTimeout(room.engine.waitIdle());
    assert.equal(git(ws, "log", "-1", "--format=%s").trim(), "X1 Quote chips, again");
    assert.equal(room.store.state.table.next[0]!.commit?.sha, head);
    // A commit naming a step that holds none of its work (nor the turn's) is not where the step went.
    room.engine.postHuman("@codex EMPTY");
    await withTimeout(room.engine.waitIdle());
    assert.equal(git(ws, "log", "-1", "--format=%s").trim(), "X2 Notes");
    assert.equal(room.store.state.table.next[1]!.commit, undefined);
    // The human's own commit in their terminal, naming a step still to commit, made while a turn ran that committed
    // something else, is not the turn's.
    room.engine.postHuman("@claude AFTER");
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(join(ws, "human.txt"), "mine\n");
    git(ws, "add", "human.txt");
    git(ws, ...AS_CODEX, "commit", "-qm", "X2 by hand");
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(git(ws, "log", "-2", "--format=%s").trim().split("\n"), ["claude wip", "X2 by hand"]);
    assert.equal(room.store.state.table.next[1]!.commit, undefined);
    assert.equal(room.store.events.filter((entry) => entry.type === "step.committed").length, 1);
  } finally {
    await room.cleanup();
  }
});

test("a run's checkpoint takes the steps it finished, unless their author committed them", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "codex",
        match: "Please",
        once: true,
        write: [{ path: "a.txt", content: "a\n" }],
        table: [["table", "next", "Write a"], ["table", "next", "Write b"], ["table", "next", "Write c"], ["table", "done", "X1"], ["table", "done", "X2"]],
        command: "git add b.txt && git commit -m 'X2 Write b'",
        run: [["sh", "-c", "echo b > b.txt"], ["git", "add", "b.txt"], ["git", ...AS_CODEX, "commit", "-qm", "X2 Write b"]],
        reply: "Wrote a and b.",
      },
    ],
    settings: { autoCommit: true },
  });
  try {
    room.engine.postHuman("@codex Please");
    await withTimeout(room.engine.waitIdle());
    const [x1, x2, x3] = room.store.state.table.next;
    const checkpoint = room.store.state.commits.at(-1)!;
    assert.deepEqual(x1!.commit && [x1!.commit.sha, x1!.commit.by], [checkpoint.sha, "agoryx"]);
    assert.equal(x2!.commit?.by, "codex", "its author committed it");
    assert.notEqual(x2!.commit?.sha, checkpoint.sha);
    assert.equal(x3!.commit, undefined, "a step still to do is not in it");
  } finally {
    await room.cleanup();
  }
});

test("a step is in the checkpoint that holds its work: built in one run, passed in the next, it is in the first one", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "BUILD1", once: true, write: [{ path: "q.ts", content: "q\n" }], table: [["table", "next", "Quote chips"], ["table", "review", "X1"]], reply: "Built X1." },
      // A check that changes nothing makes no checkpoint: the step is in the one its build made.
      { agent: "claude", match: "PASS1", once: true, table: [["table", "done", "X1"]], reply: "X1 passes." },
      { agent: "codex", match: "BUILD2", once: true, write: [{ path: "b.ts", content: "b\n" }], table: [["table", "next", "Write b"], ["table", "review", "X2"]], reply: "Built X2." },
      // A check that changes something else: its checkpoint holds that, not the step.
      { agent: "claude", match: "PASS2", once: true, write: [{ path: "other.ts", content: "o\n" }], table: [["table", "done", "X2"]], reply: "X2 passes." },
      { reply: "::pass::" },
    ],
    settings: { autoCommit: true },
  });
  const ws = room.store.state.workspace;
  try {
    const checkpoints: string[] = [];
    for (const message of ["@codex BUILD1", "@claude PASS1", "@codex BUILD2", "@claude PASS2"]) {
      const before = room.store.state.commits.length;
      room.engine.postHuman(message);
      await withTimeout(room.engine.waitIdle());
      checkpoints.push(room.store.state.commits.length > before ? room.store.state.commits.at(-1)!.sha : "");
    }
    const [build1, pass1, build2, pass2] = checkpoints;
    assert.ok(build1 && build2 && pass2);
    assert.equal(pass1, "", "the check changed nothing");
    const [x1, x2] = room.store.state.table.next;
    assert.deepEqual(x1!.commit && [x1!.commit.sha, x1!.commit.by], [build1, "agoryx"]);
    assert.deepEqual(x2!.commit && [x2!.commit.sha, x2!.commit.by], [build2, "agoryx"]);
    // Named by the steps whose work it holds: the check's checkpoint holds none of X2's.
    assert.match(git(ws, "log", "-1", "--format=%s", pass2!).trim(), /^agoryx: run r\d+ by claude$/);
    assert.match(git(ws, "log", "-1", "--format=%b", pass2!), new RegExp(`- X2 Write b \\(done by claude; committed as ${build2!.slice(0, 8)}\\)`));
  } finally {
    await room.cleanup();
  }
});

test("the human commits a step: only the files chosen, under the folder's own name, named by the step; staged work stays staged", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "codex",
        match: "BUILD",
        once: true,
        write: [{ path: "src/quote.ts", content: "export const quote = 1;\n" }, { path: "src/chip.ts", content: "export const chip = 1;\n" }],
        table: [["table", "next", "Quote chips\nwith their author"], ["table", "next", "Header chip"], ["table", "review", "X1"]],
        reply: "Built X1.",
      },
      // Claude's own work beside the step, after it was put on the table: not the step's.
      { agent: "claude", match: "OTHER", once: true, write: [{ path: "src/other.ts", content: "export const other = 1;\n" }], reply: "Other." },
      { agent: "claude", match: "SLOW", once: true, sleepMs: 1500, reply: "Slow." },
      { agent: "claude", match: "NEXT", once: true, reply: "ok" },
    ],
    settings: { autoCommit: false },
  });
  const ws = room.store.state.workspace;
  try {
    git(ws, "config", "user.name", "Ivan Test");
    git(ws, "config", "user.email", "ivan@test");
    // The human's own work, staged before: neither the step's nor taken by its commit.
    writeFileSync(join(ws, "staged.txt"), "staged\n");
    git(ws, "add", "staged.txt");
    room.engine.postHuman("@codex BUILD");
    await withTimeout(room.engine.waitIdle());
    const turn = room.store.state.turns.at(-1)!;
    room.engine.postHuman("@claude OTHER");
    await withTimeout(room.engine.waitIdle());
    const other = room.store.state.turns.at(-1)!;

    const plan = planStepCommit(room.store.state, room.store.events, "X1");
    assert.equal(plan.subject, "X1 Quote chips");
    assert.deepEqual(
      plan.files.map((file) => [file.path, file.step, file.turns.map((entry) => entry.id)]),
      [["src/chip.ts", true, [turn.id]], ["src/other.ts", false, [other.id]], ["src/quote.ts", true, [turn.id]], ["staged.txt", false, []]],
    );
    // The turn that put X2 on the table was building X1: none of its files are X2's.
    assert.deepEqual(planStepCommit(room.store.state, room.store.events, "X2").files.filter((file) => file.step), []);
    assert.throws(() => room.engine.commitStep("X1", ["src/quote.ts"], "codex"), (error: unknown) => error instanceof StepCommitError && error.status === 403);
    assert.throws(() => room.engine.commitStep("X1", ["../etc/passwd"]), (error: unknown) => error instanceof StepCommitError && error.status === 409);
    assert.throws(() => room.engine.commitStep("X1", []), /no files chosen/);
    assert.throws(() => planStepCommit(room.store.state, room.store.events, "X7"), /no step X7/);

    // Not while a turn may still be changing the files.
    room.engine.postHuman("@claude SLOW");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => room.engine.commitStep("X1", ["src/quote.ts"]), (error: unknown) => error instanceof StepCommitError && error.status === 409 && /a turn is running/.test(error.message));
    await withTimeout(room.engine.waitIdle());

    const made = room.engine.commitStep("X1", ["src/quote.ts"]);
    assert.equal(git(ws, "rev-parse", "HEAD").trim(), made.sha);
    assert.equal(git(ws, "log", "-1", "--format=%an <%ae>|%s").trim(), "Ivan Test <ivan@test>|X1 Quote chips");
    assert.equal(git(ws, "log", "-1", "--format=%b").trim(), `Step:\n- X1 Quote chips (codex)\n\nFiles:\n- src/quote.ts (${turn.id} codex)`);
    assert.deepEqual(git(ws, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["src/quote.ts"]);
    assert.deepEqual(git(ws, "diff", "--cached", "--name-only").split("\n").filter(Boolean), ["staged.txt"], "the human's staged file stays staged");
    assert.ok(git(ws, "status", "--porcelain").includes("?? src/chip.ts"), "the file left out stays as it was");
    assert.deepEqual(room.store.state.table.next[0]!.commit && { sha: room.store.state.table.next[0]!.commit.sha, by: room.store.state.table.next[0]!.commit.by }, { sha: made.sha, by: "Ivan" });
    assert.match(readFileSync(room.engine.ws.tableFile, "utf8"), new RegExp(`with their author \\(codex\\) — committed ${made.sha.slice(0, 7)}$`, "m"));
    // Once in a commit, it stays in that one.
    assert.throws(() => room.engine.commitStep("X1", ["src/chip.ts"]), new RegExp(`X1 is already committed as ${made.sha.slice(0, 7)}`));

    // The agents hear of it in their next turn.
    room.engine.postHuman("@claude NEXT");
    await withTimeout(room.engine.waitIdle());
    assert.match(room.invocations("claude").at(-1)!.prompt!, new RegExp(`── Ivan \\(human\\) · \\d\\d:\\d\\d\\ncommitted X1 as ${made.sha.slice(0, 8)}: X1 Quote chips`));
  } finally {
    await room.cleanup();
  }
});

test("a step the human closed with no check asked for is still its builder's: its files are ticked, its builder's commit of it recorded", async () => {
  const room = createTestRoom({
    rules: [
      // Put on the table and built in one turn, its check never asked for.
      { agent: "codex", match: "BUILD", once: true, write: [{ path: "q.ts", content: "q\n" }], table: [["table", "next", "Quote chips"]], reply: "Built X1." },
      // A turn that only commits changes no file of its own.
      {
        agent: "codex",
        match: "COMMIT",
        once: true,
        command: 'git add q.ts && git commit -m "X1 Quote chips"',
        run: [["git", "add", "q.ts"], ["git", ...AS_CODEX, "commit", "-qm", "X1 Quote chips"]],
        reply: "Committed X1.",
      },
    ],
    settings: { autoCommit: false },
  });
  try {
    room.engine.postHuman("@codex BUILD");
    await withTimeout(room.engine.waitIdle());
    room.engine.tableOp({ op: "done", target: "X1" });
    const x1 = room.store.state.table.next[0]!;
    assert.deepEqual([x1.doneBy, stepChecked(x1)], [room.store.state.human, true], "the human's done is the human's check");
    assert.deepEqual(planStepCommit(room.store.state, room.store.events, "X1").files.map((file) => [file.path, file.step]), [["q.ts", true]]);
    room.engine.postHuman("@codex COMMIT");
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(room.store.state.table.next[0]!.commit && [room.store.state.table.next[0]!.commit.sha, room.store.state.table.next[0]!.commit.by], [git(room.store.state.workspace, "rev-parse", "HEAD").trim(), "codex"]);
  } finally {
    await room.cleanup();
  }
});

test("alone in a room, an agent's own done is the check, and seating a second agent later does not undo it", async () => {
  const room = createTestRoom({
    agents: [{ id: "claude", kind: "claude", label: "Claude" }],
    rules: [{ agent: "claude", match: "BUILD", once: true, write: [{ path: "q.ts", content: "q\n" }], table: [["table", "next", "Quote chips"], ["table", "done", "X1"]], reply: "Built and checked X1." }],
    settings: { autoCommit: false },
  });
  try {
    room.engine.postHuman("@claude BUILD");
    await withTimeout(room.engine.waitIdle());
    assert.equal(stepChecked(room.store.state.table.next[0]!), true);
    room.engine.addAgent({ kind: "codex" });
    assert.equal(room.store.state.agents.length, 2);
    assert.equal(stepChecked(room.store.state.table.next[0]!), true);
  } finally {
    await room.cleanup();
  }
});

test("a step fixed after its check found something is in the checkpoint of the fix, not of the build the check turned down", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "BUILD", once: true, write: [{ path: "q.ts", content: "q1\n" }], table: [["table", "next", "Quote chips"], ["table", "review", "X1"]], reply: "Built X1." },
      { agent: "claude", match: "OBJECT", once: true, table: [["table", "object", "X1", "off by one"]], reply: "X1: off by one." },
      { agent: "codex", match: "FIX", once: true, write: [{ path: "q.ts", content: "q2\n" }], table: [["table", "review", "X1"]], reply: "Fixed X1." },
      { agent: "claude", match: "PASS", once: true, table: [["table", "done", "X1"]], reply: "X1 passes." },
      { reply: "::pass::" },
    ],
    settings: { autoCommit: true },
  });
  try {
    const checkpoints: string[] = [];
    for (const message of ["@codex BUILD", "@claude OBJECT", "@codex FIX", "@claude PASS"]) {
      const before = room.store.state.commits.length;
      room.engine.postHuman(message);
      await withTimeout(room.engine.waitIdle());
      checkpoints.push(room.store.state.commits.length > before ? room.store.state.commits.at(-1)!.sha : "");
    }
    const [build, object, fix, pass] = checkpoints;
    assert.ok(build && fix);
    assert.deepEqual([object, pass], ["", ""], "the checks changed nothing");
    assert.deepEqual(room.store.state.table.next[0]!.commit && [room.store.state.table.next[0]!.commit.sha, room.store.state.table.next[0]!.commit.by], [fix, "agoryx"]);
  } finally {
    await room.cleanup();
  }
});

test("with no builder on record, a step's files are not its planner's other work: a turn that named another step was on that one", async () => {
  // Claude plans X1 for Codex and X2 for itself; Codex builds X1 without a word on the table, Claude builds X2 and
  // asks for its check. The human closes X1.
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "PLAN", once: true, table: [["table", "next", "Quote chips"], ["table", "next", "Panels"]], reply: "X1 is for Codex, X2 mine." },
      { agent: "codex", match: "QUOTES", once: true, write: [{ path: "q.ts", content: "q\n" }], reply: "Quotes are in." },
      { agent: "claude", match: "PANELS", once: true, write: [{ path: "panels.ts", content: "p\n" }], table: [["table", "review", "X2"]], reply: "X2 is built." },
    ],
    settings: { autoCommit: false },
  });
  try {
    for (const message of ["@claude PLAN", "@codex QUOTES", "@claude PANELS"]) {
      room.engine.postHuman(message);
      await withTimeout(room.engine.waitIdle());
    }
    room.engine.tableOp({ op: "done", target: "X1" });
    const ticked = (id: string) => planStepCommit(room.store.state, room.store.events, id).files.map((file) => [file.path, file.step]);
    assert.deepEqual(ticked("X1"), [["panels.ts", false], ["q.ts", true]]);
    assert.deepEqual(ticked("X2"), [["panels.ts", true], ["q.ts", false]]);
  } finally {
    await room.cleanup();
  }
});

test("with no builder on record, the turn that put a step on the table built it when no later one did: not the next step's turn", async () => {
  // Codex puts X1 and X2 on the table and starts X1 in that turn, then builds X2 and asks for its check; the human closes X1.
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "PLAN", once: true, write: [{ path: "q.ts", content: "q\n" }], table: [["table", "next", "Quote chips"], ["table", "next", "Panels"]], reply: "Planned; X1 is in." },
      { agent: "codex", match: "PANELS", once: true, write: [{ path: "panels.ts", content: "p\n" }], table: [["table", "review", "X2"]], reply: "X2 is built." },
    ],
    settings: { autoCommit: false },
  });
  try {
    for (const message of ["@codex PLAN", "@codex PANELS"]) {
      room.engine.postHuman(message);
      await withTimeout(room.engine.waitIdle());
    }
    room.engine.tableOp({ op: "done", target: "X1" });
    assert.deepEqual(planStepCommit(room.store.state, room.store.events, "X1").files.map((file) => [file.path, file.step]), [["panels.ts", false], ["q.ts", true]]);
  } finally {
    await room.cleanup();
  }
});

test("an agent's commit naming another agent's step holds that step's work, not the committer's other files", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "BUILD", once: true, write: [{ path: "q.ts", content: "q\n" }], table: [["table", "next", "Quote chips"], ["table", "review", "X1"]], reply: "Built X1." },
      { agent: "claude", match: "NOTES", once: true, write: [{ path: "notes.md", content: "n\n" }], reply: "Notes written." },
      {
        agent: "claude",
        match: "COMMIT",
        once: true,
        command: 'git add notes.md && git commit -m "X1 Quote chips"',
        run: [["git", "add", "notes.md"], ["git", "-c", "user.name=Claude", "-c", "user.email=claude@test", "commit", "-qm", "X1 Quote chips"]],
        reply: "Committed.",
      },
    ],
    settings: { autoCommit: false },
  });
  try {
    for (const message of ["@codex BUILD", "@claude NOTES", "@claude COMMIT"]) {
      room.engine.postHuman(message);
      await withTimeout(room.engine.waitIdle());
    }
    assert.equal(git(room.store.state.workspace, "log", "-1", "--format=%s").trim(), "X1 Quote chips");
    assert.equal(room.store.state.table.next[0]!.commit, undefined);
  } finally {
    await room.cleanup();
  }
});

test("the files ticked for a step are its builder's: not those of the turn that passed it", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "BUILD", once: true, write: [{ path: "q.ts", content: "q\n" }], table: [["table", "next", "Quote chips"], ["table", "review", "X1"]], reply: "Built X1." },
      { agent: "claude", match: "PASS", once: true, write: [{ path: "notes.ts", content: "n\n" }], table: [["table", "done", "X1"]], reply: "X1 passes." },
    ],
    settings: { autoCommit: false },
  });
  try {
    room.engine.postHuman("@codex BUILD");
    await withTimeout(room.engine.waitIdle());
    room.engine.postHuman("@claude PASS");
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(planStepCommit(room.store.state, room.store.events, "X1").files.map((file) => [file.path, file.step]), [["notes.ts", false], ["q.ts", true]]);
  } finally {
    await room.cleanup();
  }
});

test("over HTTP: the human sees what committing a step would take and commits it; an agent's key is refused", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { request } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { AgoraDaemon } = await import("../../internal/agora/daemon.js");
  const { agentKey } = await import("../../internal/agora/actor.js");
  const home = mkdtempSync(join(tmpdir(), "agora-steps-"));
  // The human's move on the table wakes the agents: fake ones.
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  writeFileSync(join(home, "rules.json"), JSON.stringify([{ reply: "::pass::" }]));
  const daemon = new AgoraDaemon({
    env: {
      ...process.env,
      AGORYX_HOME: join(home, "agora"),
      AGORYX_USER: "Ivan",
      AGORYX_WORKSPACES: join(home, "ws"),
      AGORYX_JEV: "off",
      FAKE_LOG: join(home, "fake.log"),
      FAKE_STATE: join(home, "fake-state"),
      FAKE_RULES: join(home, "rules.json"),
      CLAUDE_CONFIG_DIR: join(home, "claude-config"),
      CODEX_HOME: join(home, "codex-home"),
    },
    port: 0,
    advertise: false,
    watchDays: 0,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });
  const { port } = await daemon.start();
  const call = (method: string, path: string, body?: unknown, token = daemon.token): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: { host: `127.0.0.1:${port}`, "x-agoryx-token": token, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  try {
    const room = (await call("POST", "/api/rooms", { name: "Steps" })).json.room as { id: string };
    const workspace = (await call("GET", `/api/rooms/${room.id}`)).json.state.workspace as string;
    git(workspace, "config", "user.name", "Ivan Test");
    git(workspace, "config", "user.email", "ivan@test");
    assert.equal((await call("POST", `/api/rooms/${room.id}/table`, { op: "next", text: "Quote chips" })).status, 201);
    // The run the move woke ends before the human's own work.
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      const runs = (await call("GET", `/api/rooms/${room.id}`)).json.state.runs as Array<{ status: string }>;
      if (runs.length && runs.at(-1)!.status !== "active") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    writeFileSync(join(workspace, "quote.ts"), "export const quote = 1;\n");

    const plan = await call("GET", `/api/rooms/${room.id}/step-commit?step=X1`);
    assert.equal(plan.status, 200);
    assert.equal(plan.json.subject, "X1 Quote chips");
    assert.ok(plan.json.files.some((file: { path: string }) => file.path === "quote.ts"));
    assert.equal((await call("GET", `/api/rooms/${room.id}/step-commit?step=X9`)).status, 404);

    const asAgent = await call("POST", `/api/rooms/${room.id}/step-commit`, { step: "X1", files: ["quote.ts"] }, agentKey(daemon.token, room.id, "codex"));
    assert.equal(asAgent.status, 403);
    assert.match(asAgent.json.error, /git commit -m "X1/);

    const made = await call("POST", `/api/rooms/${room.id}/step-commit`, { step: "X1", files: ["quote.ts"] });
    assert.equal(made.status, 201, made.json?.error);
    assert.equal(git(workspace, "rev-parse", "HEAD").trim(), made.json.sha);
    const state = (await call("GET", `/api/rooms/${room.id}`)).json.state;
    assert.equal(state.table.next[0].commit.sha, made.json.sha);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("when git will not commit a step, the human hears why", async () => {
  const room = createTestRoom({ rules: [{ reply: "ok" }], settings: { autoCommit: false } });
  const ws = room.store.state.workspace;
  try {
    git(ws, "config", "user.name", "Ivan Test");
    git(ws, "config", "user.email", "ivan@test");
    room.engine.tableOp({ op: "next", text: "Quote chips" });
    writeFileSync(join(ws, "quote.ts"), "export const quote = 1;\n");
    const before = git(ws, "rev-parse", "HEAD").trim();
    // Another git command holds the index.
    const lock = join(ws, git(ws, "rev-parse", "--git-path", "index.lock").trim());
    writeFileSync(lock, "");
    assert.throws(() => room.engine.commitStep("X1", ["quote.ts"]), (error: unknown) => error instanceof StepCommitError && error.status === 409 && /git could not commit these files: another git command holds the index/.test(error.message));
    rmSync(lock);
    assert.equal(git(ws, "rev-parse", "HEAD").trim(), before);
    assert.equal(room.store.state.table.next[0]!.commit, undefined);
    // In the middle of a merge, a commit would land inside it.
    const merging = join(ws, git(ws, "rev-parse", "--git-path", "MERGE_HEAD").trim());
    writeFileSync(merging, `${before}\n`);
    assert.throws(() => room.engine.commitStep("X1", ["quote.ts"]), (error: unknown) => error instanceof StepCommitError && error.status === 409 && /in the middle of a merge: finish it or abort it first/.test(error.message));
    rmSync(merging);
    assert.ok(room.engine.commitStep("X1", ["quote.ts"]).sha, "once the index is free, it commits");

    // A file renamed with git mv: its old path is listed with the new one, and goes in with it.
    room.engine.tableOp({ op: "next", text: "Rename" });
    git(ws, "mv", "quote.ts", "chips.ts");
    assert.deepEqual(planStepCommit(room.store.state, room.store.events, "X2").files.map((file) => file.path), ["chips.ts", "quote.ts"]);
    room.engine.commitStep("X2", ["chips.ts", "quote.ts"]);
    assert.deepEqual(git(ws, "ls-files").split("\n").filter((file) => file.endsWith(".ts")), ["chips.ts"]);
    // Renamed in the folder and told to git with add -N (git says " R"): both paths, not a piece of one.
    room.engine.tableOp({ op: "next", text: "Tags" });
    renameSync(join(ws, "chips.ts"), join(ws, "tags.ts"));
    git(ws, "add", "-N", "tags.ts");
    assert.deepEqual(planStepCommit(room.store.state, room.store.events, "X3").files.map((file) => file.path), ["chips.ts", "tags.ts"]);
  } finally {
    await room.cleanup();
  }
});
