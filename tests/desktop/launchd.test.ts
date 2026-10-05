import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  installService,
  kickstartService,
  launchdContext,
  launchdService,
  parseLaunchctlPrint,
  parsePlistProgram,
  plistPath,
  renderPlist,
  SERVICE_LABEL,
  serviceLabel,
  serviceSpec,
  serviceStatus,
  uninstallService,
  type LaunchctlRun,
  type LaunchdContext,
} from "../../internal/desktop/launchd.js";

/**
 * The LaunchAgent, against a fake launchctl and a temp LaunchAgents folder: nothing here reaches the
 * real ~/Library/LaunchAgents or launchd.
 */

const scratch = mkdtempSync(join(tmpdir(), "agoryx-launchd-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SECRET = "sk-test-never-in-a-plist-0123456789";

const PRINT = (pid?: number, exit = "(never exited)") =>
  [
    "gui/501/dev.agoryx.daemon = {",
    "\tactive count = 1",
    "\tpath = /Users/x/Library/LaunchAgents/dev.agoryx.daemon.plist",
    `\tstate = ${pid ? "running" : "not running"}`,
    "\tenvironment = {",
    "\t\tstate = nested-and-ignored",
    "\t\tpid = 1",
    "\t}",
    ...(pid ? [`\tpid = ${pid}`] : []),
    `\tlast exit code = ${exit}`,
    "}",
  ].join("\n");

/** launchd, as far as these commands go: bootstrap loads, bootout unloads (3 when not loaded), print finds. */
const fakeLaunchd = () => {
  const state = { loaded: false, pid: undefined as number | undefined, exit: "(never exited)", bootstrapFails: false, calls: [] as string[][] };
  const launchctl: LaunchctlRun = async (args) => {
    state.calls.push(args);
    const [verb] = args;
    if (verb === "print") return state.loaded ? { code: 0, stdout: PRINT(state.pid, state.exit), stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
    if (verb === "bootstrap") {
      if (state.bootstrapFails) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\nTry re-running the command as root" };
      if (state.loaded) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      state.loaded = true;
      state.pid = 4242;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "bootout") {
      if (!state.loaded) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
      state.loaded = false;
      state.pid = undefined;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "kickstart") return state.loaded ? { code: 0, stdout: "", stderr: "" } : { code: 113, stdout: "", stderr: "Could not find service" };
    return { code: 64, stdout: "", stderr: "unknown" };
  };
  return { state, launchctl };
};

let count = 0;
const setup = (extra: NodeJS.ProcessEnv = {}) => {
  const dir = join(scratch, `case-${(count += 1)}`);
  const env: NodeJS.ProcessEnv = {
    HOME: join(dir, "home"),
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:relative/bin",
    SHELL: "/bin/zsh",
    AGORYX_HOME: join(dir, "agora"),
    ANTHROPIC_API_KEY: SECRET,
    TYPESAFE_API_KEY: SECRET,
    SECRET_TOKEN: SECRET,
    ...extra,
  };
  const fake = fakeLaunchd();
  const ctx: LaunchdContext = launchdContext(env, { agentsDir: join(dir, "LaunchAgents"), domain: "gui/501", launchctl: fake.launchctl });
  return { dir, env, ctx, fake };
};

test("serviceLabel: dev.agoryx.daemon for the default home, a stable hash of the path for any other", () => {
  assert.equal(serviceLabel({ HOME: "/Users/x" }), SERVICE_LABEL);
  assert.equal(serviceLabel({ HOME: "/Users/x", AGORYX_HOME: "/Users/x/.local/state/agoryx/agora" }), SERVICE_LABEL);
  const other = serviceLabel({ HOME: "/Users/x", AGORYX_HOME: "/tmp/elsewhere" });
  assert.match(other, /^dev\.agoryx\.daemon\.[0-9a-f]{8}$/);
  assert.equal(serviceLabel({ HOME: "/Users/y", AGORYX_HOME: "/tmp/elsewhere" }), other);
  assert.notEqual(serviceLabel({ HOME: "/Users/x", AGORYX_HOME: "/tmp/elsewhere-2" }), other);
  assert.notEqual(serviceLabel({ HOME: "/Users/x", XDG_STATE_HOME: "/Users/x/state" }), SERVICE_LABEL);
});

test("the plist: node runs this install's `up --login-env`; PATH, SHELL and the home only — never a key", () => {
  const { ctx, env } = setup({ AGORYX_WORKSPACES: "/Users/x/rooms & more" });
  const root = "/Applications/Agoryx & Co/<core>";
  const spec = serviceSpec({ ctx, root, node: "/opt/node 22/bin/node" });
  assert.deepEqual(spec.program, ["/opt/node 22/bin/node", `${root}/bin/agoryx.js`, "up", "--login-env"]);
  assert.equal(spec.environment.PATH, "/opt/node 22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.deepEqual(Object.keys(spec.environment).sort(), ["AGORYX_HOME", "AGORYX_WORKSPACES", "PATH", "SHELL"]);
  assert.equal(spec.logPath, join(env.AGORYX_HOME!, "daemon.log"));
  const text = renderPlist(spec);
  assert.ok(!text.includes(SECRET), "no environment value but PATH, SHELL and the home");
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.ok(text.includes("Agoryx &amp; Co/&lt;core&gt;/bin/agoryx.js"));
  assert.deepEqual(parsePlistProgram(text), spec.program);
  if (existsSync("/usr/bin/plutil")) {
    const file = join(scratch, "lint.plist");
    writeFileSync(file, text);
    const lint = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const json = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    const parsed = JSON.parse(json.stdout) as { ProgramArguments: string[]; EnvironmentVariables: Record<string, string>; StandardOutPath: string };
    assert.deepEqual(parsed.ProgramArguments, spec.program);
    assert.deepEqual(parsed.EnvironmentVariables, spec.environment);
    assert.equal(parsed.StandardOutPath, spec.logPath);
  }
});

test("parseLaunchctlPrint reads the service's own state, pid and last exit code, not nested blocks'", () => {
  assert.deepEqual(parseLaunchctlPrint(PRINT(77)), { state: "running", pid: 77, lastExitCode: "(never exited)" });
  assert.deepEqual(parseLaunchctlPrint(PRINT(undefined, "1")), { state: "not running", lastExitCode: "1" });
});

test("install writes and loads; the same plist again changes nothing; a new one reloads; uninstall removes it", async () => {
  const { ctx, fake, env } = setup();
  const root = join(scratch, "install");
  const status0 = await serviceStatus(ctx);
  assert.deepEqual([status0.installed, status0.loaded, status0.missing], [false, false, []]);

  const first = await installService({ ctx, root, node: process.execPath });
  assert.deepEqual([first.written, first.reloaded, first.status.installed, first.status.loaded, first.status.pid], [true, false, true, true, 4242]);
  assert.deepEqual(fake.state.calls.map((call) => call[0]), ["print", "print", "bootstrap", "print"]);
  assert.deepEqual(fake.state.calls[2], ["bootstrap", "gui/501", plistPath(ctx)]);
  assert.ok(existsSync(dirname(join(env.AGORYX_HOME!, "daemon.log"))), "the log's folder exists before launchd opens it");
  assert.equal(statSync(plistPath(ctx)).mode & 0o777, 0o644);
  assert.deepEqual(first.status.missing, [join(root, "bin", "agoryx.js")], "an install without bin/agoryx.js shows as missing");

  fake.state.calls = [];
  const again = await installService({ ctx, root, node: process.execPath });
  assert.deepEqual([again.written, again.reloaded], [false, false]);
  assert.ok(!fake.state.calls.some((call) => call[0] === "bootout" || call[0] === "bootstrap"), "a loaded, unchanged service keeps its daemon");

  fake.state.calls = [];
  const moved = await installService({ ctx, root, node: "/opt/other/node" });
  assert.deepEqual([moved.written, moved.reloaded], [true, true]);
  assert.deepEqual(fake.state.calls.filter((call) => call[0] !== "print"), [["bootout", `gui/501/${ctx.label}`], ["bootstrap", "gui/501", plistPath(ctx)]]);
  assert.equal(parsePlistProgram(readFileSync(plistPath(ctx), "utf8"))?.[0], "/opt/other/node");
  assert.ok((await serviceStatus(ctx)).missing.includes("/opt/other/node"));

  const removed = await uninstallService(ctx);
  assert.deepEqual(removed, { removed: true, unloaded: true });
  assert.ok(!existsSync(plistPath(ctx)));
  assert.deepEqual(await uninstallService(ctx), { removed: false, unloaded: false });
});

test("a plist that is there but not loaded is loaded again by install; a failed bootstrap says why", async () => {
  const { ctx, fake } = setup();
  await installService({ ctx, root: scratch, node: process.execPath });
  fake.state.loaded = false;
  const status = await serviceStatus(ctx);
  assert.deepEqual([status.installed, status.loaded], [true, false]);
  const reload = await installService({ ctx, root: scratch, node: process.execPath });
  assert.deepEqual([reload.written, reload.reloaded, reload.status.loaded], [false, false, true]);

  const broken = setup();
  broken.fake.state.bootstrapFails = true;
  await assert.rejects(installService({ ctx: broken.ctx, root: scratch, node: process.execPath }), /launchctl bootstrap failed \(5\): Bootstrap failed: 5: Input\/output error$/);
});

test("launchdService: not loaded without a plist (launchd is not even asked); kickstart asks launchd", async () => {
  const { env, ctx, fake } = setup();
  const service = launchdService(env, { agentsDir: ctx.agentsDir, domain: ctx.domain, launchctl: fake.launchctl })!;
  assert.equal(service.label, ctx.label);
  assert.equal(await service.loaded(), false);
  assert.deepEqual(fake.state.calls, []);
  await installService({ ctx, root: scratch, node: process.execPath });
  assert.equal(await service.loaded(), true);
  fake.state.calls = [];
  await service.kickstart();
  assert.deepEqual(fake.state.calls, [["kickstart", `gui/501/${ctx.label}`]]);
  await uninstallService(ctx);
  await assert.rejects(kickstartService(ctx), /launchctl kickstart failed \(113\)/);
});
