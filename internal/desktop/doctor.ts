import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findDaemon, readDaemonInfo } from "../agora/daemoninfo.js";
import { agoraHome } from "../agora/paths.js";
import { findExecutable } from "./shellenv.js";

/**
 * `agoryx doctor`, and the app's first screen: is everything a room needs here, and if not, what to run.
 *
 * Each check runs the tools the daemon would run, with the environment it would get (`env`), and a
 * timeout. What it prints is safe to show or paste anywhere: versions, paths, states — never an
 * environment value, a token, or the account behind a login (`claude auth status` names it; only
 * `loggedIn` and the login method are read).
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A command to run, or a one-line hint. */
  fix?: string;
}

export interface DoctorOptions {
  /** The environment the daemon would run with (the app: desktopEnv(); the CLI: its own). */
  env: NodeJS.ProcessEnv;
  /** The Agoryx install: the folder with bin/agoryx.js. */
  root: string;
  /** Also make one real call to each logged-in agent (costs a request each). */
  probe?: boolean;
  /** Per tool call (`--version`, `auth status` …); default 15s. */
  timeoutMs?: number;
  /** Per trial call with `probe`; default 90s. */
  probeTimeoutMs?: number;
}

const MIN_NODE_MAJOR = 22;
const MAX_OUTPUT = 1024 * 1024;
const PROBE_PROMPT = "Reply with the single word OK";

interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  ms: number;
}

/** Runs a tool with no stdin; on timeout its whole process group is killed. Never rejects. */
const runTool = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<ToolResult> =>
  new Promise((resolveRun) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut, ms: Date.now() - started, ...(spawnError ? { spawnError } : {}) });
    };
    // detached: its own process group, so a timeout takes down what it started too.
    const child = spawn(bin, args, { env: options.env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      done(null);
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (error) => done(null, error.message));
    child.on("close", (code) => done(code));
  });

/** An email address in a tool's message is the user's account: never shown. */
const redact = (text: string): string => text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>");

/** The first few non-empty lines of a tool's output, on one line. */
const firstLines = (text: string, count = 3): string =>
  redact(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, count)
      .join(" / "),
  ).slice(0, 300);

const versionOf = (text: string): string | null => /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(text)?.[0] ?? null;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Why a tool call gave no usable answer, in a few words. */
const failure = (result: ToolResult, timeoutMs: number): string => {
  if (result.spawnError) return firstLines(result.spawnError);
  if (result.timedOut) return `no answer within ${seconds(timeoutMs)}`;
  return firstLines(result.stderr) || firstLines(result.stdout) || `exit code ${result.code}`;
};

