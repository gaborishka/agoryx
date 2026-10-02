import assert from "node:assert/strict";
import { homedir } from "node:os";
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
    ["cd && touch b.txt", [`${homedir()}/b.txt`]],
    ["cd ~bob && touch b.txt", []],
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
  assert.equal(shellWrites("cd ~/x", "").cwd, `${homedir()}/x`);
  assert.equal(shellWrites("cd ~bob", "").cwd, null);
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


// The commands are P10's own (room iaki-nastupni-zminy-v-ui-agoryx-potribno-d4ea), shortened, with its workspace as WS.
const WS = "/Users/x/.local/state/agoryx/agora/worktrees/agoryx-iaki-nastupni-zminy-v-ui-agoryx-potribno-d4ea";
const helper = (cwd: string) =>
  [
    `cd ${cwd}/ui/src && python3 - <<'EOF'`,
    "def edit(p, pairs):",
    "    s=open(p).read()",
    "    for a,b in pairs:",
    "        assert s.count(a)==1, (p,a); s=s.replace(a,b)",
    "    open(p,'w').write(s)",
    "edit('components/common/ResizeHandle.tsx', [",
    "('''export const ROOM_MIN = 520;''','''export const ROOM_MIN = 520;",
    "export const browserWidth = (viewport: number) => Math.round(Math.min(760, viewport * 0.52));'''),",
    "])",
    "edit('App.tsx', [",
    "('''  const panelOpen = useStore((s) => s.panel !== null);''','''  const panel = useStore((s) => s.panel);'''),",
    "])",
    "EOF",
    'grep -n "overlay\\b.*phone\\|phone ?" components/panel/SidePanel.tsx | head -5; cd .. && npm run build 2>&1 | grep -E "error|built in"',
  ].join("\n");
const sed = (cwd: string) => `cd ${cwd}/ui/src && grep -n "laid out 1280" components/panel/SidePanel.tsx && sed -i '' 's|  // The room|  // Docked, the room|' components/panel/SidePanel.tsx`;
const outside = "set -e; cd /tmp/agx-pr27\nsed -i '' 's/^- Compared Agoryx UI with local T3 Code/- Compared Agoryx UI with another local coding UI/' bridge/LOG.md\ngit diff --stat";
const back = "sed -i '' 's/^- Compared Agoryx UI with local T3 Code/- Compared Agoryx UI with another local coding UI/' bridge/LOG.md; git diff --stat";

test("P10's shell edits: a python helper's calls, a cd by the workspace's path, a newline between commands, a variable given a new path", () => {
  // t15: an absolute cd into ui/src, the helper's edit() writing what each call names, then `cd ..`.
  const first = shellWrites(helper(WS), "", [WS]);
  assert.deepEqual(first.targets.sort(), ["ui/src/App.tsx", "ui/src/components/common/ResizeHandle.tsx"]);
  assert.equal(first.cwd, "ui");
  // From ui, `cd <workspace>/ui/src` is ui/src again, not ui/ui/src.
  assert.deepEqual(shellWrites(sed(WS), first.cwd, [WS]).targets, ["ui/src/components/panel/SidePanel.tsx"]);
  assert.equal(shellWrites(`cd ${WS}`, "sub", [WS]).cwd, "");
  assert.deepEqual(shellWrites(`echo x > ${WS}/a/b.txt`, "", [WS]).targets, ["a/b.txt"]);
  // t24: lines are commands, as ; ends one; the checkout outside stays outside.
  const away = shellWrites(outside, "", [WS]);
  assert.deepEqual(away.targets, ["/tmp/agx-pr27/bridge/LOG.md"]);
  assert.equal(away.cwd, "/tmp/agx-pr27");
  // t13: one variable, two paths: each write is the path it had then.
  const reassigned = `cd ${WS} && python3 - <<'EOF'\np='ui/src/App.tsx'\ns=open(p).read()\nopen(p,'w').write(s)\np='ui/src/lib/store.ts'\ns=open(p).read()\ndef rep(a,b):\n    global s\n    s=s.replace(a,b)\nopen(p,'w').write(s)\nEOF`;
  assert.deepEqual(shellWrites(reassigned, "", [WS]).targets.sort(), ["ui/src/App.tsx", "ui/src/lib/store.ts"]);
  // A comment is not a command; a line continued is one.
  assert.deepEqual(shellWrites("cd sub\n# echo x > nope.txt\nsed -i 's/a/b/' x.ts", "", [WS]).targets, ["sub/x.ts"]);
  assert.deepEqual(shellWrites("echo a \\\n  > cont.txt", "", [WS]).targets, ["cont.txt"]);
  // A helper's path given by keyword or by a variable; a helper that only reads writes nothing.
  const kw = `python3 - <<'EOF'\nimport pathlib\ndef save(text, path=None):\n    pathlib.Path(path).write_text(text)\ndef show(p):\n    print(open(p).read())\nf='notes.md'\nsave('x', path='out.md')\nsave('y', f)\nshow('README.md')\nEOF`;
  assert.deepEqual(shellWrites(kw, "", [WS]).targets.sort(), ["notes.md", "out.md"]);
});

