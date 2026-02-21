import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

interface CliRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const CLI_ENTRY = join(process.cwd(), "cmd/agoryx/main.ts");
const TSX_LOADER = pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href;

const runCli = (
  args: string[],
  stdinInput = "",
  timeoutMs = 20_000,
  cwd = process.cwd(),
): Promise<CliRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", TSX_LOADER, CLI_ENTRY, ...args],
      {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("root CLI test timed out"));
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

test("--help prints root usage without starting chat", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage:/m);
  assert.doesNotMatch(result.stdout, /Room:/);
});

test("--version prints semantic version without side effects", async () => {
  const result = await runCli(["--version"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^agoryx\s+\d+\.\d+\.\d+/);
  assert.doesNotMatch(result.stdout, /Room:/);
});

test("unknown option returns usage exit code", async () => {
  const result = await runCli(["--limti", "10"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option/);
});

test("chat --help prints command usage", async () => {
  const result = await runCli(["chat", "--help"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage:\n  agoryx chat/m);
  assert.doesNotMatch(result.stdout, /Room:/);
});

test("sessions --help prints sessions usage and exits 0", async () => {
  const result = await runCli(["sessions", "--help"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage:\n  agoryx sessions list/m);
});

test("sessions list --help does not execute list", async () => {
  const result = await runCli(["sessions", "list", "--help"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage:\n  agoryx sessions list/m);
  assert.doesNotMatch(result.stdout, /session_id\troom_id/);
});

test("sessions list unknown flag returns usage exit code", async () => {
  const result = await runCli(["sessions", "list", "--limti", "10"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option '--limti'/);
});

test("sessions list rejects flag used as --limit value", async () => {
  const result = await runCli(["sessions", "list", "--limit", "--help"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Option --limit requires a value/);
});

test("invalid config file fails fast", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-root-cli-bad-config-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, "bad.json");
  writeFileSync(configPath, "{\"broken\":", "utf8");

  const result = await runCli(["sessions", "list", "--config", configPath]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Failed to load config/);
});

test("sessions list with file URI db path does not create local file: directory", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-root-cli-db-uri-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const dbUri = `file:${join(dir, "uri.db")}`;
  const result = await runCli(["sessions", "list", "--db", dbUri], "", 20_000, dir);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /datatype mismatch/i);
  assert.equal(existsSync(join(dir, "file:")), false);
});

test("sessions list with relative SQLite file URI resolves to regular db filename", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-root-cli-db-relative-uri-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await runCli(["sessions", "list", "--db", "file:test.db"], "", 20_000, dir);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(dir, "test.db")), true);
  assert.equal(existsSync(join(dir, "file:test.db")), false);
});

test("sessions list with relative SQLite file URI prepares parent directories", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-root-cli-db-relative-uri-parent-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const dbUri = "file:data/state/test.db";
  const result = await runCli(["sessions", "list", "--db", dbUri], "", 20_000, dir);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(dir, "data", "state", "test.db")), true);
});

test("sessions list with SQLite URI mode=memory avoids literal file creation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-root-cli-db-memory-uri-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const dbUri = "file:test.db?mode=memory&cache=shared";
  const result = await runCli(["sessions", "list", "--db", dbUri], "", 20_000, dir);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(dir, "test.db")), false);
  assert.equal(existsSync(join(dir, dbUri)), false);
});

test("config explain preserves relative SQLite file URI", async () => {
  const result = await runCli(["config", "explain", "--db", "file:test.db"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Resolved db path: file:test\.db/);
});

test("config explain preserves SQLite URI query parameters", async () => {
  const dbUri = "file:test.db?mode=memory&cache=shared";
  const result = await runCli(["config", "explain", "--db", dbUri]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Resolved db path: file:test\.db\?mode=memory&cache=shared/);
});
