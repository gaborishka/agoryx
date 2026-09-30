import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pidAlive } from "../../internal/agora/daemoninfo.js";
import { doctorVerdict, formatDoctor, installRoot, runDoctor, type DoctorCheck } from "../../internal/desktop/doctor.js";
import { launchdContext, plistPath, renderPlist, serviceSpec, type LaunchctlRun } from "../../internal/desktop/launchd.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "agoryx-doctor-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Whatever the doctor prints must never hold these: the account behind a login, or an environment value.
const EMAIL = "someone.private@example.com";
const SECRET = "sk-test-do-not-print-0123456789";

let binCount = 0;

/** A folder of fake tools; `node` is the real one unless replaced. */
const makeBin = (tools: Record<string, string>, options: { node?: boolean } = {}): string => {
  const dir = join(scratch, `bin-${(binCount += 1)}`);
  mkdirSync(dir, { recursive: true });
  if (options.node !== false) symlinkSync(process.execPath, join(dir, "node"));
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
};

const CLAUDE_IN = [
  'case "$1" in',
  '  --version) echo "2.1.283 (Claude Code)" ;;',
  `  auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "${EMAIL}", "orgName": "Private Org"}' ;;`,
  "  -p) echo OK ;;",
  "esac",
].join("\n");
const CLAUDE_OUT = [
  'case "$1" in',
  '  --version) echo "2.1.283 (Claude Code)" ;;',
  `  auth) echo '{"loggedIn": false, "authMethod": "none"}'; exit 1 ;;`,
  "esac",
].join("\n");
const CODEX_IN = [
  'case "$1" in',
  '  --version) echo "codex-cli 0.130.0" ;;',
  `  login) echo "Logged in using ChatGPT (${EMAIL})" >&2 ;;`,
  "  exec) echo OK ;;",
  "esac",
].join("\n");
const CODEX_OUT = [
  'case "$1" in',
  '  --version) echo "codex-cli 0.130.0" ;;',
  "  login) echo 'Not logged in' >&2; exit 1 ;;",
  "esac",
].join("\n");
const GIT = 'echo "git version 2.50.1"';

/** The env a daemon would get: only this PATH, a fresh AGORYX_HOME, and a secret that must stay unseen. */
const envFor = (bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: bin,
  HOME: scratch,
  AGORYX_HOME: join(mkdtempSync(join(scratch, "home-")), "agora"),
  SECRET_TOKEN: SECRET,
  ...extra,
});

const byId = (checks: DoctorCheck[]): Record<string, DoctorCheck> => Object.fromEntries(checks.map((entry) => [entry.id, entry]));

const assertPrivate = (checks: DoctorCheck[]) => {
  const text = JSON.stringify(checks) + formatDoctor(checks, { color: false }).join("\n");
  assert.ok(!text.includes(EMAIL), "the account's email is never shown");
  assert.ok(!text.includes("Private Org"), "nor its organisation");
  assert.ok(!text.includes(SECRET), "nor an environment value");
};

test("installRoot: the folder with bin/agoryx.js above this module", () => {
  assert.equal(installRoot(), ROOT);
  assert.equal(installRoot(join(ROOT, "internal", "desktop")), ROOT);
  assert.equal(installRoot("/"), null);
});

