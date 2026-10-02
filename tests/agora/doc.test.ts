import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diffHunks, diffLines, docHash, normalizeDocPath, renderDiff } from "../../internal/agora/doc.js";
import { DocConflictError } from "../../internal/agora/engine.js";
import { createRoom } from "../../internal/agora/service.js";
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

test("a large file with scattered edits diffs in bounded memory and still shows only the edits", () => {
  const before = Array.from({ length: 40_000 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[10] = "changed near the top";
  after[20_000] = "changed in the middle";
  after.splice(39_990, 1);
  const started = Date.now();
  const lines = diffLines(before.join("\n"), after.join("\n"));
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(
    lines.filter((line) => line.t !== " "),
    [
      { t: "-", s: "line 10" },
      { t: "+", s: "changed near the top" },
      { t: "-", s: "line 20000" },
      { t: "+", s: "changed in the middle" },
      { t: "-", s: "line 39990" },
    ],
  );
  assert.equal(lines.filter((line) => line.t !== "+").length, before.length);
  // a rewrite of everything falls back to remove-all / add-all instead of an enormous table
  const rewrite = diffLines(before.join("\n"), before.map((line) => `${line}!`).join("\n"));
  assert.equal(rewrite.length, before.length * 2);
});

test("every change to the canonical file is kept with its author, and the others get the diff", async () => {
  const room = createTestRoom({
    settings: { doc: "README.md" },
    rules: [
      {
        agent: "claude",
        match: "draft",
        write: { path: "README.md", content: "# Time\n\nTime is what clocks measure.\n" },
        reply: "Drafted README.md. @codex have a look.",
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

    // Codex was woken by Claude's reply (@codex): its delta carries the diff, not the whole file.
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

test("a new room has no canonical file, even in a folder Agoryx creates", () => {
  const home = mkdtempSync(join(tmpdir(), "agora-nodoc-"));
  const env = { ...process.env, AGORYX_HOME: home, AGORYX_HUMAN: "Ivan" };
  try {
    const room = createRoom({ name: "Fresh", env });
    assert.equal(room.state.settings.doc, null);
    assert.equal(existsSync(join(room.state.workspace, "README.md")), false);
    assert.equal(createRoom({ name: "Named", env, doc: "PLAN.md" }).state.settings.doc, "PLAN.md");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("without a canonical file the agents are told they can name one; an agent naming it is said by name", async () => {
  const room = createTestRoom();
  try {
    room.engine.postHuman("Hello both");
    await withTimeout(room.engine.waitIdle());
    const prompt = room.invocations("claude")[0]!.prompt!;
    assert.match(prompt, /The room has no canonical file\. .*any of you\n  can name it: `agoryx settings --doc <path>`/s);

    writeFileSync(join(room.store.state.workspace, "PLAN.md"), "# Plan\n");
    room.engine.updateSettings({ doc: "PLAN.md" }, "codex");
    assert.equal(room.store.state.settings.doc, "PLAN.md");
    assert.ok(room.store.state.messages.some((message) => /Codex changed the settings: canonical file PLAN\.md/.test(message.text)));
    room.engine.postHuman("And now?");
    await withTimeout(room.engine.waitIdle());
    const after = room.invocations("claude").at(-1)!.prompt!;
    // The next turn is told what changed: who named it, and the file as the room found it.
    assert.match(after, /Codex changed the settings: canonical file PLAN\.md\./);
    assert.match(after, /PLAN\.md \(the room's canonical file\) changed since your last turn/);
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

test("an edit made after the parallel turn ended is the remaining turn's, whatever tool made it", async () => {
  const room = createTestRoom({
    settings: { doc: "README.md" },
    rules: [
      { agent: "claude", match: "essay", write: { path: "README.md", content: "# Time\n\nA first draft.\n" }, reply: "Drafted it.", once: true },
      // Codex reworks the draft with a script once Claude's turn is over (its reply is in the room), as a shell command would.
      { agent: "codex", match: "essay", waitForText: "Drafted it.", write: { path: "README.md", content: "# Time\n\nA sharper draft.\n", via: "shell" }, reply: "Tightened it.", once: true },
    ],
  });
  try {
    room.engine.postHuman("Write an essay on time");
    await withTimeout(room.engine.waitIdle());
    const { docRevisions, turns } = room.store.state;
    assert.deepEqual(
      docRevisions.map((revision) => revision.by),
      ["claude", "codex"],
      "no revision is put on the human",
    );
    const codexTurn = turns.find((turn) => turn.agent === "codex")!;
    assert.equal(docRevisions[1]!.turnId, codexTurn.id);
    assert.deepEqual(codexTurn.files, ["README.md"]);
    // Its patch starts from Claude's draft, not from before Claude wrote it.
    assert.deepEqual(codexTurn.changes?.map((change) => [change.path, change.status, change.added, change.removed]), [["README.md", "M", 1, 1]]);
    assert.match(room.engine.turnPatch(codexTurn.id)!.patch, /-A first draft\.\n\+A sharper draft\./);
  } finally {
    await room.cleanup();
  }
});

test("an edit no one can be credited with during parallel turns is recorded as theirs, not the human's", async () => {
  const room = createTestRoom({
    settings: { doc: "README.md" },
    rules: [
      { agent: "claude", match: "essay", sleepMs: 1200, reply: "Thinking it over.", once: true },
      { agent: "codex", match: "essay", sleepMs: 200, write: { path: "README.md", content: "# Time\n\nA draft.\n", via: "shell" }, reply: "Drafted it.", once: true },
    ],
  });
  try {
    room.engine.postHuman("Write an essay on time");
    await withTimeout(room.engine.waitIdle());
    const revision = room.store.state.docRevisions.at(-1)!;
    assert.deepEqual(revision.among?.sort(), ["claude", "codex"]);
    assert.equal(revision.turnId, undefined);
    assert.equal(room.store.state.docRevisions.some((entry) => entry.by === room.store.state.human), false);
    // Claude's reply woke Codex: that prompt says so too, rather than naming one of them.
    assert.match(room.invocations("codex").at(-1)!.prompt!, /changed since your last turn — Claude or Codex \(parallel turns, whose is not known\) \+3 −0/);
  } finally {
    await room.cleanup();
  }
});

test("a big rewrite of the canonical file is cut in the prompt; the agent reads the file", async () => {
  const room = createTestRoom({ settings: { doc: "README.md" } });
  try {
    const paragraph = (n: number) => `Paragraph ${n}: ${"time ".repeat(80)}`;
    const text = `${Array.from({ length: 40 }, (_, i) => paragraph(i)).join("\n\n")}\n`;
    // Both have sessions by now, so the next prompt is a delta, not a briefing.
    room.engine.postHuman("Hello both");
    await withTimeout(room.engine.waitIdle());
    room.engine.writeDocument(text, docHash(""));
    room.engine.postHuman("@claude thoughts?");
    await withTimeout(room.engine.waitIdle());
    const prompt = room.invocations("claude").at(-1)!.prompt!;
    assert.match(prompt, /… the rest of this diff is cut \(\d+ chars in all\) — read README\.md for the whole file\n~~~~/);
    assert.ok(prompt.length < 12_000, `the prompt stays thin (${prompt.length} chars)`);
  } finally {
    await room.cleanup();
  }
});

test("a human save while a turn runs is the human's revision, not part of the turn's changes", async () => {
  const room = createTestRoom({
    settings: { doc: "README.md" },
    rules: [
      { agent: "claude", match: "think", sleepMs: 900, reply: "Thought about it.", once: true },
      { agent: "codex", match: "think", sleepMs: 900, reply: "Me too.", once: true },
    ],
  });
  try {
    room.engine.postHuman("think about it");
    await waitUntil(() => room.store.state.turns.some((turn) => turn.status === "running"));
    const current = room.engine.readDocument()!;
    room.engine.writeDocument("# Mine\n\nThe human wrote this.\n", current.hash);
    await withTimeout(room.engine.waitIdle());
    const revision = room.store.state.docRevisions.at(-1)!;
    assert.equal(revision.by, "Ivan");
    assert.equal(revision.turnId, undefined);
    for (const turn of room.store.state.turns) {
      assert.equal(turn.files?.includes("README.md") ?? false, false, `${turn.agent} did not write it`);
      assert.equal(turn.changes?.some((change) => change.path === "README.md") ?? false, false);
    }
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
