import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { runServiceCommand } from "../../cmd/agoryx/service.js";
import { findDaemon, pidAlive } from "../../internal/agora/daemoninfo.js";
import { agoraHome, daemonInfoPath } from "../../internal/agora/paths.js";
import { launchdContext, plistPath, type LaunchctlRun } from "../../internal/desktop/launchd.js";

/**
 * `agoryx service`, end to end against a fake launchd that does what launchd would with the plist: run its
 * ProgramArguments with its EnvironmentVariables, in its WorkingDirectory, output to its log. So the plist
 * really starts a daemon (`up --login-env`, through a fake login shell), in a temp home, on a free port
 * (`--port 0` is the one thing added), and nothing reaches the real ~/Library/LaunchAgents or launchd.
 */

const scratch = mkdtempSync(join(tmpdir(), "agoryx-service-"));
const children: ChildProcess[] = [];

after(() => {
  for (const child of children) {
    if (child.pid && child.exitCode === null && child.signalCode === null && pidAlive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone meanwhile
      }
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

interface Plist {
  ProgramArguments: string[];
  EnvironmentVariables: Record<string, string>;
  WorkingDirectory: string;
  StandardOutPath: string;
}

const readPlist = (file: string): Plist => JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout) as Plist;

/** launchd for one label: bootstrap runs the plist (RunAtLoad); bootout sends SIGTERM, waits, then kills the group; print reports. */
const fakeLaunchd = (home: string) => {
  let child: ChildProcess | null = null;
  let loaded = false;
  const running = () => child !== null && child.exitCode === null && child.signalCode === null;
  const launchctl: LaunchctlRun = async (args) => {
    const [verb, target] = args;
    if (verb === "print") {
      if (!loaded) return { code: 113, stdout: "", stderr: "Could not find service" };
      const lines = [`${target} = {`, `\tstate = ${running() ? "running" : "not running"}`, ...(running() ? [`\tpid = ${child!.pid}`] : []), "}"];
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    }
    if (verb === "bootstrap") {
      if (loaded) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      loaded = true;
      const plist = readPlist(args[2]!);
      const fd = openSync(plist.StandardOutPath, "a");
      child = spawn(plist.ProgramArguments[0]!, [...plist.ProgramArguments.slice(1), "--port", "0"], {
        cwd: plist.WorkingDirectory,
        env: { HOME: home, USER: process.env.USER ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", ...plist.EnvironmentVariables },
        stdio: ["ignore", fd, fd],
        detached: true,
      });
      closeSync(fd);
      children.push(child);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "bootout") {
      if (!loaded) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
      loaded = false;
      if (running()) {
        const exited = new Promise((resolveExit) => child!.once("exit", resolveExit));
        child!.kill("SIGTERM");
        await exited;
      }
      // As launchd does once the job's own process is gone: whatever is left of its group is killed.
      try {
        process.kill(-child!.pid!, "SIGKILL");
      } catch {
        // nothing left
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 64, stdout: "", stderr: `unexpected ${verb}` };
  };
  return { launchctl };
};

test("install runs the daemon from the plist through the login shell, for the plist's home; status sees it; uninstall stops it", { skip: process.platform !== "darwin" && "launchd plists are macOS only" }, async () => {
  const home = join(scratch, "user");
  mkdirSync(home, { recursive: true });
  const elsewhere = join(scratch, "rc-home");
  // A login shell whose rc files export a key-like variable and another AGORYX_HOME.
  const shell = join(scratch, "fake-login-shell");
  writeFileSync(
    shell,
    [
      "#!/bin/sh",
      "export AGORYX_JEV=off",
      `export AGORYX_HOME='${elsewhere}'`,
      "export FROM_RC_FILE=1",
      'shift 3  # -i -l -c',
      'exec /bin/sh -c "$1"',
      "",
    ].join("\n"),
  );
  chmodSync(shell, 0o755);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    SHELL: shell,
    AGORYX_HOME: join(scratch, "agora"),
    AGORYX_WORKSPACES: join(scratch, "workspaces"),
  };
  const fake = fakeLaunchd(home);
  const deps = { env, launchd: { agentsDir: join(scratch, "LaunchAgents"), domain: "gui/501", launchctl: fake.launchctl }, waitMs: 30_000 };
  const ctx = launchdContext(env, deps.launchd);
  const out: string[] = [];
  const run = async (...argv: string[]) => {
    out.length = 0;
    return runServiceCommand(argv, { ...deps, write: (text) => out.push(text ?? "") });
  };

  assert.equal(await run("status"), 0);
  assert.ok(out.includes(`plist    ${plistPath(ctx)} (not installed)`), out.join("\n"));
  assert.ok(out.includes(`daemon   not running (home ${agoraHome(env)})`), out.join("\n"));

  assert.equal(await run("install"), 0, out.join("\n"));
  assert.equal(out[0], `installed the service ${ctx.label}: ${plistPath(ctx)}`);
  const info = await findDaemon(env);
  assert.ok(info, "the plist's daemon answers");
  assert.equal(out.at(-1), `daemon running at ${info.url} (pid ${info.pid})`);
  const log = readFileSync(join(agoraHome(env), "daemon.log"), "utf8");
  assert.match(log, new RegExp(`environment from the login shell \\(${shell.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)`));
  assert.match(log, /Jev off \(AGORYX_JEV=off\)/, "what the login shell exports reaches the daemon");
  assert.ok(existsSync(daemonInfoPath(env)));
  assert.ok(!existsSync(join(elsewhere, "daemon.json")), "the rc file's AGORYX_HOME does not move the service's daemon");

  assert.equal(await run("status", "--json"), 0);
  const status = JSON.parse(out.join("\n")) as { installed: boolean; loaded: boolean; state: string; daemon: { pid: number; byService: boolean } };
  assert.deepEqual([status.installed, status.loaded, status.state, status.daemon.pid, status.daemon.byService], [true, true, "running", info.pid, true]);

  assert.equal(await run("install"), 0);
  assert.equal(out[0], `the service ${ctx.label} is installed and loaded; nothing changed`);
  assert.equal((await findDaemon(env))?.pid, info.pid, "an unchanged install keeps the daemon");

  assert.equal(await run("uninstall"), 0);
  assert.match(out[0]!, new RegExp(`^removed the service ${ctx.label.replace(/\./g, "\\.")}`));
  assert.ok(!existsSync(plistPath(ctx)));
  for (let i = 0; i < 100 && pidAlive(info.pid); i += 1) await sleep(100);
  assert.equal(pidAlive(info.pid), false, "SIGTERM from launchd ends the daemon");
  assert.ok(!existsSync(daemonInfoPath(env)), "the daemon closed on its own, not killed with the group");
  assert.match(readFileSync(join(agoraHome(env), "daemon.log"), "utf8"), /SIGTERM: stopping running turns and closing rooms/);
  assert.equal(await findDaemon(env), null);
  assert.equal(await run("uninstall"), 0);
  assert.equal(out[0], `no service ${ctx.label} was installed`);
});

test("agoryx service: macOS only, and one of install, uninstall, status", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (text: string) => errors.push(text);
  try {
    assert.equal(await runServiceCommand(["status"], { platform: "linux", write: () => {} }), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors.join("\n"), /needs macOS \(launchd\)/);
  await assert.rejects(runServiceCommand(["start"], { write: () => {} }), /Unknown service action: start/);
  await assert.rejects(runServiceCommand(["status", "extra"], { write: () => {} }), /Unexpected argument: extra/);
  const help: string[] = [];
  assert.equal(await runServiceCommand(["--help"], { write: (text) => help.push(text ?? "") }), 0);
  assert.match(help.join("\n"), /agoryx service install/);
});