test("everything present and logged in: every check passes, in order, and names versions and login methods only", async () => {
  const bin = makeBin({ claude: CLAUDE_IN, codex: CODEX_IN, git: GIT });
  const env = envFor(bin);
  const checks = await runDoctor({ env, root: ROOT });
  assert.deepEqual(
    checks.map((entry) => entry.id),
    ["node", "agoryx", "sqlite", "claude", "codex", "agents", "git", "home", "daemon", ...(process.platform === "darwin" ? ["service"] : [])],
  );
  const check = byId(checks);
  assert.equal(check.node!.status, "ok");
  assert.match(check.node!.detail, new RegExp(`^${process.version.replace(/\./g, "\\.")} at `));
  assert.equal(check.sqlite!.status, "ok", check.sqlite!.detail);
  assert.match(check.sqlite!.detail, /better-sqlite3 \d+\.\d+\.\d+ loads under Node v\d+/);
  assert.deepEqual([check.claude!.status, check.claude!.detail], ["ok", "2.1.283 (claude.ai)"]);
  assert.deepEqual([check.codex!.status, check.codex!.detail], ["ok", "0.130.0 (ChatGPT)"]);
  assert.deepEqual([check.agents!.status, check.agents!.detail], ["ok", "Claude and Codex can join rooms"]);
  assert.deepEqual([check.git!.status, check.git!.detail], ["ok", `2.50.1 at ${join(bin, "git")}`]);
  assert.deepEqual([check.home!.status, check.home!.detail], ["ok", `${env.AGORYX_HOME} (created on first start)`]);
  assert.deepEqual([check.daemon!.status, check.daemon!.detail], ["ok", "not running"]);
  if (process.platform === "darwin") {
    assert.deepEqual([check.service!.status, check.service!.detail], ["ok", "not installed (`agoryx service install` starts the daemon at login)"]);
  }
  assert.notEqual(check.agoryx!.status, "fail", check.agoryx!.detail);
  assert.notEqual(doctorVerdict(checks), "fail");
  assertPrivate(checks);
});

test("logged out everywhere: warnings with the login command each, and a fail for having no agent", async () => {
  const checks = byId(await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_OUT, codex: CODEX_OUT, git: GIT })), root: ROOT }));
  assert.deepEqual(
    [checks.claude!.status, checks.claude!.detail, checks.claude!.fix],
    ["warn", "2.1.283, not logged in", "run `claude` and `/login`"],
  );
  assert.deepEqual([checks.codex!.status, checks.codex!.detail, checks.codex!.fix], ["warn", "0.130.0, not logged in", "codex login"]);
  assert.equal(checks.agents!.status, "fail");
  assert.match(checks.agents!.fix!, /claude.*\/login.*codex login/);
});

test("one agent is enough: the other one missing is a warning with its install command", async () => {
  const checks = await runDoctor({ env: envFor(makeBin({ codex: CODEX_IN, git: GIT })), root: ROOT });
  const check = byId(checks);
  assert.deepEqual(
    [check.claude!.status, check.claude!.detail, check.claude!.fix],
    ["warn", "not found on PATH", "curl -fsSL https://claude.ai/install.sh | bash"],
  );
  assert.deepEqual([check.agents!.status, check.agents!.detail], ["ok", "Codex can join rooms"]);
  assert.notEqual(doctorVerdict(checks), "fail");
});

test("nothing installed but node: no agent is a fail; git and the agents say how to install them", async () => {
  const checks = await runDoctor({ env: envFor(makeBin({})), root: ROOT });
  const check = byId(checks);
  assert.equal(check.claude!.status, "warn");
  assert.deepEqual([check.codex!.status, check.codex!.fix], ["warn", "brew install codex (or npm i -g @openai/codex)"]);
  assert.equal(check.agents!.status, "fail");
  assert.equal(check.agents!.fix, "curl -fsSL https://claude.ai/install.sh | bash");
  assert.deepEqual([check.git!.status, check.git!.fix], ["warn", "xcode-select --install"]);
  assert.equal(doctorVerdict(checks), "fail");
});

test("an old node fails, and so does SQLite, which needs it", async () => {
  const bin = makeBin({ node: 'echo "v20.11.1"', claude: CLAUDE_IN, git: GIT }, { node: false });
  const check = byId(await runDoctor({ env: envFor(bin), root: ROOT }));
  assert.deepEqual([check.node!.status, check.node!.fix], ["fail", "brew install node"]);
  assert.match(check.node!.detail, /^v20\.11\.1 at .*; Agoryx needs Node 22 or newer$/);
  assert.equal(check.sqlite!.status, "fail");
});

test("no node at all: a fail with the install command", async () => {
  const check = byId(await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_IN }, { node: false })), root: ROOT }));
  assert.deepEqual([check.node!.status, check.node!.detail, check.node!.fix], ["fail", "not found on PATH", "brew install node"]);
});

