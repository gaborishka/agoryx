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

const runChatCli = (
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

const runChatCliLines = (
  args: string[],
  lines: string[],
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

    let cursor = 0;
    const sendNext = (): void => {
      if (cursor >= lines.length) {
        child.stdin.end();
        return;
      }
      child.stdin.write(`${lines[cursor]}\n`);
      cursor += 1;
      setTimeout(sendNext, 10);
    };
    sendNext();
  });

test("/pins reports empty state when no pins exist", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-pins-empty-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex,claude",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "/pins\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No pinned context\./);
});

test("/pins list shows active pinned contexts", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-pins-list-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCliLines(
    [
      "--agents",
      "codex,claude",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    ["/pin scope: keep tests green", "/pin note: keep cli stable", "/pins list", "/quit"],
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /pin_id\tlabel\tcontent/);
  assert.match(result.stdout, /pin_[a-z0-9-]+\tscope\tkeep tests green/);
  assert.match(result.stdout, /pin_[a-z0-9-]+\tnote\tkeep cli stable/);
});

test("/pins rejects unsupported subcommand", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-pins-usage-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex,claude",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "/pins now\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/pins \[list\]/);
});
