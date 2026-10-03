import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readProject } from "../../internal/agora/projects.js";

const memory = resolve(import.meta.dirname, "../../internal/agora/memory.ts");

test("two processes noting into one project at once number every entry once", async () => {
  const root = mkdtempSync(join(tmpdir(), "agoryx-project-lock-"));
  try {
    const key = join(root, "repo");
    mkdirSync(key);
    const env = { ...process.env, AGORYX_HOME: join(root, "home") };
    const script = join(root, "note.ts");
    writeFileSync(
      script,
      `import { noteMemory } from ${JSON.stringify(memory)};\nfor (let i = 0; i < 15; i += 1) noteMemory(${JSON.stringify(key)}, { text: process.argv[2] + " " + i }, { by: process.argv[2] });\n`,
    );
    const run = (who: string) =>
      new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, who], { env, stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("exit", (code) => (code === 0 ? done() : fail(new Error(err))));
      });
    await Promise.all([run("claude"), run("codex")]);
    const project = readProject(key, env);
    const ids = project.memory.map((entry) => entry.id);
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30, "no id given twice");
    assert.equal(new Set(project.events.map((event) => event.seq)).size, project.events.length, "no seq given twice");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