test("an install without bin/agoryx.js or better-sqlite3 fails, and says what to run there", async () => {
  const root = mkdtempSync(join(scratch, "not-agoryx-"));
  const check = byId(await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_IN })), root }));
  assert.equal(check.agoryx!.status, "fail");
  assert.match(check.agoryx!.detail, /no bin\/agoryx\.js/);
  assert.equal(check.sqlite!.status, "fail");
  assert.match(check.sqlite!.detail, /^better-sqlite3 does not load: /);
  assert.equal(check.sqlite!.fix, `cd ${root} && npm install`);
});

test("an install that is not built: a warning with the build command", async () => {
  const root = mkdtempSync(join(scratch, "unbuilt-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "agoryx.js"), "");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
  mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true });
  writeFileSync(join(root, "node_modules", "tsx", "dist", "loader.mjs"), "");
  const check = byId(await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_IN })), root })).agoryx!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /^9\.8\.7 at .*: not built/);
  assert.equal(check.fix, `cd ${root} && npm run build`);
});

test("AGORYX_CLAUDE_BIN is used when set, and never printed when it is not a program", async () => {
  const bin = makeBin({ codex: CODEX_IN });
  const elsewhere = makeBin({ "my-claude": CLAUDE_IN });
  const found = byId(await runDoctor({ env: envFor(bin, { AGORYX_CLAUDE_BIN: join(elsewhere, "my-claude") }), root: ROOT }));
  assert.deepEqual([found.claude!.status, found.claude!.detail], ["ok", "2.1.283 (claude.ai)"]);

  const checks = await runDoctor({ env: envFor(bin, { AGORYX_CLAUDE_BIN: SECRET }), root: ROOT });
  const check = byId(checks);
  assert.deepEqual([check.claude!.status, check.claude!.detail], ["warn", "AGORYX_CLAUDE_BIN is not an executable file"]);
  // Installing Claude again would not help: the override is what is wrong.
  assert.equal(check.claude!.fix, "point AGORYX_CLAUDE_BIN at the claude program, or unset it");
  assertPrivate(checks);
});

test("both overrides broken: no check tells the user to install an agent again", async () => {
  const bin = makeBin({ claude: CLAUDE_IN, codex: CODEX_IN });
  const checks = byId(await runDoctor({ env: envFor(bin, { AGORYX_CLAUDE_BIN: "/nonexistent/claude", AGORYX_CODEX_BIN: "/nonexistent/codex" }), root: ROOT }));
  assert.equal(checks.codex!.fix, "point AGORYX_CODEX_BIN at the codex program, or unset it");
  assert.equal(checks.agents!.status, "fail");
  assert.equal(checks.agents!.fix, "point AGORYX_CLAUDE_BIN at the claude program, or unset it");
});

test("an email in a tool's error is masked", async () => {
  const claude = ['case "$1" in', '  --version) echo "2.1.283 (Claude Code)" ;;', `  auth) echo "session expired for ${EMAIL}" >&2; exit 1 ;;`, "esac"].join("\n");
  const checks = await runDoctor({ env: envFor(makeBin({ claude })), root: ROOT });
  const check = byId(checks).claude!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /cannot tell whether it is logged in .*session expired for <email>/);
  assertPrivate(checks);
});

test("a tool that hangs is cut off at the timeout with what it started, and the doctor still answers", async () => {
  const pids = join(scratch, "hanging.pids");
  const claude = `case "$1" in --version) echo $$ > "${pids}"; /bin/sleep 30 & echo $! >> "${pids}"; wait ;; esac`;
  const started = Date.now();
  // Long enough for the fake tool to have started (and written its pids) under a loaded full test run.
  const check = byId(await runDoctor({ env: envFor(makeBin({ claude, codex: CODEX_IN })), root: ROOT, timeoutMs: 2000 })).claude!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /--version: no answer within 2\.0s$/);
  assert.ok(Date.now() - started < 10_000);
  const [tool, child] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  const deadline = Date.now() + 3000;
  while ((pidAlive(tool!) || pidAlive(child!)) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(pidAlive(tool!), false);
  assert.equal(pidAlive(child!), false);
});

