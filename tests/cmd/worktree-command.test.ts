import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDefaultWorktreeDir } from "../../internal/config/paths.js";

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
      reject(new Error("chat CLI worktree test timed out"));
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

const uniqueAgent = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const defaultWorktreeDir = resolveDefaultWorktreeDir(process.cwd());

const cleanupWorktreeAgent = (agent: string): void => {
  const worktreePath = join(defaultWorktreeDir, agent);
  try {
    if (existsSync(worktreePath)) {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
    }
  } catch {
    // best effort
  }

  try {
    const branches = execFileSync("git", ["branch", "--list", `agoryx/${agent}-*`], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.replace(/^\*\s*/, "").trim())
      .filter(Boolean);

    for (const branch of branches) {
      try {
        execFileSync("git", ["branch", "-D", branch], {
          cwd: process.cwd(),
          stdio: "ignore",
        });
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
};

test("/worktree create <agent> creates worktree", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-create-");
  const agent = uniqueAgent("wt-create");
  t.after(() => cleanupWorktreeAgent(agent));

  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree create ${agent}\n/worktree remove ${agent} --force\n/quit\n`,
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`Worktree created for ${agent}`));
  assert.match(result.stdout, new RegExp(`worktrees/${agent}`));
});

test("/worktree create rejects invalid agent name", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-create-invalid-");

  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/worktree create ../../tmp/evil\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: \/worktree create <agent> \[--json\]/);
  assert.doesNotMatch(result.stdout, /Worktree created for/);
});

test("/worktree list shows all worktrees", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-list-");
  const agent = uniqueAgent("wt-list");
  t.after(() => cleanupWorktreeAgent(agent));

  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree create ${agent}\n/worktree list\n/worktree remove ${agent} --force\n/quit\n`,
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /agent\tpath\tbranch\thead/);
  assert.match(result.stdout, new RegExp(`${agent}\\t`));
});

test("/worktree list --json outputs JSON", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-list-json-");
  const agent = uniqueAgent("wt-json");
  t.after(() => cleanupWorktreeAgent(agent));

  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree create ${agent}\n/worktree list --json\n/worktree remove ${agent} --force\n/quit\n`,
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(`\"agent\":\\s*\"${agent}\"`));
  assert.match(result.stdout, /"path":\s*".*\/worktrees\//);
});

test("/worktree remove <agent> fails if worktree is dirty", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-remove-dirty-");
  const agent = uniqueAgent("wt-dirty");
  t.after(() => cleanupWorktreeAgent(agent));

  const first = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree create ${agent}\n/quit\n`,
  );
  assert.equal(first.code, 0);

  const dirtyFile = join(defaultWorktreeDir, agent, "dirty.txt");
  writeFileSync(dirtyFile, "dirty\n", "utf8");

  const second = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree remove ${agent}\n/worktree remove ${agent} --force\n/quit\n`,
  );
  assert.equal(second.code, 0);
  assert.match(second.stdout, /uncommitted changes/i);
  assert.match(second.stdout, new RegExp(`Worktree removed for ${agent}`));
});

test("/worktree remove <agent> --force removes even if dirty", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-remove-force-");
  const agent = uniqueAgent("wt-force");
  t.after(() => cleanupWorktreeAgent(agent));

  const first = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree create ${agent}\n/quit\n`,
  );
  assert.equal(first.code, 0);

  const dirtyFile = join(defaultWorktreeDir, agent, "dirty.txt");
  writeFileSync(dirtyFile, "dirty\n", "utf8");

  const second = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree remove ${agent} --force\n/quit\n`,
  );
  assert.equal(second.code, 0);
  assert.match(second.stdout, new RegExp(`Worktree removed for ${agent}`));
});

test("/worktree status shows detailed status", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-status-");
  const agent = uniqueAgent("wt-status");
  t.after(() => cleanupWorktreeAgent(agent));

  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    `/worktree create ${agent}\n/worktree status\n/worktree remove ${agent} --force\n/quit\n`,
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /agent\tdirty\tahead\tbehind\tpath/);
  assert.match(result.stdout, new RegExp(`${agent}\\t(no|yes)\\t`));
});

test("/help includes /worktree command surface", async (t) => {
  const dir = makeTmpDir(t, "agoryx-cmd-worktree-help-");
  const result = await runChat(
    baseArgs(join(dir, "test.db")),
    "/help\n/quit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\/worktree list \[--json\]/);
  assert.match(result.stdout, /\/worktree create <agent> \[--json\]/);
  assert.match(result.stdout, /\/worktree remove <agent> \[--force\] \[--json\]/);
  assert.match(result.stdout, /\/worktree status \[--json\]/);
});
