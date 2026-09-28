import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diffHunks, diffLines, docHash, normalizeDocPath, renderDiff } from "../../internal/agora/doc.js";
import { DocConflictError } from "../../internal/agora/engine.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const waitUntil = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("canonical file paths stay inside the workspace and out of .git / .agoryx", () => {
  assert.equal(normalizeDocPath("README.md"), "README.md");
  assert.equal(normalizeDocPath("./notes//time.md"), "notes/time.md");
  assert.equal(normalizeDocPath("../outside.md"), null);
  assert.equal(normalizeDocPath("/etc/passwd"), null);
  assert.equal(normalizeDocPath(".git/config"), null);
  assert.equal(normalizeDocPath(".agoryx/TABLE.md"), null);
  assert.equal(normalizeDocPath("  "), null);
});

test("line diff: changed lines with a little context, the rest collapsed", () => {
  const before = ["# Time", "", "a", "b", "c", "d", "e", "f", "g"].join("\n");
  const after = ["# Time", "", "a", "b", "c", "D", "e", "f", "g", "h"].join("\n");
  const lines = diffLines(before, after);
  assert.deepEqual(
    lines.filter((line) => line.t !== " "),
    [
      { t: "-", s: "d" },
      { t: "+", s: "D" },
      { t: "+", s: "h" },
    ],
  );
  const hunks = diffHunks(lines, 1);
  assert.deepEqual(hunks[0], { skip: 4 });
  assert.equal(renderDiff("same\n", "same\n"), null);
  assert.match(renderDiff(before, after)!, /^ {2}… 3 unchanged lines\n {2}b\n {2}c\n- d\n\+ D\n/);
  assert.match(renderDiff("", "x\n".repeat(200), 10)!, /190 more diff lines — read the file/);
});