test("in parallel turns Claude's shell edits are its own: a python helper, sed -i after a cd by path, a cd out of the workspace and back (P10's t15, t24)", async () => {
  const files = ["ui/src/App.tsx", "ui/src/components/common/ResizeHandle.tsx", "ui/src/components/panel/SidePanel.tsx", "bridge/LOG.md"];
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        match: "browser",
        // Each reported when it starts and when it ends, as Claude Code does; the last one runs where Claude Code took the shell back to.
        commands: [helper("{cwd}"), sed("{cwd}"), outside, back],
        write: files.map((path) => ({ path, content: `${path}\n`, via: "shell" })),
        reply: "Docked the browser at its own width.",
        once: true,
      },
      { agent: "codex", match: "browser", waitForText: "Docked the browser", write: { path: "ui/src/components/room/Composer.tsx", content: "send\n" }, reply: "Fixed send.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("Dock the browser panel at its own width");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("claude").endedAt! < turn("codex").endedAt!, "Claude ended while Codex still worked");
    assert.deepEqual([...(turn("claude").files ?? [])].sort(), [...files].sort());
    assert.deepEqual(turn("codex").files, ["ui/src/components/room/Composer.tsx"]);
  } finally {
    await room.cleanup();
  }
});

test("heredocs: the body is the lines up to the delimiter's own; the opener's line stays shell; a body for cat is data, one for python is run", () => {
  const cases: Array<[string, string[]]> = [
    // The rest of the opener's line is shell: its redirect is the file.
    ["cat <<'EOF' > out.txt\nhello > not-a-file.txt\nEOF", ["out.txt"]],
    ["cat <<\\EOF > a.txt\nhi\nEOF\ntouch after.txt", ["a.txt", "after.txt"]],
    ["cat > notes.md <<'END-DOC'\nrun: echo x > nope.txt\nEND-DOC\necho y > after.txt", ["after.txt", "notes.md"]],
    ["cat > notes.md <<-\"EOF\"\n\tsome text\n\tEOF\necho y > after.txt", ["after.txt", "notes.md"]],
    // The delimiter as a word inside a line does not end the body.
    ["cat <<'EOF' > out.txt\nwe stop at EOF here; echo x > nope.txt\nEOF\ntouch done.txt", ["done.txt", "out.txt"]],
    // An empty body; a here-string is no heredoc.
    ["cat <<EOF > empty.txt\nEOF\necho z > z.txt", ["empty.txt", "z.txt"]],
    ["grep x <<< \"a\" > found.txt", ["found.txt"]],
    // Two on one line: the second's body follows the first's.
    ["paste <(cat) <<A > p.txt <<B\none > x\nA\ntwo > y\nB\ntouch q.txt", ["p.txt", "q.txt"]],
    // A script written to a file is not run: its helper's calls write nothing. Fed to python, they do.
    ["cat > tool.py <<'EOF'\ndef edit(p):\n    open(p, 'w').write('x')\nedit('victim.txt')\nEOF", ["tool.py"]],
    ["python3 - <<'EOF'\ndef edit(p):\n    open(p, 'w').write('x')\nedit('victim.txt')\nEOF", ["victim.txt"]],
    ["cat <<'EOF' | python3\nopen('piped.txt', 'w').write('x')\nEOF", ["piped.txt"]],
  ];
  for (const [command, written] of cases) assert.deepEqual(shellWriteTargets(command).sort(), written, command);
});

