import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { passNote } from "../../internal/agora/prompts.js";
import { unwrapShellCommand } from "../../internal/agora/runners/codex.js";
import { parseTableCommand, TableCommandError } from "../../internal/agora/table-cli.js";
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
    const seen: InboxOp[] = [];
    drainOpsInbox(paths, (op) => seen.push(op));
    assert.deepEqual(
      seen.map((op) => `${op.agent}:${op.raw.text}`),
      ["codex:orphaned", "claude:fresh"],
    );
    assert.deepEqual(readdirSync(paths.opsDir), [`claude.jsonl.${process.ppid}.1.taking`]);

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
