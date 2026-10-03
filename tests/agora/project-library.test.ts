import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { addLibraryFile, addProjectContext, projectBriefing, projectHash, projectUpdate, readProject, removeLibraryFile } from "../../internal/agora/projects.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { writeFakeBins } from "./helpers.js";

const scratch = () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-library-"));
  const env = { ...process.env, HOME: home, AGORYX_HOME: join(home, "agora"), AGORYX_LIVE: "0" };
  const key = join(home, "app");
  const lib = join(home, "lib");
  mkdirSync(key, { recursive: true });
  mkdirSync(lib);
  const paper = join(home, "paper.pdf");
  writeFileSync(paper, "%PDF");
  return { home, env, key, lib, paper };
};

test("a file added to the library is a write with who made it; missing or relative is refused, twice is once, out is out", () => {
  const { home, env, key, paper } = scratch();
  try {
    const added = addLibraryFile(key, "~/paper.pdf", { by: "Ivan" }, env);
    assert.deepEqual(
      added.library.map((file) => [file.path, file.by]),
      [[paper, "Ivan"]],
    );
    assert.equal(addLibraryFile(key, paper, { by: "codex" }, env).seq, added.seq, "the same file again writes nothing");
    assert.throws(() => addLibraryFile(key, join(home, "nope.txt"), { by: "Ivan" }, env), /no file at/);
    assert.throws(() => addLibraryFile(key, home, { by: "Ivan" }, env), /no file at/);
    assert.throws(() => addLibraryFile(key, "paper.pdf", { by: "Ivan" }, env), /absolute path/);

    const removed = removeLibraryFile(key, paper, { by: "claude", from: { room: "r1", roomName: "R", agent: "claude", label: "Claude", kind: "claude" } }, env);
    assert.deepEqual(removed.library, []);
    assert.equal(removed.events.at(-1)!.type, "library.removed");
    assert.equal(removed.events.at(-1)!.by, "claude");
    assert.throws(() => removeLibraryFile(key, paper, { by: "Ivan" }, env), /not in this project's library/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the briefing names the library's files with who added them, and a running session hears of a change", () => {
  const { home, env, key, paper } = scratch();
  try {
    addProjectContext(key, join(home, "lib"), { by: "Ivan" }, env);
    const seen = readProject(key, env).seq;
    addLibraryFile(key, paper, { by: "Ivan" }, env);
    const project = readProject(key, env);
    assert.match(projectBriefing(project, "agoryx", env), new RegExp(`Library — files added to the project, each where it is:\\n {4}${paper} — added by Ivan`));
    assert.match(projectUpdate(project, seen, { room: "r", agent: "claude" })!, new RegExp(`Ivan added ${paper} to the project's library`));
    removeLibraryFile(key, paper, { by: "Ivan" }, env);
    const after = readProject(key, env);
    assert.doesNotMatch(projectBriefing(after, "agoryx", env), /Library —/);
    assert.match(projectUpdate(after, project.seq, { room: "r", agent: "claude" })!, /took .* out of the project's library \(the file stays where it is\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the daemon adds and takes out library files by whoever asks; the overview groups them by source", async () => {
  const { home, env, key, lib, paper } = scratch();
  const bins = writeFakeBins(home);
  const daemon = new AgoraDaemon({
    env: { ...env, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") },
    runners: { claude: createClaudeRunner(bins.fakeClaude), codex: createCodexRunner(bins.fakeCodex) },
    port: 0,
  });
  try {
    const info = await daemon.start();
    const call = async (method: string, path: string, body?: unknown, token = daemon.token) => {
      const res = await fetch(`${info.url}${path}`, {
        method,
        headers: { "x-agoryx-token": token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const room = (await call("POST", "/api/rooms", { name: "Work here", dir: key, mode: "work" })).body.room;
    const hash = projectHash(key);
    const added = await call("POST", `/api/projects/${hash}/library`, { path: paper }, agentKey(daemon.token, room.id, "codex"));
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(
      added.body.project.library.map((file: { path: string; by: string }) => [file.path, file.by]),
      [[paper, "codex"]],
    );
    assert.equal(added.body.project.events.at(-1).type, "library.added");
    assert.equal((await call("POST", `/api/projects/${hash}/library`, { path: join(home, "nope") })).status, 400);
    assert.equal((await call("POST", `/api/projects/${hash}/context`, { path: lib })).status, 200);

    const overview = (await call("GET", `/api/projects/${hash}/overview`)).body;
    const shown = overview.library.map((entry: { kind: string; path: string; by: string; added?: boolean }) => [entry.kind, entry.path, entry.by, entry.added ?? false]);
    assert.deepEqual(
      shown.sort((a: string[], b: string[]) => a[0]!.localeCompare(b[0]!)),
      [
        ["context", lib, "Ivan", false],
        ["upload", paper, "Codex", true],
      ],
    );

    const removed = await call("DELETE", `/api/projects/${hash}/library?path=${encodeURIComponent(paper)}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.project.library, []);
    assert.equal(removed.body.project.events.at(-1).by, "Ivan");
    const after = (await call("GET", `/api/projects/${hash}/overview`)).body;
    assert.deepEqual(
      after.library.map((entry: { kind: string }) => entry.kind),
      ["context"],
    );
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