test("python helpers: type hints and nested brackets in a def, a parameter given a new value, self.p, a def replaced", () => {
  const py = (body: string) => `python3 - <<'EOF'\n${body}\nEOF`;
  const cases: Array<[string, string[]]> = [
    // Brackets in hints and defaults neither break the parse nor move positions.
    [py("def edit(p: dict[str, tuple[int,int]], pairs=[[1,2]]) -> None:\n    open(p, 'w').write('x')\nedit('a.txt', [[1, 2]])"), ["a.txt"]],
    [py("def edit(pairs: list[tuple[str, str]], p: str):\n    open(p, 'w').write('x')\nedit([('a', 'b')], 'b.txt')"), ["b.txt"]],
    [py("def edit(p, /, *, mode='w'):\n    open(p, 'w').write('x')\nedit('c.txt', mode='a')"), ["c.txt"]],
    // A parameter given another path is not what the call gave it; as a Path it still is.
    [py("def save(path):\n    path = 'backup.json'\n    open(path, 'w').write('{}')\nsave('out.json')"), []],
    [py("from pathlib import Path\ndef save(path):\n    path = Path(path)\n    path.write_text('{}')\nsave('out.json')"), ["out.json"]],
    // An attribute of the same name is another thing.
    [py("p = 'cfg.json'\nclass A:\n    def go(self):\n        self.p.write_text('x')"), []],
    // Calls after a def of the same name are the new one's.
    [py("def w(p):\n    open(p, 'w').write('x')\nw('one.txt')\ndef w(p):\n    print(p)\nw('two.txt')"), ["one.txt"]],
  ];
  for (const [command, written] of cases) assert.deepEqual(shellWriteTargets(command).sort(), written, command);
});

test("cd: a line continued, back into the workspace from outside it, and commands the parser cannot finish do not throw or hang", () => {
  const WS = "/work/ws";
  assert.deepEqual(shellWrites("cd \\\n  sub && echo x > b.txt", "", [WS]).targets, ["sub/b.txt"]);
  // From a folder outside, a relative cd can come back in.
  const away = shellWrites("cd /work/other", "", [WS]);
  assert.equal(away.cwd, "/work/other");
  assert.deepEqual(shellWrites("cd ../ws/ui && echo x > a.ts", away.cwd, [WS]).targets, ["ui/a.ts"]);
  for (const command of [
    "python3 - <<'EOF'\ndef f(a: dict[str, (int, int)], b=[[1, 2]], *args, c: 'x[', **kw):\n    open(b, 'w')\nf(1, 'q.txt')\nEOF",
    "python3 - <<'EOF'\ndef f(a=']'\nEOF",
    "cat <<'E(F' > x.txt\nbody\nE(F",
  ])
    assert.doesNotThrow(() => shellWriteTargets(command), command);
  const started = Date.now();
  shellWriteTargets(`python3 - <<'EOF'\ndef a(${"x, ".repeat(100_000)}\nEOF`);
  shellWriteTargets(`python3 - <<'EOF'\n${"def a(\n".repeat(20_000)}EOF`);
  shellWriteTargets(`cd a && ${"cd b && ".repeat(5_000)}python3 -c "${"open('x', 'w'); ".repeat(2_000)}"`);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("in parallel turns Claude's shell is read once per command, goes back to the workspace after leaving it, and a label is not read without its cwd", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        match: "fix",
        // Each reported when it starts and when it ends: `cd ui` moves the shell once.
        // After a cd to a folder the command does not name, its sed's y.ts could be anywhere: not the root's.
        commands: ["cd ui", "sed -i '' 's/a/b/' x.ts", "cd /tmp/elsewhere", "cd lib", "sed -i '' 's/a/b/' f.ts", 'cd "$PKG"', "sed -i '' 's/a/b/' y.ts"],
        write: [
          { path: "ui/x.ts", content: "b\n", via: "shell" },
          { path: "lib/f.ts", content: "b\n", via: "shell" },
          { path: "y.ts", content: "b\n", via: "shell" },
        ],
        reply: "Fixed both.",
        once: true,
      },
      // Codex changes a file at the root with the same name as Claude's in ui.
      { agent: "codex", match: "fix", waitForText: "Fixed both", write: { path: "x.ts", content: "root\n" }, reply: "Fixed the root one.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("fix x.ts");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("claude").endedAt! < turn("codex").endedAt!, "Claude ended while Codex still worked");
    assert.deepEqual([...(turn("claude").files ?? [])].sort(), ["lib/f.ts", "ui/x.ts"]);
    assert.deepEqual(turn("codex").files, ["x.ts"]);
  } finally {
    await room.cleanup();
  }
});