test("the state folder must be a writable folder", async () => {
  const file = join(scratch, "home-is-a-file");
  writeFileSync(file, "");
  const check = byId(await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_IN }), { AGORYX_HOME: file }), root: ROOT })).home!;
  assert.deepEqual([check.status, check.detail], ["fail", `${file} is not a folder`]);

  const existing = mkdtempSync(join(scratch, "home-ok-"));
  const ok = byId(await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_IN }), { AGORYX_HOME: existing }), root: ROOT })).home!;
  assert.deepEqual([ok.status, ok.detail], ["ok", existing]);
});

test("a daemon.json whose daemon does not answer is reported, not trusted", async () => {
  const port = await new Promise<number>((resolvePort) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
  const home = mkdtempSync(join(scratch, "stale-"));
  // This test's own pid: alive, but nothing answers at that port.
  writeFileSync(
    join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}`, token: SECRET, startedAt: new Date().toISOString() }),
  );
  const checks = await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_IN }), { AGORYX_HOME: home }), root: ROOT });
  const check = byId(checks).daemon!;
  assert.equal(check.status, "ok");
  assert.equal(check.detail, `not running (pid ${process.pid} in daemon.json does not answer at http://127.0.0.1:${port})`);
  assertPrivate(checks);
});

test("probe: one trial call per logged-in agent, timed; a failing one is a warning with its (masked) error", async () => {
  const codex = [
    'case "$1" in',
    '  --version) echo "codex-cli 0.130.0" ;;',
    "  login) echo 'Logged in using an API key' ;;",
    `  exec) echo "stream error: 401 for ${EMAIL}" >&2; exit 1 ;;`,
    "esac",
  ].join("\n");
  const checks = await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_IN, codex })), root: ROOT, probe: true });
  const check = byId(checks);
  assert.deepEqual(checks.slice(-2).map((entry) => entry.id), ["claude-probe", "codex-probe"]);
  assert.equal(check.codex!.detail, "0.130.0 (API key)");
  assert.equal(check["claude-probe"]!.status, "ok");
  assert.match(check["claude-probe"]!.detail, /^answered in \d+\.\ds$/);
  assert.equal(check["codex-probe"]!.status, "warn");
  assert.match(check["codex-probe"]!.detail, /^failed after \d+\.\ds: stream error: 401 for <email>$/);
  assertPrivate(checks);

  const without = await runDoctor({ env: envFor(makeBin({ claude: CLAUDE_OUT, codex })), root: ROOT, probe: true });
  assert.deepEqual(without.filter((entry) => entry.id.endsWith("-probe")).map((entry) => entry.id), ["codex-probe"], "only logged-in agents are called");
});

test("doctorVerdict is the worst status", () => {
  const at = (status: DoctorCheck["status"]): DoctorCheck => ({ id: status, label: status, status, detail: "" });
  assert.equal(doctorVerdict([]), "ok");
  assert.equal(doctorVerdict([at("ok"), at("ok")]), "ok");
  assert.equal(doctorVerdict([at("ok"), at("warn")]), "warn");
  assert.equal(doctorVerdict([at("warn"), at("fail"), at("ok")]), "fail");
});

test("formatDoctor: a mark, the label, the detail, a fix line under what is not ok, then the verdict", () => {
  const checks: DoctorCheck[] = [
    { id: "node", label: "Node.js", status: "ok", detail: "v26.8.1 at /opt/homebrew/bin/node", fix: "unused" },
    { id: "codex", label: "Codex CLI", status: "warn", detail: "0.130.0, not logged in", fix: "codex login" },
    { id: "agents", label: "Agents", status: "fail", detail: "no agent", fix: "run `claude` and `/login`" },
  ];
  assert.deepEqual(formatDoctor(checks, { color: false }), [
    "✓ Node.js    v26.8.1 at /opt/homebrew/bin/node",
    "! Codex CLI  0.130.0, not logged in",
    "             fix: codex login",
    "✗ Agents     no agent",
    "             fix: run `claude` and `/login`",
    "",
    "Agoryx cannot run until the ✗ above is fixed.",
  ]);
  assert.equal(formatDoctor(checks.slice(0, 2), { color: false }).at(-1), "Agoryx can run; 1 warning above.");
  assert.equal(formatDoctor(checks.slice(0, 1), { color: false }).at(-1), "Agoryx has everything it needs.");
  assert.ok(formatDoctor(checks, { color: true }).some((line) => line.includes("\x1b[")));
  assert.ok(!formatDoctor(checks, { color: false }).some((line) => line.includes("\x1b[")));
});

