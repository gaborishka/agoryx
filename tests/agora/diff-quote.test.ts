import assert from "node:assert/strict";
import { test } from "node:test";
// The diff parser lives with the UI, which has its own node_modules.
import { parsePatchFiles } from "../../ui/node_modules/@pierre/diffs/dist/index.js";
import { parseMentions } from "../../internal/agora/prompts.js";
import { pickedLines } from "../../ui/src/lib/diff-quote.js";
import { quoteKey, quoteMarkdown, withQuotes } from "../../ui/src/lib/quote.js";

const patch = `diff --git a/x.py b/x.py
index 1111111..2222222 100644
--- a/x.py
+++ b/x.py
@@ -1,5 +1,6 @@
 def ready(queue):
-    for job in queue:
+    for job in list(queue):
+        log(job)
         if job.done:
             continue
         run(job)
`;
const file = parsePatchFiles(patch).flatMap((p) => p.files)[0]!;

test("picked added lines keep their marks and indentation, named by new-file numbers", () => {
  assert.deepEqual(pickedLines(file, { start: 2, side: "additions", end: 3, endSide: "additions" }), {
    text: "+    for job in list(queue):\n+        log(job)",
    lines: "+2–3",
  });
});

test("a removed line is named by its old-file number", () => {
  assert.deepEqual(pickedLines(file, { start: 2, side: "deletions", end: 2, endSide: "deletions" }), { text: "-    for job in queue:", lines: "-2" });
});

test("a range across removed, added and context lines keeps the patch order", () => {
  const picked = pickedLines(file, { start: 2, side: "deletions", end: 4, endSide: "additions" });
  assert.equal(picked?.text, "-    for job in queue:\n+    for job in list(queue):\n+        log(job)\n         if job.done:");
});

test("a selection upward is the same lines", () => {
  assert.deepEqual(
    pickedLines(file, { start: 3, side: "additions", end: 2, endSide: "additions" }),
    pickedLines(file, { start: 2, side: "additions", end: 3, endSide: "additions" }),
  );
});

test("a line outside the patch picks nothing", () => {
  assert.equal(pickedLines(file, { start: 40, side: "additions", end: 41 }), null);
});

test("diff lines are quoted as a diff fence under the turn and file, and their @handles stay inert", () => {
  const md = quoteMarkdown({ id: "t7", author: "codex", label: "Codex", text: "+    say('@all')\n-    @claude", file: { path: "src/[a] (b).py", lines: "2–3" } });
  assert.equal(md.split("\n")[0], "> [Codex · t7 · src/\\[a\\] (b).py 2–3](#t7/src%2F%5Ba%5D%20%28b%29.py)");
  assert.ok(md.includes("> ```diff\n> +    say('@all')\n> -    @claude\n> ```"));
  assert.deepEqual(parseMentions(withQuotes("@codex why list()?", [{ id: "t7", author: "codex", label: "Codex", text: "+@ivan", file: { path: "x.py", lines: "+2" } }]), ["codex", "claude", "ivan"]), ["codex"]);
});

test("the same lines from two files of one turn are two quotes; the same lines twice are one", () => {
  const a = { id: "t7", author: "codex", label: "Codex", text: "+run()", file: { path: "a.py", lines: "+2" } };
  assert.notEqual(quoteKey(a), quoteKey({ ...a, file: { path: "b.py", lines: "+2" } }));
  assert.notEqual(quoteKey(a), quoteKey({ ...a, file: { path: "a.py", lines: "+9" } }));
  assert.notEqual(quoteKey(a), quoteKey({ id: "t7", author: "codex", label: "Codex", text: "+run()" }));
  assert.equal(quoteKey(a), quoteKey({ ...a, file: { ...a.file } }));
});