/** A path as a shell word, for fix commands. */
const quote = (path: string): string => (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** The Agoryx install this module belongs to: the nearest folder up with bin/agoryx.js (source or dist/), or null. */
export const installRoot = (from: string = dirname(fileURLToPath(import.meta.url))): string | null => {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "bin", "agoryx.js"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const check = (id: string, label: string, status: CheckStatus, detail: string, fix?: string): DoctorCheck => ({
  id,
  label,
  status,
  detail,
  ...(fix ? { fix } : {}),
});

/** A check that threw is reported, not raised: the doctor always answers. */
const guarded = async (id: string, label: string, run: () => Promise<DoctorCheck>): Promise<DoctorCheck> => {
  try {
    return await run();
  } catch (error) {
    return check(id, label, "warn", `the check itself failed: ${firstLines(error instanceof Error ? error.message : String(error))}`);
  }
};

interface AgentCheck {
  check: DoctorCheck;
  /** Found and logged in: a room can run it. */
  usable: boolean;
  bin: string | null;
}

export const runDoctor = async (options: DoctorOptions): Promise<DoctorCheck[]> => {
  const { env, root } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 90_000;
  const tool = (bin: string, args: string[], cwd?: string, ms = timeoutMs) => runTool(bin, args, { env, timeoutMs: ms, ...(cwd ? { cwd } : {}) });

  const node = findExecutable("node", env);
  let nodeVersion = "";
  const nodeCheck = guarded("node", "Node.js", async () => {
    if (!node) return check("node", "Node.js", "fail", "not found on PATH", "brew install node");
    const result = await tool(node, ["--version"]);
    const match = /^v?(\d+)\.\d+\.\d+\S*/.exec(result.stdout.trim());
    if (result.code !== 0 || !match) return check("node", "Node.js", "fail", `${node} --version: ${failure(result, timeoutMs)}`, "brew install node");
    nodeVersion = match[0];
    if (Number(match[1]) < MIN_NODE_MAJOR) {
      return check("node", "Node.js", "fail", `${nodeVersion} at ${node}; Agoryx needs Node ${MIN_NODE_MAJOR} or newer`, "brew install node");
    }
    return check("node", "Node.js", "ok", `${nodeVersion} at ${node}`);
  });

  const agoryxCheck = guarded("agoryx", "Agoryx", async () => {
    if (!existsSync(join(root, "bin", "agoryx.js"))) {
      return check("agoryx", "Agoryx", "fail", `no bin/agoryx.js in ${root}`, "reinstall Agoryx: its folder must hold bin/agoryx.js");
    }
    let version = "";
    try {
      version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "";
    } catch {
      // a version is a nicety
    }
    const where = `${version ? `${version} ` : ""}at ${root}`;
    const core = existsSync(join(root, "dist", "cmd", "agoryx", "main.js"));
    const ui = existsSync(join(root, "ui", "dist", "index.html"));
    const cd = `cd ${quote(root)} && `;
    if (!core && !existsSync(join(root, "node_modules", "tsx", "dist", "loader.mjs"))) {
      return check("agoryx", "Agoryx", "fail", `${where}: not built, and no tsx to run it from source`, `${cd}npm install && npm run build`);
    }
    if (!core && !ui) return check("agoryx", "Agoryx", "warn", `${where}: not built (runs from source, slower; the web UI is the older page)`, `${cd}npm run build`);
    if (!core) return check("agoryx", "Agoryx", "warn", `${where}: core not built (runs from source, slower)`, `${cd}npm run build:core`);
    if (!ui) return check("agoryx", "Agoryx", "warn", `${where}: web UI not built (the daemon serves the older page)`, `${cd}npm run build:ui`);
    return check("agoryx", "Agoryx", "ok", where);
  });

  // The daemon's store is better-sqlite3, a native module built for one Node ABI: load it with that node, from root.
  const sqliteCheck = nodeCheck.then((nodeResult) =>
    guarded("sqlite", "SQLite", async () => {
      if (!node || nodeResult.status === "fail") return check("sqlite", "SQLite", "fail", "needs a working Node.js (above)", "brew install node");
      const script = [
        "const path = require('node:path');",
        "const r = require('node:module').createRequire(path.join(process.argv[1], 'package.json'));",
        "const Database = r('better-sqlite3');",
        "new Database(':memory:').close();",
        "let version = '';",
        "try { version = JSON.parse(require('node:fs').readFileSync(path.join(path.dirname(r.resolve('better-sqlite3')), '..', 'package.json'), 'utf8')).version; } catch {}",
        "process.stdout.write(String(version));",
      ].join("\n");
      const result = await tool(node, ["-e", script, root], isDirectory(root) ? root : undefined);
      if (result.code === 0) {
        const version = result.stdout.trim();
        return check("sqlite", "SQLite", "ok", `better-sqlite3${version ? ` ${version}` : ""} loads under Node ${nodeVersion}`);
      }
      const why = failure(result, timeoutMs);
      const missing = /cannot find module/i.test(result.stderr);
      return check("sqlite", "SQLite", "fail", `better-sqlite3 does not load: ${why}`, `cd ${quote(root)} && npm ${missing ? "install" : "rebuild better-sqlite3"}`);
    }),
  );

  const claudeCheck = (async (): Promise<AgentCheck> => {
    const override = env.AGORYX_CLAUDE_BIN?.trim();
    const bin = findExecutable(override || "claude", env);
    const result = await guarded("claude", "Claude Code", async () => {
      if (!bin) {
        // A broken override is fixed by pointing it at the program, not by installing it again.
        if (override) return check("claude", "Claude Code", "warn", "AGORYX_CLAUDE_BIN is not an executable file", "point AGORYX_CLAUDE_BIN at the claude program, or unset it");
        return check("claude", "Claude Code", "warn", "not found on PATH", "curl -fsSL https://claude.ai/install.sh | bash");
      }
      const versionRun = await tool(bin, ["--version"]);
      if (versionRun.code !== 0) return check("claude", "Claude Code", "warn", `${bin} --version: ${failure(versionRun, timeoutMs)}`);
      const version = versionOf(versionRun.stdout) ?? "?";
      const status = await tool(bin, ["auth", "status"]);
      // Only these two fields are read: the rest of the answer names the account.
      let auth: { loggedIn?: unknown; authMethod?: unknown } | null = null;
      try {
        const json = /\{[\s\S]*\}/.exec(status.stdout)?.[0];
        auth = json ? (JSON.parse(json) as { loggedIn?: unknown; authMethod?: unknown }) : null;
      } catch {
        auth = null;
      }
      if (!auth) return check("claude", "Claude Code", "warn", `${version}; cannot tell whether it is logged in (claude auth status: ${failure(status, timeoutMs)})`, "run `claude` and `/login`");
      if (auth.loggedIn !== true) return check("claude", "Claude Code", "warn", `${version}, not logged in`, "run `claude` and `/login`");
      const method = typeof auth.authMethod === "string" && /^[\w. -]{1,32}$/.test(auth.authMethod) ? ` (${auth.authMethod})` : "";
      return check("claude", "Claude Code", "ok", `${version}${method}`);
    });
    return { check: result, usable: result.status === "ok", bin };
  })();

  const codexCheck = (async (): Promise<AgentCheck> => {
    const override = env.AGORYX_CODEX_BIN?.trim();
    const bin = findExecutable(override || "codex", env);
    const result = await guarded("codex", "Codex CLI", async () => {
      if (!bin) {
        if (override) return check("codex", "Codex CLI", "warn", "AGORYX_CODEX_BIN is not an executable file", "point AGORYX_CODEX_BIN at the codex program, or unset it");
        return check("codex", "Codex CLI", "warn", "not found on PATH", "brew install codex (or npm i -g @openai/codex)");
      }
      const versionRun = await tool(bin, ["--version"]);
      if (versionRun.code !== 0) return check("codex", "Codex CLI", "warn", `${bin} --version: ${failure(versionRun, timeoutMs)}`);
      const version = versionOf(versionRun.stdout) ?? "?";
      const status = await tool(bin, ["login", "status"]);
      if (status.code !== 0) return check("codex", "Codex CLI", "warn", `${version}, not logged in`, "codex login");
      // Its message says how, and may say as whom: only the how is kept.
      const said = `${status.stdout}\n${status.stderr}`;
      const method = /chatgpt/i.test(said) ? " (ChatGPT)" : /api key/i.test(said) ? " (API key)" : "";
      return check("codex", "Codex CLI", "ok", `${version}${method}`);
    });
    return { check: result, usable: result.status === "ok", bin };
  })();

  const gitCheck = guarded("git", "git", async () => {
    const fix = "xcode-select --install";
    const why = "worktrees and change tracking need it";
    const git = findExecutable("git", env);
    if (!git) return check("git", "git", "warn", `not found on PATH; ${why}`, fix);
    // macOS's /usr/bin/git is a stub until the Command Line Tools are installed, and running it opens their installer.
    if (process.platform === "darwin" && git === "/usr/bin/git" && existsSync("/usr/bin/xcode-select")) {
      const tools = await tool("/usr/bin/xcode-select", ["-p"]);
      if (tools.code !== 0) return check("git", "git", "warn", `/usr/bin/git needs the Command Line Tools; ${why}`, fix);
    }
    const result = await tool(git, ["--version"]);
    if (result.code !== 0) return check("git", "git", "warn", `${git} --version: ${failure(result, timeoutMs)}; ${why}`, fix);
    return check("git", "git", "ok", `${versionOf(result.stdout) ?? result.stdout.trim()} at ${git}`);
  });

  const homeCheck = guarded("home", "State folder", async () => {
    const home = agoraHome(env);
    const fix = "set AGORYX_HOME to a folder you can write";
    if (existsSync(home)) {
      if (!isDirectory(home)) return check("home", "State folder", "fail", `${home} is not a folder`, fix);
      if (!writable(home)) return check("home", "State folder", "fail", `${home} is not writable`, `chmod u+w ${quote(home)}`);
      return check("home", "State folder", "ok", home);
    }
    let parent = dirname(home);
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    if (!isDirectory(parent) || !writable(parent)) return check("home", "State folder", "fail", `cannot create ${home}: ${parent} is not writable`, fix);
    return check("home", "State folder", "ok", `${home} (created on first start)`);
  });

  const daemonCheck = guarded("daemon", "Daemon", async () => {
    const info = await findDaemon(env);
    if (info) return check("daemon", "Daemon", "ok", `running at ${info.url} (pid ${info.pid})`);
    const stale = readDaemonInfo(env);
    return check("daemon", "Daemon", "ok", stale ? `not running (pid ${stale.pid} in daemon.json does not answer at ${stale.url})` : "not running");
  });

  const [nodeResult, agoryxResult, sqliteResult, claude, codex, gitResult, homeResult, daemonResult] = await Promise.all([
    nodeCheck,
    agoryxCheck,
    sqliteCheck,
    claudeCheck,
    codexCheck,
    gitCheck,
    homeCheck,
    daemonCheck,
  ]);

  const usable = [claude.usable ? "Claude" : "", codex.usable ? "Codex" : ""].filter(Boolean);
  const agents =
    usable.length > 0
      ? check("agents", "Agents", "ok", `${usable.join(" and ")} can join rooms`)
      : check(
          "agents",
          "Agents",
          "fail",
          "neither Claude Code nor Codex is installed and logged in; a room needs at least one",
          // Neither found: Claude's own fix, which names a broken AGORYX_CLAUDE_BIN instead of reinstalling.
          claude.bin || codex.bin ? "log in: run `claude` and `/login`, or `codex login`" : (claude.check.fix ?? "curl -fsSL https://claude.ai/install.sh | bash"),
        );

  const checks = [nodeResult, agoryxResult, sqliteResult, claude.check, codex.check, agents, gitResult, homeResult, daemonResult];
  if (!options.probe) return checks;

  // One real call per logged-in agent, from an empty folder (no project files or instructions to load).
  let scratch: string;
  try {
    scratch = mkdtempSync(join(tmpdir(), "agoryx-doctor-"));
  } catch (error) {
    const why = `no scratch folder for the trial calls: ${firstLines(error instanceof Error ? error.message : String(error))}`;
    return [...checks, check("probe", "Trial calls", "warn", why)];
  }
  try {
    const trial = (id: string, label: string, bin: string, args: string[]) =>
      guarded(id, label, async () => {
        const result = await tool(bin, args, scratch, probeTimeoutMs);
        if (result.code === 0) return check(id, label, "ok", `answered in ${seconds(result.ms)}`);
        return check(id, label, "warn", result.timedOut ? `no answer within ${seconds(probeTimeoutMs)}` : `failed after ${seconds(result.ms)}: ${failure(result, probeTimeoutMs)}`);
      });
    const trials = await Promise.all([
      claude.usable && claude.bin ? trial("claude-probe", "Claude trial call", claude.bin, ["-p", PROBE_PROMPT]) : null,
      codex.usable && codex.bin ? trial("codex-probe", "Codex trial call", codex.bin, ["exec", "--skip-git-repo-check", PROBE_PROMPT]) : null,
    ]);
    return [...checks, ...trials.filter((entry): entry is DoctorCheck => entry !== null)];
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // left in the temp folder
    }
  }
};

const RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

/** The worst status: fail means Agoryx cannot run; warn, that it runs with less. */
export const doctorVerdict = (checks: DoctorCheck[]): CheckStatus =>
  checks.reduce<CheckStatus>((worst, entry) => (RANK[entry.status] > RANK[worst] ? entry.status : worst), "ok");

const ANSI = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };

