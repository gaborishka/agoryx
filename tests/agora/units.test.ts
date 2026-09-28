import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { passNote } from "../../internal/agora/prompts.js";
import { unwrapShellCommand } from "../../internal/agora/runners/codex.js";
import { parseTableCommand, TableCommandError } from "../../internal/agora/table-cli.js";
import { resolveInside } from "../../internal/agora/workspace.js";

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
