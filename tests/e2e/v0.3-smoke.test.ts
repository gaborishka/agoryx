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
  timeoutMs = 30_000,
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
      reject(new Error("v0.3 e2e smoke timed out"));
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

const baseArgs = (dbPath: string): string[] => [
  "--agents", "codex,claude",
  "--mode", "manual",
  "--adapter-mode", "stub",
  "--db", dbPath,
];

test("v0.3 smoke: dispatch -> memory capture -> decision -> restart -> recovery", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-v03-e2e-smoke-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const dbPath = join(dir, "smoke.db");
  const first = await runChat(
    baseArgs(dbPath),
    [
      "/memory show",
      "@codex hello",
      "/memory log --type dispatch_start --limit 1",
      "/memory log --type dispatch_end --limit 1",
      "/memory decision Test decision",
      "/memory show",
      "/workspace show",
      "/quit",
      "",
    ].join("\n"),
  );

  assert.equal(first.signal, null);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /No memory snapshot yet\./);
  assert.match(first.stdout, /dispatch_start/);
  assert.match(first.stdout, /dispatch_end/);
  assert.match(first.stdout, /Memory decision recorded\./);
  assert.match(first.stdout, /Test decision/);
  assert.match(first.stdout, /\[Workspace\]/);

  const roomMatch = first.stdout.match(/Room:\s*(room_[a-z0-9-]+)/i);
  assert.ok(roomMatch, "expected room id in banner output");
  const roomId = roomMatch[1];

  const second = await runChat(
    [...baseArgs(dbPath), "--resume", roomId],
    "/memory show\n/quit\n",
  );

  assert.equal(second.signal, null);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /Memory snapshot:/);
  assert.match(second.stdout, /Test decision/);
});