test("in parallel turns a live Claude process keeps its shell's cd into its next turn", async () => {
  const room = createTestRoom({
    live: true,
    rules: [
      { agent: "claude", match: "step one", commands: ["cd ui"], reply: "In ui.", once: true },
      { agent: "codex", match: "step one", reply: "::pass::", once: true },
      { agent: "claude", match: "step two", commands: ["sed -i '' 's/a/b/' x.ts"], write: { path: "ui/x.ts", content: "b\n", via: "shell" }, reply: "Edited x.", once: true },
      { agent: "codex", match: "step two", waitForText: "Edited x", write: { path: "root.ts", content: "r\n" }, reply: "Edited root.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("step one");
    await withTimeout(room.engine.waitIdle());
    room.engine.postHuman("step two");
    await withTimeout(room.engine.waitIdle());
    // The turns that answered step two (each agent passes after the other's answer).
    const answered = (agent: string) => room.store.state.turns.filter((entry) => entry.agent === agent && entry.status === "ok").at(-1)!;
    assert.ok(answered("claude").endedAt! < answered("codex").endedAt!, "Claude ended while Codex still worked");
    assert.deepEqual(answered("claude").files, ["ui/x.ts"]);
    assert.deepEqual(answered("codex").files, ["root.ts"]);
  } finally {
    await room.cleanup();
  }
});

test("a shift is no heredoc, nor a << in quotes; one inside \"$(…)\" is", () => {
  const cases: Array<[string, string[]]> = [
    ["echo $((1<<4)) > out.txt", ["out.txt"]],
    ["head -c $((1 << 20)) /dev/urandom > blob.bin", ["blob.bin"]],
    ["x=$((n << shift)); echo $x > n.txt\ntouch m.txt", ["m.txt", "n.txt"]],
    ['node -e "console.log(1<<3)" > x.txt && touch y.txt', ["x.txt", "y.txt"]],
    ["python3 -c 'print(a<<b)' > p.txt\ntouch q.txt\nb", ["p.txt", "q.txt"]],
    // A commit message's heredoc in a command substitution: its lines are the message, not commands.
    ["git commit -m \"$(cat <<'EOF'\nrm stale.txt; echo > nope.txt\nEOF\n)\" && touch done.txt", ["done.txt"]],
    // An apostrophe in a comment does not open a quote.
    ["# don't\npython3 - <<'EOF'\nopen('a.txt', 'w')\nEOF", ["a.txt"]],
  ];
  for (const [command, written] of cases) assert.deepEqual(shellWriteTargets(command).sort(), written, command);
});

test("a script written to a file and then run is read for its writes; one only written is not", () => {
  const cases: Array<[string, string[]]> = [
    ["cat > /tmp/fix.py <<'EOF'\nopen('src/app.ts','w').write('x')\nEOF\npython3 /tmp/fix.py", ["/tmp/fix.py", "src/app.ts"]],
    ["tee run.js <<'EOF' >/dev/null\nrequire('fs').writeFileSync('out.json', '{}')\nEOF\nnode run.js", ["out.json", "run.js"]],
    ["cat <<'EOF' > ./gen.ts\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('gen.json', '[]')\nEOF\nnpx tsx gen.ts && rm gen.ts", ["gen.json", "gen.ts"]],
    ["cat > notes.py <<'EOF'\nopen('x.txt', 'w')\nEOF\ncat notes.py", ["notes.py"]],
  ];
  for (const [command, written] of cases) assert.deepEqual(shellWriteTargets(command).sort(), written, command);
});

test("cd: home, up out of the workspace and back in, after if/then, and a subshell's cd ends with it for a script after it", () => {
  const WS = "/work/ws";
  assert.deepEqual(shellWrites("cd .. && cd ws/ui && echo x > a.ts", "", [WS]).targets, ["ui/a.ts"]);
  assert.equal(shellWrites("cd ..", "", [WS]).cwd, "/work");
  assert.deepEqual(shellWrites("cd ../other && touch b.txt", "", [WS]).targets, ["/work/other/b.txt"]);
  assert.deepEqual(shellWrites("if [ -d ui ]; then cd ui; fi\nsed -i '' 's/a/b/' App.tsx", "", [WS]).targets, ["ui/App.tsx"]);
  assert.deepEqual(shellWrites("if [ -d ui ]; then cd ui; fi\npython3 - <<'EOF'\nopen('App.tsx', 'w')\nEOF", "", [WS]).targets, ["ui/App.tsx"]);
  assert.deepEqual(shellWrites("(cd ui && make)\npython3 - <<'EOF'\nopen('a.txt','w')\nEOF", "", [WS]).targets, ["a.txt"]);
  assert.deepEqual(shellWrites("x=$(cd ui && pwd); python3 -c \"open('b.txt', 'w')\"", "", [WS]).targets, ["b.txt"]);
  assert.deepEqual(shellWrites("echo 'cd ui'; python3 -c \"open('c.txt', 'w')\"", "", [WS]).targets, ["c.txt"]);
  assert.deepEqual(shellWrites("cd $HOME_DIR\npython3 -c \"open('d.txt', 'w')\"", "", [WS]).targets, []);
});

test("python: the forms that give a parameter or a name another value", () => {
  const py = (body: string) => `python3 - <<'EOF'\n${body}\nEOF`;
  const cases: Array<[string, string[]]> = [
    [py("def save(path):\n    path += '.bak'\n    open(path, 'w')\nsave('a.json')"), []],
    [py("def save(path: str):\n    path: str = other()\n    open(path, 'w')\nsave('a.json')"), []],
    [py("def save(path):\n    for path in glob('*.json'):\n        open(path, 'w')\nsave('a.json')"), []],
    [py("def save(path):\n    with open('x') as path:\n        open(path, 'w')\nsave('a.json')"), []],
    [py("def save(path):\n    if (path := pick()):\n        open(path, 'w')\nsave('a.json')"), []],
    // A keyword argument in a call is no new value.
    [py("def save(path):\n    log(path=path)\n    open(path, 'w')\nsave('a.json')"), ["a.json"]],
    // At the top, the last value before a write is the one it has: a path, then something else.
    [py("p = 'a.txt'\np = choose()\nopen(p, 'w')"), []],
    [py("p = 'a.txt'\np += '.bak'\nopen(p, 'w')"), []],
    [py("p = 'a.txt'; q = 'b.txt'\nopen(q, 'w')"), ["b.txt"]],
  ];
  for (const [command, written] of cases) assert.deepEqual(shellWriteTargets(command).sort(), written, command);
});

test("heredocs and helpers the parser is made to read at length stay fast", () => {
  const big = `cat > data.json <<'EOF'\n${'{"a": 1}\n'.repeat(9_500)}EOF`;
  const blank = `cat > data.txt <<'EOF'\n${"x\n".repeat(45_000)}EOF\ncd ui && touch z.ts`;
  const params = Array.from({ length: 400 }, (_, j) => `a${j}`).join(", ");
  let nested = "python3 - <<'EOF'\n";
  for (let i = 0; i < 200; i += 1) nested += `${" ".repeat(i)}def f${i}(${params}):\n`;
  nested += `${" ".repeat(200)}open(a0, 'w')\n${"f0('x.txt')\n".repeat(500)}EOF`;
  const timed = (command: string) => {
    const started = Date.now();
    const targets = shellWriteTargets(command);
    return { targets, ms: Date.now() - started };
  };
  for (const [command, written] of [
    [big, ["data.json"]],
    [blank, ["data.txt", "ui/z.ts"]],
    [`cat ${"<<A ".repeat(24_900)}`, []],
    [`cat ${"<<A ".repeat(24_900)}\n`, []],
    [`${"cat <<A\nA\n".repeat(5_000)}touch t.txt`, ["t.txt"]],
    [nested, []],
    [`python3 - <<'EOF'\ndef w(p):\n    open(p, 'w')\n${"w(".repeat(49_000)}\nEOF`, []],
  ] as Array<[string, string[]]>) {
    const { targets, ms } = timed(command);
    assert.deepEqual(targets.sort(), written, command.slice(0, 60));
    assert.ok(ms < 1_000, `${command.slice(0, 40)}… took ${ms} ms`);
  }
});

test("what the reader was made slow by stays fast: options of a script run, a loop's names, a helper called with many arguments", () => {
  const scripts = Array.from({ length: 50 }, (_, n) => `cat > f${n}.py <<'EOF'\nx\nEOF\n`).join("");
  let nested = "python3 - <<'EOF'\n";
  for (let i = 0; i < 25; i += 1) nested += `${" ".repeat(i)}def f${i}(p):\n${" ".repeat(i + 1)}open(p, 'w')\n`;
  nested += `${" ".repeat(25)}${"for p ".repeat(16_000)}\nEOF`;
  const params = Array.from({ length: 32 }, (_, j) => `a${j}`);
  const helper = `python3 - <<'EOF'\ndef w(${params.join(", ")}):\n${params.map((p) => `    open(${p}, 'w')\n`).join("")}${`w(${"1,".repeat(1_990)})\n`.repeat(50)}EOF`;
  for (const [command, written] of [
    [`${scripts}${";python -x".repeat(9_000)}`, Array.from({ length: 50 }, (_, n) => `f${n}.py`).sort()],
    [nested, []],
    [helper, []],
  ] as Array<[string, string[]]>) {
    const started = Date.now();
    assert.deepEqual(shellWriteTargets(command).sort(), written, command.slice(0, 60));
    assert.ok(Date.now() - started < 1_000, `${command.slice(0, 40)}… took ${Date.now() - started} ms`);
  }
});

test("a << right after a command's name is a heredoc, even when the name ends in a digit; a number's is a shift", () => {
  for (const [command, written] of [
    ["cat > notes2<<EOF\n> quoted line\nEOF", ["notes2"]],
    ["python3<<'EOF'\nif n > limit:\n    pass\nEOF", []],
    ["echo $((1<<4)) > shift.txt", ["shift.txt"]],
    ["echo $[1<<2] > old.txt", ["old.txt"]],
    ["cat >f2<< bash\nopen('z.txt','w')\nbash", ["f2"]],
  ] as Array<[string, string[]]>)
    assert.deepEqual(shellWriteTargets(command).sort(), written, JSON.stringify(command));
});

test("blanks other than a space or a tab — a Windows line end, a no-break space, a form feed — are passed over", () => {
  for (const [command, written] of [
    ["echo a\r\necho b > f.txt", ["f.txt"]],
    ["echo 'a'\r", []],
    ["echo hello world > f.txt", ["f.txt"]],
    ["echo a\fb", []],
    ["ls\v-la", []],
    ["echo a b", []],
  ] as Array<[string, string[]]>)
    assert.deepEqual(shellWriteTargets(command).sort(), written, JSON.stringify(command));
});

test("in parallel turns Codex's command in a folder it names writes there", async () => {
  const room = createTestRoom({
    rules: [
      { agent: "claude", match: "fix", waitForText: "Fixed y", write: { path: "lib/z.ts", content: "z\n", via: "shell" }, command: "touch lib/z.ts", reply: "Fixed z.", once: true },
      {
        agent: "codex",
        match: "fix",
        workdir: "{cwd}/ui",
        command: "sed -i '' 's/a/b/' y.ts",
        write: { path: "ui/y.ts", content: "b\n", via: "shell" },
        reply: "Fixed y.",
        once: true,
      },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("fix y and z");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("codex").endedAt! < turn("claude").endedAt!, "Codex ended while Claude still worked");
    assert.deepEqual(turn("codex").files, ["ui/y.ts"]);
    assert.deepEqual(turn("claude").files, ["lib/z.ts"]);
    // Where it ran is read with the command, not kept.
    assert.ok(!JSON.stringify(room.store.state.turns).includes('"cwd"'));
  } finally {
    await room.cleanup();
  }
});

test("Claude's shell keeps a cd only from its own command that succeeded: not a failed one's, a background one's or a subagent's", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        match: "bump",
        // Claude Code takes the folder after `<command> &&`: a failed command leaves the shell where it was, and
        // a command in the background or in a subagent never moves it.
        commands: [
          { command: "cd ui && npx vitest run", fail: true },
          { command: "cd lib && npm run dev", background: true },
          { command: "cd docs && ls", parent: "toolu_task" },
          "sed -i '' 's/1.0.0/1.1.0/' package.json",
        ],
        write: { path: "package.json", content: '{ "version": "1.1.0" }\n', via: "shell" },
        reply: "Bumped.",
        once: true,
      },
      { agent: "codex", match: "bump", waitForText: "Bumped", write: { path: "notes.md", content: "n\n" }, reply: "Noted.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("bump the version");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("claude").endedAt! < turn("codex").endedAt!, "Claude ended while Codex still worked");
    assert.deepEqual(turn("claude").files, ["package.json"]);
    assert.deepEqual(turn("codex").files, ["notes.md"]);
    assert.ok(!JSON.stringify(room.store.state.turns).includes('"detached"'));
  } finally {
    await room.cleanup();
  }
});

test("commands Claude asks for in one message run one after another: the second starts where the first left the shell", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        match: "bump",
        commands: [{ command: "cd ui && npx vitest run" }, { command: "ls", together: true }, "sed -i '' 's/1/2/' version.ts"],
        write: { path: "ui/version.ts", content: "2\n", via: "shell" },
        reply: "Bumped.",
        once: true,
      },
      { agent: "codex", match: "bump", waitForText: "Bumped", write: { path: "notes.md", content: "n\n" }, reply: "Noted.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("bump the version");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("claude").endedAt! < turn("codex").endedAt!, "Claude ended while Codex still worked");
    assert.deepEqual(turn("claude").files, ["ui/version.ts"]);
    assert.deepEqual(turn("codex").files, ["notes.md"]);
  } finally {
    await room.cleanup();
  }
});

