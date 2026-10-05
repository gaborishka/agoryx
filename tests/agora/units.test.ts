import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { passNote } from "../../internal/agora/prompts.js";
import { unwrapShellCommand } from "../../internal/agora/runners/codex.js";
import { parseTableCommand, TableCommandError } from "../../internal/agora/table-cli.js";
import { applyTableOp, disputeOf, emptyTable, openOnTable, prepareTableOp, renderTableMarkdown, summarizeTable, TableOpError } from "../../internal/agora/table.js";
import { createRoom } from "../../internal/agora/service.js";
import { drainOpsInbox, resolveInside, workspacePaths, type InboxOp } from "../../internal/agora/workspace.js";

test("passNote: the pass token, with or without a short reason, is silence", () => {
  assert.equal(passNote("::pass::"), "");
  assert.equal(passNote("  `::pass::` "), "");
  assert.equal(passNote("::pass:: — nothing to add"), "nothing to add");
  assert.equal(passNote("**::PASS::** agreed"), "agreed");
  assert.equal(passNote(""), "");
  assert.equal(passNote("I think we should ::pass:: later"), null);
  assert.equal(passNote(`::pass:: ${"x".repeat(400)}`), null, "a long reply is a message, not a pass");
});

test("unwrapShellCommand strips the login-shell wrapper Codex reports", () => {
  assert.equal(unwrapShellCommand("/bin/zsh -lc 'ls -a'"), "ls -a");
  assert.equal(unwrapShellCommand("bash -c 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(unwrapShellCommand('/bin/bash -lc "git status \\"x\\""'), 'git status "x"');
  assert.equal(unwrapShellCommand("python3 -m unittest"), "python3 -m unittest");
});

test("parseTableCommand maps the agent CLI onto table ops", () => {
  assert.deepEqual(parseTableCommand("ask", ["Which", "storage?"]), { op: "ask", text: "Which storage?" });
  assert.deepEqual(parseTableCommand("propose", ["SQLite", "--body", "one file", "--q", "Q1"]), {
    op: "propose",
    title: "SQLite",
    body: "one file",
    q: "Q1",
  });
  assert.deepEqual(parseTableCommand("propose", ["JSONL", "append", "only"]), { op: "propose", title: "JSONL", body: "append only" });
  assert.deepEqual(parseTableCommand("object", ["P1", "locks", "under", "load", "--source=bench.txt"]), {
    op: "object",
    target: "P1",
    text: "locks under load",
    source: "bench.txt",
  });
  assert.deepEqual(parseTableCommand("decide", ["P2", "--note", "simplest"]), { op: "decide", target: "P2", note: "simplest" });
  assert.deepEqual(parseTableCommand("done", ["X1"]), { op: "done", target: "X1" });
  assert.deepEqual(parseTableCommand("settle", ["relational", "time", "--q", "Q2"]), { op: "settle", text: "relational time", q: "Q2" });
  assert.deepEqual(parseTableCommand("settle", ["done"]), { op: "settle", text: "done" });
  assert.deepEqual(parseTableCommand("concede", ["I", "overstated", "it", "--on", "P1"]), { op: "concede", text: "I overstated it", target: "P1" });
  assert.throws(() => parseTableCommand("concede", ["--on", "P1"]), TableCommandError);
  assert.throws(() => parseTableCommand("support", ["P1"]), TableCommandError);
  assert.throws(() => parseTableCommand("ask", []), TableCommandError);
  assert.throws(() => parseTableCommand("vote", ["P1"]), TableCommandError);
});

test("resolveInside keeps paths in the workspace, through symlinks too", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-resolve-"));
  const outside = mkdtempSync(join(tmpdir(), "agora-outside-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(outside, "secret"), "");
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "secret"), join(root, "src", "secret"));
    assert.ok(resolveInside(root, "src/a.ts")?.endsWith("/src/a.ts"));
    assert.ok(resolveInside(root, "./src/../src/a.ts")?.endsWith("/src/a.ts"));
    assert.equal(resolveInside(root, "../etc/passwd"), null);
    assert.equal(resolveInside(root, "/etc/passwd"), null);
    assert.equal(resolveInside(root, "link/secret"), null);
    assert.equal(resolveInside(root, "src/secret"), null);
    assert.equal(resolveInside(root, "src/missing.ts"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("table ops taken by a process that died before applying them are picked up again", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-ops-"));
  try {
    const paths = workspacePaths(root);
    mkdirSync(paths.opsDir, { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(paths.opsDir, `codex.jsonl.${dead}.1.taking`), `${JSON.stringify({ op: "ask", text: "orphaned" })}\n`);
    // Another live process is still working on this one: left alone.
    writeFileSync(join(paths.opsDir, `claude.jsonl.${process.ppid}.1.taking`), `${JSON.stringify({ op: "ask", text: "busy" })}\n`);
    writeFileSync(join(paths.opsDir, "claude.jsonl"), `${JSON.stringify({ op: "ask", text: "fresh" })}\n`);
    // An op the agent tool never finished writing: one long left is gone, one being written now is left to it.
    writeFileSync(join(paths.opsDir, "1-1-old.codex.op.tmp"), "{");
    utimesSync(join(paths.opsDir, "1-1-old.codex.op.tmp"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    writeFileSync(join(paths.opsDir, "2-2-new.codex.op.tmp"), "{");
    const seen: InboxOp[] = [];
    // The dead process's file is claimed (renamed) before it is applied, so a drain beside this one cannot take it too.
    const claimed: boolean[] = [];
    drainOpsInbox(paths, (op) => {
      seen.push(op);
      claimed.push(!existsSync(join(paths.opsDir, `codex.jsonl.${dead}.1.taking`)));
    });
    assert.deepEqual(
      seen.map((op) => `${op.agent}:${op.raw.text}`),
      ["codex:orphaned", "claude:fresh"],
    );
    assert.deepEqual(claimed, [true, true]);
    assert.deepEqual(readdirSync(paths.opsDir).sort(), ["2-2-new.codex.op.tmp", `claude.jsonl.${process.ppid}.1.taking`]);

    // A file whose ops could not all be applied stays, and is applied on the next drain.
    writeFileSync(join(paths.opsDir, "codex.jsonl"), `${JSON.stringify({ op: "ask", text: "retry" })}\n`);
    assert.throws(() => drainOpsInbox(paths, () => { throw new Error("crash"); }));
    const again: InboxOp[] = [];
    drainOpsInbox(paths, (op) => again.push(op));
    assert.deepEqual(again.map((op) => op.raw.text), ["retry"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ops many agents send while the room drains its inbox all reach it, each once, in the order each agent sent them", async () => {
  const root = mkdtempSync(join(tmpdir(), "agora-ops-"));
  try {
    const paths = workspacePaths(root);
    const agentTool = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agoryx-agent.mjs");
    const writers = 6;
    const each = 12;
    // Each agent sends its ops one after another; nobody acks, so the tool says "queued" right away.
    const sender = `const { execFileSync } = require("node:child_process"); for (let i = 0; i < ${each}; i++) execFileSync(process.execPath, [${JSON.stringify(agentTool)}, "table", "fact", process.argv[1] + "-" + i]);`;
    let running = writers;
    for (let w = 0; w < writers; w++) {
      const child = spawn(process.execPath, ["-e", sender, String(w)], {
        cwd: root,
        env: { PATH: process.env.PATH, AGORYX_AGENT: `w${w}`, AGORYX_OPS_DIR: paths.opsDir, AGORYX_ACK_MS: "1" },
        stdio: "ignore",
      });
      child.on("exit", () => (running -= 1));
    }
    const seen: string[] = [];
    const take = () => drainOpsInbox(paths, ({ agent, raw }) => seen.push(`${agent} ${String(raw.text)}`));
    while (running > 0) {
      take();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    take();
    assert.equal(seen.length, writers * each);
    for (let w = 0; w < writers; w++) {
      assert.deepEqual(seen.filter((entry) => entry.startsWith(`w${w} `)), Array.from({ length: each }, (_, i) => `w${w} ${w}-${i}`));
    }
    assert.deepEqual(readdirSync(paths.opsDir).filter((name) => name !== "acks"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty directory the human names stays theirs: no git init, no default document, no auto-commit", () => {
  const home = mkdtempSync(join(tmpdir(), "agora-home-"));
  try {
    const dir = join(home, "mine");
    mkdirSync(dir);
    const store = createRoom({ name: "Mine", dir, env: { ...process.env, AGORYX_HOME: home } });
    assert.equal(store.state.createdWorkspace, false);
    assert.equal(store.state.settings.autoCommit, false);
    assert.equal(store.state.settings.doc, null);
    assert.equal(existsSync(join(dir, ".git")), false);
    assert.equal(existsSync(join(dir, "README.md")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a step marked done by someone else says who did it — the table never reads as if its author closed it", () => {
  const table = emptyTable();
  applyTableOp(table, { op: "next", text: "write down the chosen semantics", by: "claude", id: "X1" }, 1);
  applyTableOp(table, { op: "next", text: "run the suite", by: "codex", id: "X2" }, 2);
  applyTableOp(table, { op: "next", text: "note the edge cases", by: "claude", id: "X3" }, 3);
  applyTableOp(table, { op: "review", target: "X1", by: "claude" }, 4);
  applyTableOp(table, { op: "done", target: "X1", by: "codex" }, 5);
  applyTableOp(table, { op: "done", target: "X2", by: "codex" }, 6);
  applyTableOp(table, { op: "done", target: "X3", by: "codex" }, 7);
  assert.equal(table.next[0]!.doneBy, "codex");
  const md = renderTableMarkdown(table, "room");
  assert.match(md, /- ~~X1: write down the chosen semantics~~ \(claude; done by codex\) — checked$/m);
  // Its author marked it done: nobody else checked it.
  assert.match(md, /- ~~X2: run the suite~~ \(codex\) — done without a check$/m);
  // Someone else marked it done, but no check was asked for: it was closed, not checked.
  assert.match(md, /- ~~X3: note the edge cases~~ \(claude; done by codex\) — done without a check$/m);
});

test("a point one agent settled can be objected to by another: contested until the objector or its author concedes on it", () => {
  const table = emptyTable();
  let seq = 0;
  const move = (raw: Record<string, unknown>, by: string, isHuman = false) => applyTableOp(table, prepareTableOp(table, raw, by, isHuman), (seq += 1));
  move({ op: "settle", text: "else.x resolves in the outer scope" }, "codex");
  move({ op: "fact", text: "ref passes 208/208" }, "codex");
  for (let index = 0; index < 5; index += 1) move({ op: "settle", text: `later point ${index + 1}` }, "codex");
  // In loop 28 Claude still disputed Codex's S1 and was told "no option S1 on the table".
  move({ op: "object", target: "S1", text: "I was still reviewing; else.x is ambiguous" }, "claude");
  assert.equal(table.notes[0]!.target, "S1");
  assert.deepEqual(disputeOf(table, table.settled[0]!), ["claude"]);
  assert.equal(openOnTable(table).disputes, 1);
  const md = renderTableMarkdown(table, "room");
  assert.match(md, /- S1: else\.x resolves in the outer scope \(codex\) — contested by claude\n  - ✗ objection \(claude\): I was still reviewing/);
  // An old contested point stays in the summary even when newer ones push it out of the last four.
  assert.match(summarizeTable(table)!, /settled: S1 "else\.x resolves in the outer scope" — contested by claude; S3/);
  // Its author gives it up by conceding, not by objecting to it.
  assert.throws(() => prepareTableOp(table, { op: "object", target: "S1", text: "hm" }, "codex", false), /S1 is your own — concede .* --on S1 instead/);
  assert.throws(() => prepareTableOp(table, { op: "object", target: "F1", text: "hm" }, "codex", false), /F1 is your own fact — withdraw F1/);
  move({ op: "support", target: "F1", text: "reran it: 208/208" }, "claude");
  assert.match(renderTableMarkdown(table, "room"), /- F1: ref passes 208\/208 \(codex\)\n  - ✓ support \(claude\): reran it/);
  assert.throws(() => prepareTableOp(table, { op: "object", target: "Q9", text: "no" }, "claude", false), /no Q9 on the table to object — it takes an option \(P1\), a step \(X1\), a settled point \(S1\) or a fact \(F1\)/);
  assert.throws(() => prepareTableOp(table, { op: "object", target: "X9", text: "no" }, "claude", false), /no step X9 on the table/);
  assert.throws(() => prepareTableOp(table, { op: "object", target: "P9", text: "no" }, "claude", false), /no option P9 on the table/);
  // The objector concedes on it: common ground again.
  move({ op: "concede", target: "S1", text: "outer scope is what Handlebars does" }, "claude");
  assert.deepEqual(disputeOf(table, table.settled[0]!), []);
  assert.doesNotMatch(renderTableMarkdown(table, "room"), /contested/);
  // A new objection, and this time the author gives the point up.
  move({ op: "object", target: "S2", text: "not settled" }, "claude");
  assert.equal(openOnTable(table).disputes, 1);
  move({ op: "concede", target: "S2", text: "fair, it is open" }, "codex");
  assert.equal(openOnTable(table).disputes, 0);
});

test("a fact that turned out wrong is withdrawn by its author: struck out, not gone, and no longer counted as a fact", () => {
  const table = emptyTable();
  const note = (text: string, by: string) => applyTableOp(table, prepareTableOp(table, { op: "fact", text }, by, false), table.facts.length + 1);
  note("npm test: 27 tests pass", "claude");
  note("npm test: 26 tests pass", "claude");
  // In loop 24 Claude reached for `done` to take a wrong fact back; the answer now says how.
  assert.throws(() => prepareTableOp(table, { op: "done", target: "F1" }, "claude", false), (error: unknown) => error instanceof TableOpError && /F1 is a fact; to take it back: withdraw F1/.test(error.message));
  assert.throws(() => prepareTableOp(table, { op: "withdraw", target: "F1" }, "codex", false), /F1 was noted by claude; only they can withdraw it/);
  applyTableOp(table, prepareTableOp(table, { op: "withdraw", target: "F1" }, "claude", false), 3);
  assert.equal(table.facts[0]!.withdrawn, true);
  assert.throws(() => prepareTableOp(table, { op: "withdraw", target: "F1" }, "claude", false), /already withdrawn/);
  assert.match(renderTableMarkdown(table, "room"), /- ~~F1: npm test: 27 tests pass~~ \(claude; withdrawn\)/);
  assert.match(summarizeTable(table)!, /facts: F2 "npm test: 26 tests pass"$/m);
  // The human may take back anyone's.
  applyTableOp(table, prepareTableOp(table, { op: "withdraw", target: "F2" }, "Ivan", true), 4);
  assert.equal(table.facts[1]!.withdrawn, true);
});

test("a question asked with --many keeps its other options open when one is chosen, and closes when none is left", () => {
  const table = emptyTable();
  let seq = 0;
  const move = (raw: Record<string, unknown>, by: string, isHuman = false) => applyTableOp(table, prepareTableOp(table, raw, by, isHuman), (seq += 1));
  move({ op: "ask", text: "What to take from T3 next?", many: true }, "claude");
  move({ op: "propose", title: "Quote chips", q: "Q1" }, "claude");
  move({ op: "propose", title: "Diff comments", q: "Q1" }, "claude");
  move({ op: "settle", text: "P1 then P2", q: "Q1" }, "codex");
  // On a --many question a settled point recommends; it does not close the question.
  assert.equal(table.questions[0]!.status, "open");
  move({ op: "decide", target: "P1" }, "ivan", true);
  assert.equal(table.questions[0]!.status, "open");
  assert.equal(table.options[1]!.status, "open");
  assert.match(summarizeTable(table)!, /Q1 open \(any number can be chosen\).*chosen so far: P1/);
  move({ op: "decide", target: "P2" }, "ivan", true);
  assert.equal(table.questions[0]!.status, "decided");
  // Un-choosing one opens the question again.
  move({ op: "reopen", target: "P1" }, "ivan", true);
  assert.equal(table.questions[0]!.status, "open");
});

test("a one-answer question still closes on the first choice; edit --many turns it into a list before anyone chooses", () => {
  const table = emptyTable();
  let seq = 0;
  const move = (raw: Record<string, unknown>, by: string, isHuman = false) => applyTableOp(table, prepareTableOp(table, raw, by, isHuman), (seq += 1));
  move({ op: "ask", text: "Which storage?" }, "claude");
  move({ op: "propose", title: "SQLite" }, "claude");
  move({ op: "propose", title: "JSONL" }, "codex");
  assert.throws(() => move({ op: "edit", target: "Q1", many: true }, "codex"), /claude's; only they can rewrite it/);
  move({ op: "edit", target: "Q1", many: true }, "claude");
  assert.equal(table.questions[0]!.many, true);
  move({ op: "decide", target: "P1" }, "ivan", true);
  assert.equal(table.questions[0]!.status, "open");
  assert.throws(() => move({ op: "edit", target: "Q1", many: false }, "claude"), /already has chosen options/);
});

test("agents rewrite and delete their own items; deleted ids are never given out again", () => {
  const table = emptyTable();
  let seq = 0;
  const move = (raw: Record<string, unknown>, by: string, isHuman = false) => {
    const op = prepareTableOp(table, raw, by, isHuman);
    applyTableOp(table, op, (seq += 1));
    return op;
  };
  move({ op: "ask", text: "What next?" }, "claude");
  move({ op: "propose", title: "Quote chips", body: "old", q: "Q1" }, "claude");
  move({ op: "propose", title: "Resize panels", q: "Q1" }, "codex");
  move({ op: "object", target: "P1", text: "too small" }, "codex");

  move({ op: "edit", target: "P1", text: "P1: Quote and diff chips", body: "one mechanism" }, "claude");
  assert.equal(table.options[0]!.title, "Quote and diff chips");
  assert.equal(table.options[0]!.body, "one mechanism");
  assert.throws(() => move({ op: "edit", target: "P2", text: "mine now" }, "claude"), /codex's/);
  assert.throws(() => move({ op: "edit", target: "P1", many: true }, "claude"), /P1 has no many to change/);
  // The human can rewrite anyone's item.
  move({ op: "edit", target: "P2", text: "Resizable panels" }, "ivan", true);
  assert.equal(table.options[1]!.title, "Resizable panels");

  assert.throws(() => move({ op: "delete", target: "P2" }, "claude"), /codex's; only they can delete it/);
  const deleted = move({ op: "delete", target: "P1" }, "claude");
  assert.equal(deleted.op === "delete" && deleted.was, "Quote and diff chips");
  assert.deepEqual(table.options.map((o) => o.id), ["P2"]);
  // Its objection went with it.
  assert.equal(table.notes.length, 0);
  // P1 is not given out again, and neither is N1.
  assert.equal(move({ op: "propose", title: "Slash commands" }, "claude").id, "P3");
  assert.equal(move({ op: "support", target: "P3", text: "daily use" }, "codex").id, "N2");

  // Deleting a question leaves its options as proposals of their own.
  move({ op: "delete", target: "Q1" }, "claude");
  assert.equal(table.questions.length, 0);
  assert.equal(table.options.find((o) => o.id === "P2")!.q, null);
  assert.equal(move({ op: "ask", text: "Again" }, "claude").id, "Q2");

  // A chosen option has to be reopened before it can go.
  move({ op: "decide", target: "P2" }, "ivan", true);
  assert.throws(() => move({ op: "delete", target: "P2" }, "codex"), /chosen; reopen it first/);

  // Deleting the settled point that answered a question opens the question again.
  move({ op: "settle", text: "Answer", q: "Q2" }, "codex");
  assert.equal(table.questions[0]!.status, "answered");
  move({ op: "delete", target: "S1" }, "codex");
  assert.equal(table.questions[0]!.status, "open");
  assert.match(renderTableMarkdown(table, "room"), /## Q2 · Again/);
});

test("parseTableCommand reads --many and --one as switches, and edit/delete", () => {
  assert.deepEqual(parseTableCommand("ask", ["--many", "What", "next?"]), { op: "ask", text: "What next?", many: true });
  assert.deepEqual(parseTableCommand("edit", ["Q1", "--one"]), { op: "edit", target: "Q1", many: false });
  assert.deepEqual(parseTableCommand("edit", ["P2", "New", "title", "--q", "Q3"]), { op: "edit", target: "P2", text: "New title", q: "Q3" });
  assert.deepEqual(parseTableCommand("delete", ["S1"]), { op: "delete", target: "S1" });
  assert.throws(() => parseTableCommand("edit", []), TableCommandError);
  assert.throws(() => parseTableCommand("edit", ["Q1", "--many", "--one"]), TableCommandError);
});
