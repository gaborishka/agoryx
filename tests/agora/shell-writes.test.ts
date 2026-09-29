import assert from "node:assert/strict";
import { test } from "node:test";
import { namesFile, shellWrites, shellWriteTargets } from "../../internal/agora/shell-writes.js";
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
    ["cd sub && cp ../a.txt b.txt && rm -f old.txt", ["sub/b.txt", "sub/old.txt"]],
    ["(cd sub && echo x > b.txt); echo y > c.txt", ["sub/b.txt", "c.txt"]],
    ["cd sub/deep && echo x > ../b.txt && echo y > ./c.txt", ["sub/b.txt", "sub/deep/c.txt"]],
    ["cd lib && python3 -c \"open('out.json', 'w').write('{}')\"", ["lib/out.json"]],
    ["cd $DIR && echo x > b.txt; echo y > /tmp/z.txt", ["/tmp/z.txt"]],
    ["cd && touch b.txt", []],
    ["npm test > /dev/null 2>&1; echo done", []],
    ["git diff HEAD~1 -- src/x.ts", []],
    ["grep -n 'a > b' file.ts", []],
    ["for f in *.ts; do sed -i 's/a/b/' $f; done", []],
  ];
  for (const [command, written] of cases) assert.deepEqual(shellWriteTargets(command).sort(), written.sort(), command);
  assert.ok(namesFile("src/b.ts", "src/b.ts"));
  assert.ok(namesFile("src/b.ts", "./src/b.ts"));
  assert.ok(!namesFile("b.txt", "sub/b.txt"), "a file at the root is not one of the same name in a folder");
  assert.ok(!namesFile("b.txt", "sub/ab.txt"));
  // Claude Code keeps a `cd` for the commands after it: the next command starts where the last one left the shell.
  const first = shellWrites("cd sub && ls", "");
  assert.equal(first.cwd, "sub");
  assert.deepEqual(shellWrites("echo x > b.txt", first.cwd).targets, ["sub/b.txt"]);
  assert.equal(shellWrites("(cd sub && ls)", "").cwd, "", "a subshell's cd ends with it");
  assert.equal(shellWrites("cd ~/x", "").cwd, null);
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

test("in parallel turns a long script's write at its very end is still read — from the whole command, not its clipped label", async () => {
  const edits = Array.from({ length: 40 }, (_, i) => `s=s.replace('const v${i} = ${i};', 'const v${i} = ${i + 1};')`).join("\n");
  const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path('src/kvl.js')\ns=p.read_text()\n${edits}\np.write_text(s)\nPY`;
  assert.ok(command.length > 1500, "longer than any label is kept");
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "parser", sleepMs: 1200, reply: "Auditing the spec.", once: true },
      {
        agent: "codex",
        match: "parser",
        sleepMs: 200,
        command,
        write: { path: "src/kvl.js", content: "export const parse = () => ({});\n", via: "shell" },
        reply: "Patched src/kvl.js.",
        once: true,
      },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("Fix the parser");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("claude").startedAt < turn("codex").endedAt!, "the turns ran in parallel");
    assert.deepEqual(turn("codex").files, ["src/kvl.js"]);
    assert.ok(!turn("claude").files?.length, "not the other agent's");
    const labels = turn("codex").activity.filter((activity) => activity.kind === "command");
    assert.ok(labels.every((activity) => activity.label.length <= 200 && !("command" in activity)), "the stored trace keeps only the clipped label");
  } finally {
    await room.cleanup();
  }
});

test("a file a turn wrote itself before and after a parallel turn ended is its whole change, not just the part after", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        match: "semver",
        earlyWrite: { path: "semver.ts", content: "a\nb\nc\n" },
        sleepMs: 1500,
        write: { path: "semver.ts", content: "a\nB\nc\nd\n" },
        reply: "Wrote semver.ts.",
        once: true,
      },
      { agent: "codex", match: "semver", sleepMs: 200, write: { path: "semver.test.ts", content: "t\n" }, reply: "Tests in.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("Implement semver");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("codex").endedAt! < turn("claude").endedAt!, "Claude changed it again after Codex had ended");
    assert.deepEqual(turn("claude").changes, [{ path: "semver.ts", status: "A", added: 4, removed: 0 }]);
    assert.deepEqual(turn("codex").changes, [{ path: "semver.test.ts", status: "A", added: 1, removed: 0 }]);
  } finally {
    await room.cleanup();
  }
});
