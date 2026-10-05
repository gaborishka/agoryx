import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePatchFiles } from "../../ui/node_modules/@pierre/diffs/dist/index.js";
import { parseMentions } from "../../internal/agora/prompts.js";
import { pickedLines } from "../../ui/src/lib/diff-quote.js";
import { quoteMarkdown } from "../../ui/src/lib/quote.js";

// Parse the real renderer's input; the expected line numbers below come from the patch itself.
const patch = [
  "diff --git a/a.py b/a.py",
  "--- a/a.py",
  "+++ b/a.py",
  "@@ -10,4 +10,5 @@",
  " alpha",
  "-    old_one()",
  "-    old_two()",
  "+    new_one()",
  "+    new_two()",
  "+    new_three()",
  " omega",
  "@@ -30,2 +31,2 @@",
  " before",
  "-old_tail",
  "+new_tail",
  "",
].join("\n");
const file = parsePatchFiles(patch)[0]!.files[0]!;

test("added and deleted selections use their own file's line numbers and keep indentation", () => {
  assert.deepEqual(pickedLines(file, { start: 11, end: 13, side: "additions" }), {
    text: "+    new_one()\n+    new_two()\n+    new_three()",
    lines: "+11–13",
  });
  assert.deepEqual(pickedLines(file, { start: 11, end: 12, side: "deletions" }), {
    text: "-    old_one()\n-    old_two()",
    lines: "-11–12",
  });
});

test("selection across old and new sides retains both coordinate ranges", () => {
  const picked = pickedLines(file, { start: 11, end: 13, side: "deletions", endSide: "additions" })!;
  assert.equal(picked.text, "-    old_one()\n-    old_two()\n+    new_one()\n+    new_two()\n+    new_three()");
  assert.match(picked.lines, /old[^\d]*11–12/i);
  assert.match(picked.lines, /new[^\d]*11–13/i);
  assert.deepEqual(pickedLines(file, { start: 13, end: 11, side: "additions", endSide: "deletions" }), picked);
});

test("context after a replacement has different old and new line numbers", () => {
  const old = pickedLines(file, { start: 13, end: 13, side: "deletions" })!;
  const neu = pickedLines(file, { start: 14, end: 14, side: "additions" })!;
  assert.equal(old.text, " omega");
  assert.equal(neu.text, " omega");
  assert.match(old.lines, /old[^\d]*13/i);
  assert.match(neu.lines, /new[^\d]*14/i);
});

test("later hunks resolve absolute coordinates; hidden or nonexistent endpoints are rejected", () => {
  assert.deepEqual(pickedLines(file, { start: 32, end: 32, side: "additions" }), { text: "+new_tail", lines: "+32" });
  assert.deepEqual(pickedLines(file, { start: 31, end: 31, side: "deletions" }), { text: "-old_tail", lines: "-31" });
  assert.equal(pickedLines(file, { start: 20, end: 20, side: "additions" }), null);
  assert.equal(pickedLines(file, { start: 0, end: 1, side: "deletions" }), null);
});

test("a diff citation preserves its turn and encoded file source without activating quoted recipients", () => {
  const sent = quoteMarkdown({
    id: "t7",
    author: "claude",
    label: "Claude",
    text: "-    ask('@all')\n+    ask('@ivan')",
    file: { path: "dir/a [review](2).py", lines: "old 11; new 11" },
  });
  assert.ok(sent.includes("#t7/dir%2Fa%20%5Breview%5D%282%29.py"));
  assert.ok(sent.includes("old 11; new 11"));
  assert.ok(sent.includes("-    ask('@all')"));
  assert.deepEqual(parseMentions(`${sent}\n\n@codex, review this.`, ["claude", "codex", "ivan"]), ["codex"]);
});
