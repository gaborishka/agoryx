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
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<ChatRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "cmd/agoryx/main.ts", "chat", ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...envOverrides,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("team command test timed out"));
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("/adapter accepts agentic mode", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-adapter-");
  const dbPath = join(dir, "test.db");
  const result = await runChat(
    [
      "--agents", "codex,claude",
      "--mode", "manual",
      "--adapter-mode", "stub",
      "--db", dbPath,
    ],
    "/adapter codex agentic\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Adapter codex switched to mode=agentic/);
});

test("/team start and /team status work in team mode", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-start-");
  const dbPath = join(dir, "test.db");
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: "0.1",
      defaultMode: "team",
      team: {
        profile: "enthusiast",
        maxSteps: 1,
        maxNoProgressSteps: 2,
        maxDurationMs: 900000,
        checksEnabledByDefault: true,
        checkCommands: ["npm run typecheck", "npm test"],
        strict: {
          maxSteps: 8,
          maxNoProgressSteps: 2,
          maxDurationMs: 900000,
          checksEnabledByDefault: true,
        },
        finalGate: "proposal",
        singleActive: true,
        trigger: {
          autoOnMessage: true,
          commandStart: true,
        },
      },
    }),
    "utf8",
  );

  const result = await runChat(
    [
      "--agents", "codex,claude",
      "--mode", "team",
      "--adapter-mode", "stub",
      "--db", dbPath,
      "--config", configPath,
    ],
    "/team start create release notes --strict --no-checks\n/team status\n/team log 5\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Team run started: teamrun_/);
  assert.match(result.stdout, /run_id: teamrun_/);
  assert.match(result.stdout, /steps:/);
  assert.doesNotMatch(result.stdout, /strategy:/);
});

test("free-text in waiting_user_input run does not claim feedback was queued", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-waiting-message-");
  const dbPath = join(dir, "test.db");
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: "0.1",
      defaultMode: "team",
      team: {
        profile: "enthusiast",
        maxSteps: 0,
        maxNoProgressSteps: 2,
        maxDurationMs: 900000,
        checksEnabledByDefault: true,
        checkCommands: ["npm run typecheck", "npm test"],
        strict: {
          maxSteps: 8,
          maxNoProgressSteps: 2,
          maxDurationMs: 900000,
          checksEnabledByDefault: true,
        },
        finalGate: "proposal",
        singleActive: true,
        trigger: {
          autoOnMessage: true,
          commandStart: true,
        },
      },
    }),
    "utf8",
  );

  const result = await runChat(
    [
      "--agents", "codex,claude",
      "--mode", "team",
      "--adapter-mode", "stub",
      "--db", dbPath,
      "--config", configPath,
    ],
    "/team start finalize quickly\nplease revise before approval\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Team run started: teamrun_/);
  assert.match(result.stdout, /is waiting for approval\. Use \/team approve\./);
  assert.doesNotMatch(result.stdout, /Feedback queued for team run/);
});

test("@mention in waiting_user_input run triggers direct adapter response", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-waiting-mention-");
  const dbPath = join(dir, "test.db");
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: "0.1",
      defaultMode: "team",
      team: {
        profile: "enthusiast",
        maxSteps: 0,
        maxNoProgressSteps: 2,
        maxDurationMs: 900000,
        checksEnabledByDefault: true,
        checkCommands: ["npm run typecheck", "npm test"],
        strict: {
          maxSteps: 8,
          maxNoProgressSteps: 2,
          maxDurationMs: 900000,
          checksEnabledByDefault: true,
        },
        finalGate: "proposal",
        singleActive: true,
        trigger: {
          autoOnMessage: true,
          commandStart: true,
        },
      },
    }),
    "utf8",
  );

  const result = await runChat(
    [
      "--agents", "codex,claude",
      "--mode", "team",
      "--adapter-mode", "stub",
      "--db", dbPath,
      "--config", configPath,
    ],
    "/team start finalize quickly\n@claude what do you think?\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /claude:/);
  assert.doesNotMatch(result.stdout, /No dispatch generated\./);
});

test("/team command validates usage", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-usage-");
  const dbPath = join(dir, "test.db");
  const result = await runChat(
    [
      "--agents", "codex,claude",
      "--mode", "team",
      "--adapter-mode", "stub",
      "--db", dbPath,
    ],
    "/team nope\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/team <start\|status\|log\|resume\|approve\|interrupt\|stop>/);
});

test("/team interrupt without active run reports missing run", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-interrupt-missing-");
  const dbPath = join(dir, "test.db");
  const result = await runChat(
    [
      "--agents", "codex,claude",
      "--mode", "team",
      "--adapter-mode", "stub",
      "--db", dbPath,
    ],
    "/team interrupt please adjust\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /No active team run to interrupt\./);
});

test("team mode auto-promotes default cli adapters to agentic", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-agentic-default-");
  const dbPath = join(dir, "test.db");
  const result = await runChat(
    [
      "--agents", "codex,claude",
      "--mode", "team",
      "--db", dbPath,
    ],
    "/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /- codex: mode=agentic/);
  assert.match(result.stdout, /- claude: mode=agentic/);
});

test("team start surfaces worktree isolation warning when creation fails", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-team-worktree-warning-");
  const dbPath = join(dir, "test.db");

  const result = await runChat(
    [
      "--agents", "codex",
      "--mode", "team",
      "--adapter-mode", "stub",
      "--db", dbPath,
    ],
    "/team start verify warnings\n/quit\n",
    20_000,
    { AGORYX_WORKTREE_ROOT: "/dev/null" },
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Team run started: teamrun_/);
  assert.match(result.stdout, /Team run warning: Worktree isolation disabled for codex/i);
});
