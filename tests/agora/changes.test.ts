import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { roomTurnPatch } from "../../internal/agora/engine.js";
import {
  MAX_TURN_PATCH,
  patchSection,
  prepareWorkspace,
  readTurnPatch,
  snapshotChanges,
  snapshotTree,
  treeChangedPaths,
  treeChanges,
  turnPatchPath,
  writeTurnPatch,
} from "../../internal/agora/workspace.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "../../bin/agoryx-agent.mjs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

test("tree snapshots see tracked, untracked, deleted and binary files — and leave the real index alone", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-tree-"));
  try {
    const paths = prepareWorkspace(root, { initGit: true });
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "gone.txt"), "bye\n");
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    writeFileSync(join(root, "draft.md"), "an untracked draft\n");
    const indexBefore = readFileSync(join(root, ".git", "index"));

    const before = snapshotTree(root)!;
    assert.match(before, /^[0-9a-f]{40}$/);
    writeFileSync(join(root, "a.txt"), "one\n2\nthree\nfour\n");
    rmSync(join(root, "gone.txt"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "new file.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
    writeFileSync(join(paths.agoryxDir, "scratch.txt"), "never part of a turn\n");
    const after = snapshotTree(root)!;

    assert.deepEqual(readFileSync(join(root, ".git", "index")), indexBefore, "the real index is untouched");
    assert.match(git(root, "status", "--porcelain", "--untracked-files=all"), /\?\? "?src\/new file\.ts"?\n/, "nothing got staged");

    const files = ["a.txt", "gone.txt", "src/new file.ts", "blob.bin", "draft.md"];
    const diff = treeChanges(root, before, after, files)!;
    const byPath = Object.fromEntries(diff.changes.map((change) => [change.path, change]));
    assert.deepEqual(byPath["a.txt"], { path: "a.txt", status: "M", added: 2, removed: 1 });
    assert.deepEqual(byPath["gone.txt"], { path: "gone.txt", status: "D", added: 0, removed: 1 });
    assert.deepEqual(byPath["src/new file.ts"], { path: "src/new file.ts", status: "A", added: 1, removed: 0 });
    assert.deepEqual(byPath["blob.bin"], { path: "blob.bin", status: "A", added: null, removed: null });
    assert.equal(byPath["draft.md"], undefined, "a file the turn did not change is not in it");
    assert.equal(diff.truncated, false);
    assert.match(patchSection(diff.patch, "a.txt")!, /^diff --git a\/a\.txt b\/a\.txt\n[^]*-two\n\+2\n three\n\+four\n$/);
    assert.match(patchSection(diff.patch, "src/new file.ts")!, /\+export const x = 1;/);
    assert.equal(patchSection(diff.patch, "draft.md"), null);

    // Only the files credited to the turn: a parallel turn's edits stay out.
    assert.deepEqual(
      treeChanges(root, before, after, ["a.txt"])!.changes.map((change) => change.path),
      ["a.txt"],
    );

    writeTurnPatch(paths, { id: "t3", author: "Codex", ts: "2026-09-28T09:15:00.000Z" }, diff.changes, diff.patch);
    const text = readFileSync(turnPatchPath(paths, "t3")!, "utf8");
    assert.match(text, /^# t3 · Codex · 2026-09-28 09:15 UTC\n#   a\.txt  \+2 −1\n/);
    assert.match(text, /#   gone\.txt  \+0 −1 \(deleted\)\n/);
    assert.match(text, /#   blob\.bin  \(binary\) \(new\)\n/);
    assert.equal(readTurnPatch(paths, "t3")!.patch, diff.patch, "the header is stripped on read");
    assert.equal(turnPatchPath(paths, "../x"), null);

    // Without the file, the trees still have it.
    rmSync(turnPatchPath(paths, "t3")!);
    assert.equal(readTurnPatch(paths, "t3"), null);
    assert.equal(readTurnPatch(paths, "t3", { trees: { before, after }, files })!.patch, diff.patch);

    // A huge change is cut and says how to get the rest.
    writeFileSync(join(root, "big.txt"), "x".repeat(80).concat("\n").repeat(Math.ceil((MAX_TURN_PATCH * 1.5) / 81)));
    const bigger = snapshotTree(root)!;
    const cut = treeChanges(root, after, bigger, ["big.txt"])!;
    assert.equal(cut.truncated, true);
    assert.match(cut.patch, new RegExp(`… the patch is cut here \\(\\d+ more chars\\): git diff ${after.slice(0, 12)} ${bigger.slice(0, 12)}\\n$`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every turn's exact change is kept; the others see +/− and pull the patch with agoryx diff", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        match: "build the clock",
        write: { path: "src/clock.ts", content: "export const now = () => Date.now();\nexport const zero = 0;\n" },
        reply: "Wrote src/clock.ts.",
        once: true,
      },
      {
        agent: "codex",
        match: "Wrote src/clock.ts",
        write: { path: "src/clock.ts", content: "export const now = () => Date.now();\nexport const ZERO = 0;\n" },
        reply: "Renamed zero to ZERO.",
        once: true,
      },
    ],
  });
  try {
    const ws = room.store.state.workspace;
    room.engine.postHuman("@claude build the clock");
    await withTimeout(room.engine.waitIdle());

    const claudeTurn = room.store.state.turns.find((turn) => turn.agent === "claude")!;
    const codexTurn = room.store.state.turns.find((turn) => turn.agent === "codex")!;
    assert.deepEqual(claudeTurn.changes, [{ path: "src/clock.ts", status: "A", added: 2, removed: 0 }]);
    assert.deepEqual(codexTurn.changes, [{ path: "src/clock.ts", status: "M", added: 1, removed: 1 }]);
    const ended = room.store.events.find((event) => event.type === "turn.ended" && event.turnId === claudeTurn.id);
    assert.ok(ended?.type === "turn.ended" && ended.trees && ended.trees.before !== ended.trees.after, "the trees are logged");

    // Codex was woken by Claude's reply: its delta names the change and how to see it.
    const codexPrompt = room.invocations("codex").at(-1)!.prompt!;
    assert.match(codexPrompt, new RegExp(`↳ changed: src/clock\\.ts \\+2 −0 \\(new\\) — the exact diff: agoryx diff ${claudeTurn.id}`));
    assert.match(codexPrompt, /agoryx diff t7` prints that turn's patch/, "the briefing explains the tool");

    // The patch file, and the same thing through the engine.
    const patchFile = join(ws, ".agoryx", "turns", `${claudeTurn.id}.patch`);
    assert.match(readFileSync(patchFile, "utf8"), new RegExp(`^# ${claudeTurn.id} · Claude · `));
    assert.match(room.engine.turnPatch(codexTurn.id)!.patch, /-export const zero = 0;\n\+export const ZERO = 0;/);

    // What an agent runs inside its sandbox.
    const shim = (...args: string[]) => spawnSync(process.execPath, [SHIM, "diff", ...args], { cwd: join(ws, "src"), encoding: "utf8" });
    const listed = shim();
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^${codexTurn.id} · Codex · [^\\n]+\\n {2}src/clock\\.ts {2}\\+1 −1\\n`));
    assert.match(listed.stdout, /src\/clock\.ts {2}\+2 −0 \(new\)/);
    const one = shim(claudeTurn.id, "src/clock.ts");
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /diff --git a\/src\/clock\.ts b\/src\/clock\.ts\n[^]*\+export const zero = 0;/);
    assert.notEqual(shim("t999").status, 0);
    assert.notEqual(shim(claudeTurn.id, "nope.ts").status, 0);

    // Claude, woken by Codex's reply, sees Codex's change — and not its own again.
    const claudePrompt = room.invocations("claude").find((entry) => entry.prompt!.includes("Renamed zero to ZERO."))!.prompt!;
    assert.match(claudePrompt, new RegExp(`src/clock\\.ts \\+1 −1 — the exact diff: agoryx diff ${codexTurn.id}`));
    assert.doesNotMatch(claudePrompt, new RegExp(`agoryx diff ${claudeTurn.id}\\b`));

    // Losing .agoryx/turns loses nothing: the trees in the log rebuild it.
    rmSync(join(ws, ".agoryx", "turns"), { recursive: true });
    assert.match(roomTurnPatch(room.store, claudeTurn.id)!.patch, /\+export const zero = 0;/);
    assert.equal(roomTurnPatch(room.store, "t999"), null);
  } finally {
    await room.cleanup();
  }
});

test("a pass that changed files is still reported, with its changes", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "codex", match: "tidy", write: { path: "notes.md", content: "tidied\n" }, reply: "::pass::", once: true },
    ],
  });
  try {
    room.engine.postHuman("@codex tidy up");
    await withTimeout(room.engine.waitIdle());
    const codexTurn = room.store.state.turns.find((turn) => turn.agent === "codex")!;
    assert.deepEqual(codexTurn.changes, [{ path: "notes.md", status: "A", added: 1, removed: 0 }]);
    room.engine.postHuman("@claude what happened?");
    await withTimeout(room.engine.waitIdle());
    const prompt = room.invocations("claude").at(-1)!.prompt!;
    assert.match(prompt, /── Codex · \d\d:\d\d · passed, after changing files\n {3}↳ changed: notes\.md \+1 −0 \(new\)/);
    assert.doesNotMatch(prompt, /\(Codex passed\)/);
  } finally {
    await room.cleanup();
  }
});

test("work an agent commits during its turn is still that turn's change", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "codex",
        match: "ship",
        write: { path: "shipped.ts", content: "export const shipped = true;\n" },
        git: [["add", "shipped.ts"], ["commit", "-qm", "ship it"]],
        reply: "Committed shipped.ts.",
        once: true,
      },
    ],
  });
  try {
    room.engine.postHuman("@codex ship it");
    await withTimeout(room.engine.waitIdle());
    const codexTurn = room.store.state.turns.find((turn) => turn.agent === "codex")!;
    assert.deepEqual(codexTurn.changes, [{ path: "shipped.ts", status: "A", added: 1, removed: 0 }]);
    assert.match(room.engine.turnPatch(codexTurn.id)!.patch, /\+export const shipped = true;/);
  } finally {
    await room.cleanup();
  }
});

test("a workspace inside a larger repo sees only its own files, by paths relative to itself", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-sub-"));
  try {
    git(root, "init", "-q");
    const ws = join(root, "app");
    mkdirSync(ws);
    writeFileSync(join(ws, "a.txt"), "one\n");
    writeFileSync(join(root, "outside.txt"), "out\n");
    const before = snapshotTree(ws)!;
    writeFileSync(join(ws, "a.txt"), "one\ntwo\n");
    writeFileSync(join(ws, "b.txt"), "new\n");
    writeFileSync(join(root, "outside.txt"), "changed\n");
    writeFileSync(join(root, "also-outside.txt"), "x\n");
    assert.deepEqual([...snapshotChanges(ws)!.keys()].sort(), ["a.txt", "b.txt"]);
    const after = snapshotTree(ws)!;
    assert.deepEqual(treeChangedPaths(ws, before, after), ["a.txt", "b.txt"]);
    const diff = treeChanges(ws, before, after, ["a.txt", "b.txt"])!;
    assert.deepEqual(
      diff.changes.map((change) => [change.path, change.status, change.added, change.removed]),
      [["a.txt", "M", 1, 0], ["b.txt", "A", 1, 0]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn that changed nothing has no changes and no patch", async () => {
  const room = createTestRoom();
  try {
    room.engine.postHuman("Hello both");
    await withTimeout(room.engine.waitIdle());
    for (const turn of room.store.state.turns) {
      assert.equal(turn.changes, undefined);
      assert.equal(room.engine.turnPatch(turn.id), null);
    }
    assert.equal(existsSync(join(room.store.state.workspace, ".agoryx", "turns")), false);
  } finally {
    await room.cleanup();
  }
});
