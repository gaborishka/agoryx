import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface ChatRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const runChat = (
  args: string[],
  stdinInput: string,
  timeoutMs = 20_000,
): Promise<ChatRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "cmd/agoryx/main.ts", "chat", ...args],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("chat CLI test timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    child.stdin.end(stdinInput);
  });

const makeTmpDir = (t: Parameters<Parameters<typeof test>[1]>[0], prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

const baseArgs = (dbPath: string): string[] => [
  "--agents", "codex,claude",
  "--mode", "manual",
  "--adapter-mode", "stub",
  "--db", dbPath,
];

test("/memory show displays empty state without snapshot", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-show-");
  const result = await runChat(baseArgs(join(dir, "test.db")), "/memory show\n/quit\n");

  assert.equal(result.code, 0);
  assert.match(result.stdout, /No memory snapshot yet\./);
});

test("/memory without subcommand defaults to show", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-default-");
  const result = await runChat(baseArgs(join(dir, "test.db")), "/memory\n/quit\n");

  assert.equal(result.code, 0);
  assert.match(result.stdout, /No memory snapshot yet\./);
});

test("/memory decision records decision and updates snapshot", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-decision-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/memory decision Use SQLite for memory\n/memory show\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Memory decision recorded\./);
  assert.match(result.stdout, /Use SQLite for memory/);
});

test("/memory note records note and appears in filtered log", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-note-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/memory note Keep CI green\n/memory log --type note\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Memory note recorded\./);
  assert.match(result.stdout, /\tnote\t/);
  assert.match(result.stdout, /Keep CI green/);
});

test("/memory log supports --source and --type filters", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-filter-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/memory decision Keep logs append-only\n/memory note Add retries\n/memory log --source user --type decision\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Keep logs append-only/);
  assert.doesNotMatch(result.stdout, /Add retries/);
});

test("/memory log supports --json output", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-json-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/memory decision JSON output test\n/memory log --json\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /"eventType": "decision"/);
  assert.match(result.stdout, /"source": "user"/);
});

test("/memory log supports --limit", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-limit-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/memory decision First\n/memory decision Second\n/memory log --type decision --limit 1\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Second/);
  assert.doesNotMatch(result.stdout, /First/);
});

test("/memory rebuild returns replay payload", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-rebuild-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/memory decision Rebuild me\n/memory rebuild\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Memory rebuild:/);
  assert.match(result.stdout, /"processed":\d+/);
  assert.match(result.stdout, /"snapshot_version":\d+/);
  assert.match(result.stdout, /"duration_ms":\d+/);
});

test("/memory render prints markdown memory view", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-render-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/memory decision Render decision\n/memory render\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /# Agoryx Memory/);
  assert.match(result.stdout, /## Key Decisions/);
  assert.match(result.stdout, /Render decision/);
});

test("/help includes /memory command surface", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-memory-help-");
  const result = await runChat(baseArgs(join(dir, "test.db")), "/help\n/quit\n");

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\/memory \[show\]/);
  assert.match(result.stdout, /\/memory decision <text>/);
  assert.match(result.stdout, /\/memory log/);
  assert.match(result.stdout, /--limit <n>/);
  assert.match(result.stdout, /\/memory rebuild/);
});