const runCli = (args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveRun, reject) => {
    const loader = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
    const child = spawn(process.execPath, ["--no-deprecation", "--import", loader, join(ROOT, "cmd", "agoryx", "main.ts"), ...args], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("agoryx doctor timed out"));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });

test("`agoryx doctor`: the lines, or JSON; exit 1 only when Agoryx cannot run", async () => {
  const good = envFor(makeBin({ claude: CLAUDE_IN, codex: CODEX_IN, git: GIT }), { AGORYX_WORKSPACES: join(scratch, "ws") });
  const text = await runCli(["doctor"], good);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^✓ Claude Code +2\.1\.283 \(claude\.ai\)$/m);
  assert.doesNotMatch(text.stdout, /\x1b\[/, "no colour when stdout is not a terminal");
  assert.ok(!text.stdout.includes(EMAIL) && !text.stdout.includes(SECRET));

  const json = await runCli(["doctor", "--json"], good);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as { verdict: string; checks: DoctorCheck[] };
  assert.notEqual(parsed.verdict, "fail");
  assert.equal(parsed.checks.find((entry) => entry.id === "codex")?.detail, "0.130.0 (ChatGPT)");

  const bad = await runCli(["doctor", "--json"], envFor(makeBin({})));
  assert.equal(bad.code, 1);
  assert.equal((JSON.parse(bad.stdout) as { verdict: string }).verdict, "fail");

  const help = await runCli(["doctor", "--help"], good);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /agoryx doctor \[--probe\] \[--json\]/);

  const wrong = await runCli(["doctor", "--prob"], good);
  assert.equal(wrong.code, 2);
});

test("login service (macOS): installed and running is ok; stopped after a failure, unloaded or pointing at a moved install is a warning", { skip: process.platform !== "darwin" && "launchd is macOS only" }, async () => {
  const env = envFor(makeBin({ claude: CLAUDE_IN }));
  const launchd = { agentsDir: join(scratch, "LaunchAgents"), domain: "gui/501" };
  const service = async (print: { code: number; stdout?: string }) => {
    const launchctl: LaunchctlRun = async () => ({ code: print.code, stdout: print.stdout ?? "", stderr: "" });
    return byId(await runDoctor({ env, root: ROOT, launchd: { ...launchd, launchctl } })).service!;
  };
  const ctx = launchdContext(env, launchd);
  mkdirSync(launchd.agentsDir, { recursive: true });
  writeFileSync(plistPath(ctx), renderPlist(serviceSpec({ ctx, root: ROOT, node: process.execPath })));
  const printed = (lines: string[]) => ({ code: 0, stdout: [`gui/501/${ctx.label} = {`, ...lines.map((line) => `\t${line}`), "}"].join("\n") });

  const running = await service(printed(["state = running", "pid = 4242"]));
  assert.deepEqual([running.status, running.detail], ["ok", `${ctx.label}, running (pid 4242)`]);
  const crashed = await service(printed(["state = not running", "last exit code = 1"]));
  assert.deepEqual([crashed.status, crashed.detail], ["warn", `${ctx.label}, not running (last exit code 1)`]);
  assert.match(crashed.fix!, /daemon\.log.*agoryx service status$/);
  const stopped = await service(printed(["state = not running", "last exit code = 0"]));
  assert.deepEqual([stopped.status, stopped.detail], ["ok", `${ctx.label}, not running now (\`agoryx up -d\` starts it through launchd)`]);
  const unloaded = await service({ code: 113 });
  assert.deepEqual([unloaded.status, unloaded.fix], ["warn", "agoryx service install"]);

  writeFileSync(plistPath(ctx), renderPlist(serviceSpec({ ctx, root: join(scratch, "moved-away"), node: process.execPath })));
  const moved = await service(printed(["state = not running"]));
  assert.deepEqual([moved.status, moved.detail, moved.fix], ["warn", `${ctx.label} runs ${join(scratch, "moved-away", "bin", "agoryx.js")}, which no longer exists`, "agoryx service install"]);
});
