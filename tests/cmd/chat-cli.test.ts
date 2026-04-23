import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const runCli = (
  args: string[],
  stdinInput: string,
  timeoutMs = 20_000,
): Promise<ChatRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "cmd/agoryx/main.ts", ...args],
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
      reject(new Error("top-level CLI test timed out"));
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

test("chat exits cleanly when stdin closes after one message", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-eof-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex,claude",
      "--mode",
      "auto",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "hello\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /codex:/);
  assert.doesNotMatch(result.stderr, /readline was closed/i);
});

test("/checkpoint is supported as alias of /summary", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-checkpoint-"));
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
    "/checkpoint\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Not enough conversation history to create a checkpoint\./);
});

test("chat prints live agent status lines while streaming", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-status-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "@codex hello\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[codex\] generating\.\.\./);
  assert.match(result.stdout, /codex:/);
  assert.match(result.stdout, /\[codex\] done/);
});

test("chat hides system status lines when --quiet-system is enabled", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-quiet-system-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--quiet-system",
      "--db",
      dbPath,
    ],
    "@codex hello\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /codex:/);
  assert.doesNotMatch(result.stdout, /\[codex\] generating\.\.\./);
  assert.doesNotMatch(result.stdout, /\[codex\] done/);
});

test("chat rejects invalid --agents names", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-invalid-agents-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex,../../tmp/evil",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Invalid agent name in --agents/i);
});

test("chat renderer filters system-reminder blocks from streamed output", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-filter-reminder-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "@codex <system-reminder>hidden</system-reminder> hello\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /system-reminder/i);
});

test("chat renderer filters process-chatter lines in team mode", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-filter-chatter-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex",
      "--mode",
      "team",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "I'll read docs first\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /i.?ll read docs first/i);
});

test("chat renderer filters Ukrainian process-chatter lines in team mode", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-filter-chatter-ua-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--agents",
      "codex",
      "--mode",
      "team",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "Зараз швидко перегляну README і далі перевіряю маршрути\n/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /зараз швидко перегляну/i);
  assert.doesNotMatch(result.stdout, /далі перевіряю/i);
});

test("chat keeps config-defined adapter mode when --adapter-mode is not provided", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-chat-config-mode-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const configPath = join(tmpDir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: "0.1",
      agents: {
        codex: {
          adapter: "codex",
          mode: "persistent",
          timeoutMs: 120000,
          maxTokens: 4000,
        },
      },
    }),
    "utf8",
  );

  const result = await runChatCli(
    [
      "--agents",
      "codex",
      "--mode",
      "manual",
      "--config",
      configPath,
      "--db",
      dbPath,
    ],
    "/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /- codex: mode=persistent/);
});

test("top-level agoryx command defaults to chat mode", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-top-level-chat-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runCli(
    [
      "--agents",
      "codex",
      "--mode",
      "manual",
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Agoryx v/);
  assert.match(result.stdout, /Type \/help for commands/);
});

test("chat defaults to free mode and includes all available agents", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agoryx-default-free-"));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const dbPath = join(tmpDir, "chat.db");
  const result = await runChatCli(
    [
      "--adapter-mode",
      "stub",
      "--db",
      dbPath,
    ],
    "/quit\n",
  );

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Mode:\s+free/);
  assert.match(result.stdout, /- codex: mode=stub/);
  assert.match(result.stdout, /- claude: mode=stub/);
});