/** The CLI's lines: a mark, the label, the detail, and a `fix:` line under anything not ok; then the verdict. */
export const formatDoctor = (checks: DoctorCheck[], options: { color: boolean }): string[] => {
  const paint = (code: string, text: string) => (options.color ? `${code}${text}${ANSI.reset}` : text);
  const mark: Record<CheckStatus, string> = { ok: paint(ANSI.green, "✓"), warn: paint(ANSI.yellow, "!"), fail: paint(ANSI.red, "✗") };
  const width = Math.max(0, ...checks.map((entry) => entry.label.length));
  const lines: string[] = [];
  for (const entry of checks) {
    lines.push(`${mark[entry.status]} ${paint(ANSI.bold, entry.label.padEnd(width))}  ${entry.detail}`);
    if (entry.fix && entry.status !== "ok") lines.push(`  ${" ".repeat(width)}  ${paint(ANSI.dim, `fix: ${entry.fix}`)}`);
  }
  const count = (status: CheckStatus) => checks.filter((entry) => entry.status === status).length;
  const verdict = doctorVerdict(checks);
  lines.push("");
  if (verdict === "ok") lines.push(paint(ANSI.green, "Agoryx has everything it needs."));
  else if (verdict === "warn") lines.push(paint(ANSI.yellow, `Agoryx can run; ${count("warn")} warning${count("warn") === 1 ? "" : "s"} above.`));
  else lines.push(paint(ANSI.red, `Agoryx cannot run until ${count("fail") === 1 ? "the ✗ above is" : `the ${count("fail")} ✗ above are`} fixed.`));
  return lines;
};
