import assert from "node:assert/strict";
import { test } from "node:test";
import { namesFile, shellWriteTargets } from "../../internal/agora/shell-writes.js";
import { createTestRoom, withTimeout } from "./helpers.js";

test("a shell command's written files are the ones it names: redirections, tee, sed -i, cp/mv/rm, a script's own writes", () => {
  const cases: Array<[string, string[]]> = [
    ["cat > lru.ts <<'EOF' export class LRU { get(k) { if (a > b) return x; } } EOF", ["lru.ts"]],
    ["cat >> lru.test.ts <<'EOF' test('x', () => assert.ok(a > 1)) EOF && npm test 2>&1 | tail -5", ["lru.test.ts"]],
    ["python3 - <<'EOF' p='lru.ts'; s=open(p).read(); open(p,'w').write(s.replace('a','b')) EOF", ["lru.ts"]],
    ["python3 -c \"from pathlib import Path; Path('out/r.md').write_text('x')\"", ["out/r.md"]],
    ["node -e \"require('fs').writeFileSync('out.json', '{}')\"", ["out.json"]],
    ["sed -i '' 's/a/b/;s/c/d/' src/b.ts", ["src/b.ts"]],
    ["sed -i -e 's/x/y/' a.ts b.ts", ["a.ts", "b.ts"]],
    ["echo hi | tee -a notes.md >/dev/null", ["notes.md"]],
    ["cd sub && cp ../a.txt b.txt && rm -f old.txt", ["b.txt", "old.txt"]],
    ["npm test > /dev/null 2>&1; echo done", []],
    ["git diff HEAD~1 -- src/x.ts", []],
    ["grep -n 'a > b' file.ts", []],
    ["for f in *.ts; do sed -i 's/a/b/' $f; done", []],
  ];
  for (const [command, written] of cases) assert.deepEqual(shellWriteTargets(command).sort(), written.sort(), command);
  assert.ok(namesFile("./src/b.ts", "src/b.ts"));
  assert.ok(namesFile("b.txt", "sub/b.txt"), "after a cd");
  assert.ok(!namesFile("b.txt", "sub/ab.txt"));
});

test("in parallel turns a file an agent's own shell command wrote is credited to it, not to nobody", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "cache", sleepMs: 1200, reply: "Reading the spec first.", once: true },
      {
        agent: "codex",
        match: "cache",
        sleepMs: 200,
        command: "cat > lru.ts <<'EOF'\nexport const lru = () => new Map();\nEOF",
        write: { path: "lru.ts", content: "export const lru = () => new Map();\n", via: "shell" },
        reply: "Wrote lru.ts.",
        once: true,
      },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("Fix the cache");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("claude").startedAt < turn("codex").endedAt!, "the turns ran in parallel");
    assert.deepEqual(turn("codex").files, ["lru.ts"]);
    assert.ok(!turn("claude").files?.length, "not the other agent's");
  } finally {
    await room.cleanup();
  }
});