test("every change to the canonical file is kept with its author, and the others get the diff", async () => {
  const room = createTestRoom({
    settings: { doc: "README.md" },
    rules: [
      {
        agent: "claude",
        match: "draft",
        write: { path: "README.md", content: "# Time\n\nTime is what clocks measure.\n" },
        reply: "Drafted README.md.",
        once: true,
      },
    ],
  });
  try {
    const readme = join(room.store.state.workspace, "README.md");
    room.engine.postHuman("Hello both");
    await withTimeout(room.engine.waitIdle());
    assert.equal(room.store.state.docRevisions.length, 0, "nothing to record while the file does not exist");

    room.engine.postHuman("@claude draft the doc");
    await withTimeout(room.engine.waitIdle());
    const [drafted] = room.store.state.docRevisions;
    assert.equal(drafted!.by, "claude");
    assert.ok(drafted!.turnId, "credited to the turn that made it");
    assert.deepEqual([drafted!.added, drafted!.removed], [3, 0]);

    // Codex was woken by Claude's reply: its delta carries the diff, not the whole file.
    const codexPrompt = room.invocations("codex").at(-1)!.prompt!;
    assert.match(codexPrompt, /README\.md \(the room's canonical file\) changed since your last turn — Claude \+3 −0/);
    assert.match(codexPrompt, /~~~~diff\n\+ # Time\n\+ \n\+ Time is what clocks measure\.\n~~~~/);

    // The human edits it in the UI; a stale base is refused with the current text.
    const current = readFileSync(readme, "utf8");
    assert.throws(
      () => room.engine.writeDocument("# Time\n\nsomething else\n", docHash("stale")),
      (error: unknown) => error instanceof DocConflictError && error.current?.text === current,
    );
    const edited = room.engine.writeDocument("# Time\n\nTime is what clocks measure, and what they cannot.\n", docHash(current));
    assert.equal(edited!.by, "Ivan");
    assert.equal(edited!.turnId, undefined);
    assert.equal(room.store.state.runs.at(-1)!.status, "ended", "an edit wakes nobody");

    // …and then in an editor, outside the room: the sync tick records it as the human's.
    writeFileSync(readme, "# Time\n\nTime is what clocks measure, and what they cannot.\n\nOpen: is it fundamental?\n");
    await waitUntil(() => room.store.state.docRevisions.length === 3);
    assert.equal(room.store.state.docRevisions[2]!.by, "Ivan");

    room.engine.postHuman("Thoughts?");
    await withTimeout(room.engine.waitIdle());
    const claudePrompt = room.invocations("claude").at(-1)!.prompt!;
    assert.match(claudePrompt, /changed since your last turn — Ivan \(human\) \+3 −1\n/);
    assert.match(claudePrompt, /- Time is what clocks measure\.\n\+ Time is what clocks measure, and what they cannot\.\n\+ \n\+ Open: is it fundamental\?/);
    const codexAgain = room.invocations("codex").at(-1)!.prompt!;
    assert.match(codexAgain, /— Ivan \(human\) \+3 −1\n/);
    assert.doesNotMatch(codexAgain, /Claude \+3/, "what it already saw is not repeated");
  } finally {
    await room.cleanup();
  }
});

test("the briefing names the canonical file; choosing one records the version the room found", async () => {
  const room = createTestRoom();
  try {
    writeFileSync(join(room.store.state.workspace, "essay.md"), "# On time\n");
    room.engine.updateSettings({ doc: "./essay.md" });
    assert.equal(room.store.state.settings.doc, "essay.md");
    const [baseline] = room.store.state.docRevisions;
    assert.equal(baseline!.by, "agoryx");
    assert.ok(room.store.state.messages.some((message) => message.kind === "system" && /canonical file is now essay\.md/.test(message.text)));
    assert.throws(() => room.engine.updateSettings({ doc: "../x.md" }), /inside the workspace/);

    room.engine.postHuman("Hello both");
    await withTimeout(room.engine.waitIdle());
    const first = room.invocations("claude")[0]!.prompt!;
    assert.match(first, /The room's canonical file: essay\.md/);
    assert.match(first, /essay\.md \(the room's canonical file\): 1 line, last changed by nobody yet/);
  } finally {
    await room.cleanup();
  }
});

test("in a blind round the canonical file is credited only to the turn that wrote it", async () => {
  const room = createTestRoom({
    settings: { doc: "README.md" },
    rules: [
      { agent: "claude", match: "essay", write: { path: "README.md", content: "# Time\n\nA first draft.\n" }, reply: "Drafted it.", once: true },
      { agent: "codex", match: "essay", sleepMs: 800, reply: "My take, before reading anything.", once: true },
    ],
  });
  try {
    room.engine.postHuman("Write an essay on time");
    await withTimeout(room.engine.waitIdle());
    const [revision] = room.store.state.docRevisions;
    assert.equal(revision!.by, "claude");
    const codexTurn = room.store.state.turns.find((turn) => turn.agent === "codex")!;
    const claudeTurn = room.store.state.turns.find((turn) => turn.id === revision!.turnId)!;
    assert.ok(codexTurn.startedAt <= claudeTurn.endedAt!, "the two turns overlapped");
    assert.equal(codexTurn.files?.includes("README.md") ?? false, false, "Codex did not write it");
  } finally {
    await room.cleanup();
  }
});

test("the human's edit never writes through a symlink out of the workspace", async () => {
  const outside = mkdtempSync(join(tmpdir(), "agora-outside-"));
  const room = createTestRoom({ settings: { doc: "notes/doc.md" } });
  try {
    const ws = room.store.state.workspace;
    symlinkSync(outside, join(ws, "notes"));
    assert.throws(() => room.engine.writeDocument("pwned\n", docHash("")), /inside the workspace/);
    assert.equal(existsSync(join(outside, "doc.md")), false);

    room.engine.updateSettings({ doc: "doc.md" });
    symlinkSync(join(outside, "target.md"), join(ws, "doc.md"));
    assert.throws(() => room.engine.writeDocument("pwned\n", docHash("")), /inside the workspace/);
    assert.equal(existsSync(join(outside, "target.md")), false, "a dangling link is not followed either");
  } finally {
    await room.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});
