import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { projectDir, projectHash } from "../../internal/agora/projects.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { writeFakeBins } from "./helpers.js";

test("New project writes the name, goal and context folders for a folder, all or nothing, and never over a named one", async () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-create-"));
  const env = { ...process.env, HOME: home, AGORYX_HOME: join(home, "agora"), AGORYX_LIVE: "0" };
  const bins = writeFakeBins(home);
  const app = join(home, "app");
  const lib = join(home, "lib");
  mkdirSync(app);
  mkdirSync(lib);
  const daemon = new AgoraDaemon({
    env: { ...env, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") },
    runners: { claude: createClaudeRunner(bins.fakeClaude), codex: createCodexRunner(bins.fakeCodex) },
    port: 0,
  });
  try {
    const info = await daemon.start();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${info.url}${path}`, {
        method,
        headers: { "x-agoryx-token": daemon.token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    // A context folder that cannot be one: nothing is written at all.
    const refused = await call("POST", "/api/projects", { dir: "~/app", name: "App", goal: "Ship", context: [join(app, "sub")] });
    assert.equal(refused.status, 400);
    assert.equal(existsSync(projectDir(app, env)), false);
    assert.equal((await call("POST", "/api/projects", { dir: "~/app", name: "  " })).status, 400);
    assert.equal((await call("POST", "/api/projects", { dir: join(home, "nope"), name: "X" })).status, 400);

    const made = await call("POST", "/api/projects", { dir: "~/app", name: "App", goal: "Ship it", context: ["~/lib", lib] });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const project = made.body.project;
    assert.equal(project.hash, projectHash(app));
    assert.equal(project.name, "App");
    assert.equal(project.goal, "Ship it");
    assert.deepEqual(project.context, [lib], "the same folder twice is one");
    assert.deepEqual(
      project.events.map((event: any) => [event.type, event.by]),
      [["project.changed", project.events[0].by], ["project.changed", project.events[0].by], ["context.added", project.events[0].by]],
    );
    assert.ok(project.events[0].by, "every write says who made it");

    const listed = (await call("GET", "/api/projects")).body.projects;
    assert.deepEqual(listed.map((entry: any) => [entry.name, entry.context, entry.updatedAt]), [["App", [lib], project.events.at(-1).ts]]);

    const again = await call("POST", "/api/projects", { dir: app, name: "Other" });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /is the project "App" already/);
    assert.equal(again.body.project.hash, project.hash);
    assert.equal((await call("GET", `/api/projects/${project.hash}`)).body.project.name, "App", "nothing written over");
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
