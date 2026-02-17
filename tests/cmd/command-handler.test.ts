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

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

test("/help lists available commands", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-help-");
  const result = await runChat(baseArgs(join(dir, "test.db")), "/help\n/quit\n");

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\/mode/);
  assert.match(result.stdout, /\/status/);
  assert.match(result.stdout, /\/pin/);
  assert.match(result.stdout, /\/unpin/);
  assert.match(result.stdout, /\/pins/);
  assert.match(result.stdout, /\/summary/);
  assert.match(result.stdout, /\/checkpoint/);
  assert.match(result.stdout, /\/history/);
  assert.match(result.stdout, /\/retry/);
  assert.match(result.stdout, /\/export/);
  assert.match(result.stdout, /\/quit/);
});

// ---------------------------------------------------------------------------
// /pin
// ---------------------------------------------------------------------------

test("/pin with label and content creates pinned context", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-pin-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/pin my-label: some important context\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Pinned context created: pin_/);
});

test("/pin with content only (no label) creates pinned context", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-pin-nolabel-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/pin some standalone context\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Pinned context created: pin_/);
});

test("/pin without arguments prints usage", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-pin-empty-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/pin\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/pin/);
});

// ---------------------------------------------------------------------------
// /unpin
// ---------------------------------------------------------------------------

test("/unpin without arguments prints usage", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-unpin-empty-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/unpin\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/unpin/);
});

test("/unpin with nonexistent id reports not found", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-unpin-missing-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/unpin nonexistent-id\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Pin nonexistent-id not found/);
});

test("/pin then /unpin with returned id removes pinned context", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-pin-unpin-");
  // Two-run approach: pin in run 1, extract ID, resume and unpin in run 2.
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/pin test-label: test content\n/quit\n",
  );

  assert.equal(result.code, 0);
  // Extract the pin id from "Pinned context created: pin_xxxxx"
  const match = result.stdout.match(/Pinned context created: (pin_\S+)/);
  assert.ok(match, "Expected pin ID in output");

  // Now resume and unpin
  // We need the room id from the first session output
  const roomMatch = result.stdout.match(/Room: (room_\S+)/);
  assert.ok(roomMatch, "Expected room ID in output");

  const result2 = await runChat(
    [...baseArgs(join(dir, "test.db")), "--resume", roomMatch[1]],
    `/unpin ${match[1]}\n/quit\n`,
  );

  assert.equal(result2.code, 0);
  assert.match(result2.stdout, /Removed pinned context/);
});

// ---------------------------------------------------------------------------
// /summary and /checkpoint
// ---------------------------------------------------------------------------

test("/summary on empty room reports not enough history", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-summary-empty-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/summary\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Not enough conversation history to create a checkpoint/);
});

test("/summary creates checkpoint when enough messages exist", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-summary-ok-");
  // Create a config with very low checkpoint threshold (2) so that
  // a couple of messages are enough to trigger checkpoint creation.
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: "0.1",
      context: {
        checkpointThreshold: 2,
        maxHistoryMessages: 100,
        maxContextTokens: 30000,
      },
    }),
    "utf8",
  );

  const dbPath = join(dir, "test.db");
  const chatArgs = [
    "--agents", "codex,claude",
    "--mode", "manual",
    "--adapter-mode", "stub",
    "--db", dbPath,
    "--config", configPath,
  ];

  // Run 1: send a message to create user+assistant pair (piped stdin
  // closes after the first async command, so we use separate runs).
  const run1 = await runChat(chatArgs, "@codex hello there\n");
  assert.equal(run1.code, 0);
  const roomMatch = run1.stdout.match(/Room: (room_\S+)/);
  assert.ok(roomMatch, "Expected room ID in output");

  // Run 2: resume the room and call /summary
  const run2 = await runChat(
    [...chatArgs, "--resume", roomMatch[1]],
    "/summary\n/quit\n",
  );

  assert.equal(run2.code, 0);
  assert.match(run2.stdout, /Checkpoint created/);
});

// ---------------------------------------------------------------------------
// /mode
// ---------------------------------------------------------------------------

test("/mode without argument prints usage", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-mode-empty-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/mode\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/mode/);
});

test("/mode switches orchestration mode", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-mode-switch-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/mode auto\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Mode switched to: auto/);
});

test("/mode rejects invalid mode", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-mode-invalid-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/mode invalid\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/mode/);
});

// ---------------------------------------------------------------------------
// /history
// ---------------------------------------------------------------------------

test("/history shows conversation messages", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-history-");
  const dbPath = join(dir, "test.db");

  // Run 1: send a message to populate history
  const run1 = await runChat(baseArgs(dbPath), "@codex hello\n");
  assert.equal(run1.code, 0);
  const roomMatch = run1.stdout.match(/Room: (room_\S+)/);
  assert.ok(roomMatch, "Expected room ID in output");

  // Run 2: resume and check /history
  const run2 = await runChat(
    [...baseArgs(dbPath), "--resume", roomMatch[1]],
    "/history\n/quit\n",
  );

  assert.equal(run2.code, 0);
  // Should show the user message and agent response
  assert.match(run2.stdout, /\[user\] @codex hello/);
});

// ---------------------------------------------------------------------------
// /adapter
// ---------------------------------------------------------------------------

test("/adapter switches adapter mode", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-adapter-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/adapter codex cli\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Adapter codex switched to mode=cli/);
});

test("/adapter without arguments prints usage", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-adapter-empty-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/adapter\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/adapter/);
});

test("/adapter with unknown agent reports error", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-adapter-unknown-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/adapter gemini cli\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Unknown adapter: gemini/);
});

// ---------------------------------------------------------------------------
// unknown command
// ---------------------------------------------------------------------------

test("unknown command prints error with /help hint", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-unknown-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/foobar\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Unknown command: \/foobar/);
  assert.match(result.stdout, /\/help/);
});

// ---------------------------------------------------------------------------
// /quit and /exit
// ---------------------------------------------------------------------------

test("/quit exits the chat loop", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-quit-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/quit\n",
  );

  assert.equal(result.code, 0);
});

test("/exit exits the chat loop", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-exit-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/exit\n",
  );

  assert.equal(result.code, 0);
});

// ---------------------------------------------------------------------------
// whitespace normalization
// ---------------------------------------------------------------------------

test("commands with extra whitespace between tokens are parsed correctly", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-whitespace-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/mode   auto\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Mode switched to: auto/);
});