test("a command Claude Code reports as done without its exit code being 0 keeps the shell where it was: grep finding nothing, one sent to the background on its timeout", async () => {
  const room = createTestRoom({
    rules: [
      {
        agent: "claude",
        match: "bump",
        // Not errors to Claude Code, but `cd … && pwd` did not run: grep exited 1, the test run still goes on in the background.
        commands: [
          { command: "cd lib && grep -q TODO x.ts", result: { returnCodeInterpretation: "No matches found" } },
          { command: "cd e2e && npx playwright test", result: { backgroundTaskId: "b1" } },
          "sed -i '' 's/1.0.0/1.1.0/' package.json",
        ],
        write: { path: "package.json", content: '{ "version": "1.1.0" }\n', via: "shell" },
        reply: "Bumped.",
        once: true,
      },
      { agent: "codex", match: "bump", waitForText: "Bumped", write: { path: "notes.md", content: "n\n" }, reply: "Noted.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("bump the version");
    await withTimeout(room.engine.waitIdle());
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.ok(turn("claude").endedAt! < turn("codex").endedAt!, "Claude ended while Codex still worked");
    assert.deepEqual(turn("claude").files, ["package.json"]);
    assert.deepEqual(turn("codex").files, ["notes.md"]);
  } finally {
    await room.cleanup();
  }
});

test("a command asked for in the same message as a cd starts where that one left the shell, or where it was when that one exited non-zero", async () => {
  const claudeFiles = async (commands: unknown[], path: string) => {
    const room = createTestRoom({
      rules: [
        { agent: "claude", match: "bump", commands, write: { path, content: "2\n", via: "shell" }, reply: "Bumped.", once: true },
        { agent: "codex", match: "bump", waitForText: "Bumped", write: { path: "notes.md", content: "n\n" }, reply: "Noted.", once: true },
        { reply: "::pass::" },
      ],
    });
    try {
      room.engine.postHuman("bump the version");
      await withTimeout(room.engine.waitIdle());
      const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
      assert.ok(turn("claude").endedAt! < turn("codex").endedAt!, "Claude ended while Codex still worked");
      return turn("claude").files;
    } finally {
      await room.cleanup();
    }
  };
  // Reported together, run one after another: the write ran in ui.
  assert.deepEqual(await claudeFiles([{ command: "cd ui && npm i" }, { command: "echo 2 > version.ts", together: true }], "ui/version.ts"), ["ui/version.ts"]);
  // grep exited 1, the tests went on in the background: the write ran where the shell was.
  assert.deepEqual(
    await claudeFiles([{ command: "cd lib && grep -q TODO x.ts", result: { returnCodeInterpretation: "No matches found" } }, { command: "echo 2 > version.ts", together: true }], "version.ts"),
    ["version.ts"],
  );
  assert.deepEqual(
    await claudeFiles([{ command: "cd e2e && npx playwright test", result: { backgroundTaskId: "b1" } }, { command: "echo 2 > version.ts", together: true }], "version.ts"),
    ["version.ts"],
  );
});

test("a command asked for after one that never ended never ran: the turn that timed out is not credited what it names", async () => {
  const room = createTestRoom({
    settings: { turnTimeoutMs: 2500 },
    rules: [
      {
        agent: "claude",
        match: "fix vite",
        commands: [{ command: "cd ui && npm test", hang: true }, { command: "sed -i '' 's/a/b/' vite.config.ts", together: true }],
        reply: "Fixed.",
        once: true,
      },
      { agent: "codex", match: "fix vite", command: "sed -i '' 's/a/b/' ui/vite.config.ts", write: { path: "ui/vite.config.ts", content: "b\n", via: "shell" }, reply: "Fixed.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("fix vite config");
    await withTimeout(room.engine.waitIdle(), 30_000);
    const turn = (agent: string) => room.store.state.turns.find((entry) => entry.agent === agent)!;
    assert.equal(turn("claude").status, "error");
    assert.deepEqual(turn("codex").files, ["ui/vite.config.ts"]);
    // Its tests never ended, so its sed never started: Codex's file is not Claude's.
    assert.deepEqual(turn("claude").files ?? [], []);
  } finally {
    await room.cleanup();
  }
});

test("a live Claude that ran a command between turns starts its next turn with its shell somewhere not known", async () => {
  const room = createTestRoom({
    live: true,
    rules: [
      // A background task woke it after the turn: it looked at the results from e2e.
      { agent: "claude", match: "start e2e", command: "npm run e2e", between: ["cd e2e && cat results.json"], reply: "Started.", once: true },
      { agent: "claude", match: "fix config", command: "sed -i '' 's/a/b/' config.ts", write: { path: "e2e/config.ts", content: "b\n", via: "shell" }, sleepMs: 600, reply: "Fixed e2e config.", once: true },
      { agent: "codex", match: "fix config", command: "sed -i '' 's/a/b/' config.ts", write: { path: "config.ts", content: "b\n", via: "shell" }, reply: "Fixed root config.", once: true },
      { reply: "::pass::" },
    ],
  });
  try {
    room.engine.postHuman("@claude start e2e");
    await withTimeout(room.engine.waitIdle());
    await new Promise((resolve) => setTimeout(resolve, 300));
    room.engine.postHuman("fix config");
    await withTimeout(room.engine.waitIdle());
    const last = (agent: string) => room.store.state.turns.filter((entry) => entry.agent === agent && entry.status === "ok").at(-1)!;
    assert.deepEqual(last("codex").files, ["config.ts"]);
    // Its sed ran in e2e: the root's config.ts is Codex's, not Claude's too.
    assert.ok(!(last("claude").files ?? []).includes("config.ts"), String(last("claude").files));
  } finally {
    await room.cleanup();
  }
});
