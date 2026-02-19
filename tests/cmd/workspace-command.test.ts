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
      reject(new Error("chat CLI workspace test timed out"));
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

test("/workspace show displays always-on workspace context", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-workspace-show-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/workspace show\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[Workspace\]/);
  assert.match(result.stdout, /Branch:/);
});

test("/workspace full displays always-on + on-demand context", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-workspace-full-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/workspace full\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[Workspace\]/);
  assert.match(result.stdout, /Recent commits:/);
});

test("/workspace show --json outputs JSON", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-workspace-json-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/workspace show --json\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /"branch":/);
  assert.match(result.stdout, /"unavailable":\s*(null|"[^"]+")/);
});

test("/help includes /workspace command surface", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-workspace-help-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/help\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\/workspace show \[--json\]/);
  assert.match(result.stdout, /\/workspace full \[--json\]/);
});
