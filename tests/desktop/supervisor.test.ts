import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DaemonClient } from "../../internal/agora/client.js";
import { findDaemon, pidAlive, readDaemonInfo, type DaemonInfo } from "../../internal/agora/daemoninfo.js";
import { agoraHome, daemonInfoPath, DEFAULT_PORT } from "../../internal/agora/paths.js";
import { DaemonStartError, DaemonSupervisor, type DaemonSupervisorEvents, type DaemonSupervisorOptions, type SpawnLike } from "../../internal/desktop/supervisor.js";

/**
 * Against a real `bin/agoryx.js up`: each test has its own AGORYX_HOME in a temp folder and asks for a
 * free port (`up --port 0`, the supervisor's `port: 0`), so it never meets the user's daemon (default
 * home, port 7717). Every daemon started here is stopped in after(), failed test or not.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "agoryx-supervisor-"));

/** The test process's env without any Agoryx variable (an agent running the suite has its room's). */
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGORYX_") && key !== "CLAUDECODE"));

const envs: NodeJS.ProcessEnv[] = [];
const spawned: ChildProcess[] = [];
const supervisors: DaemonSupervisor[] = [];

const homeEnv = (name: string): NodeJS.ProcessEnv => {
  const home = join(scratch, name);
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    AGORYX_HOME: home,
    AGORYX_WORKSPACES: join(scratch, `${name}-workspaces`),
    // No Jev calls from a test daemon, whatever .env holds.
    AGORYX_JEV: "off",
  };
  assert.ok(agoraHome(env).startsWith(scratch), "a test daemon lives in the temp folder only");
  envs.push(env);
  return env;
};

/** Records every process a supervisor starts, so after() can end what an API stop did not. */
const recordingSpawn: SpawnLike = (command, args, options) => {
  const child = spawn(command, args, options);
  spawned.push(child);
  return child;
};

const supervise = (env: NodeJS.ProcessEnv, options: Partial<DaemonSupervisorOptions> = {}): DaemonSupervisor => {
  const supervisor = new DaemonSupervisor({ root: ROOT, node: process.execPath, env, port: 0, pollMs: 150, spawnImpl: recordingSpawn, ...options });
  supervisors.push(supervisor);
  return supervisor;
};

const sleep = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const waitFor = async (what: string, ready: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A port nothing listens on (it did a moment ago). */
const closedPort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });

type Seen = { [K in keyof DaemonSupervisorEvents]: { event: K; args: DaemonSupervisorEvents[K] } }[keyof DaemonSupervisorEvents];

const record = (supervisor: DaemonSupervisor): Seen[] => {
  const seen: Seen[] = [];
  supervisor.on("up", (info) => seen.push({ event: "up", args: [info] }));
  supervisor.on("changed", (info) => seen.push({ event: "changed", args: [info] }));
  supervisor.on("down", () => seen.push({ event: "down", args: [] }));
  supervisor.on("failed", (failure) => seen.push({ event: "failed", args: [failure] }));
  return seen;
};

/** Stops a test home's daemon through its API (the pid must answer /api/health first). */
const stopDaemon = async (env: NodeJS.ProcessEnv): Promise<void> => {
  const info = await findDaemon(env);
  if (!info) return;
  await new DaemonClient(info).down().catch(() => undefined);
  await waitFor(`pid ${info.pid} to exit`, () => !pidAlive(info.pid), 15_000).catch(() => undefined);
};

after(async () => {
  // Starts still under way end first: their daemons are stopped below too.
  await Promise.all(supervisors.map((supervisor) => supervisor.dispose()));
  for (const env of envs) await stopDaemon(env);
  // Anything still running that these tests started (only their own children's process groups).
  for (const child of spawned) {
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

test("start, attach, a restart elsewhere, a crash, stop: the supervisor follows the one daemon of its home", async () => {
  const env = homeEnv("lifecycle");
  const first = supervise(env);
  const info = await first.start();
  assert.notEqual(info.port, DEFAULT_PORT);
  assert.equal((await findDaemon(env))?.pid, info.pid);
  assert.equal(first.info?.pid, info.pid);
  assert.equal(spawned.length, 1);
  assert.equal(first.logPath(), join(agoraHome(env), "daemon.log"));
  await waitFor("the daemon's banner in daemon.log", () => /agoryx daemon at /.test(first.logTail()));

  // A second supervisor (a second app window, a restarted app) attaches: no second daemon.
  const second = supervise(env);
  assert.deepEqual(await second.start(), info);
  assert.equal(spawned.length, 1);

  // Restarted while the first was not looking (a terminal's `agoryx down && agoryx up -d`): "changed".
  const seen = record(first);
  const restarted = await second.restart();
  assert.notEqual(restarted.pid, info.pid);
  assert.equal(pidAlive(info.pid), false, "restart waits until the old daemon is gone");
  first.watch();
  await waitFor('"changed"', () => seen.length > 0);
  assert.deepEqual(seen, [{ event: "changed", args: [restarted] }]);
  assert.equal(first.info?.pid, restarted.pid);

  // Stopped from outside while watched: "down", then a new daemon and "up".
  seen.length = 0;
  await second.stop();
  await waitFor('"up" after "down"', () => seen.some((entry) => entry.event === "up"));
  assert.deepEqual(seen.map((entry) => entry.event), ["down", "up"]);
  const revived = seen[1]!.args[0] as DaemonInfo;
  assert.notEqual(revived.pid, restarted.pid);
  assert.equal((await findDaemon(env))?.pid, revived.pid);

  // stop(): through the API, and nothing restarts it.
  await first.stop();
  assert.equal(pidAlive(revived.pid), false);
  assert.equal(readDaemonInfo(env), null);
  await new Promise((resolveWait) => setTimeout(resolveWait, 600));
  assert.equal(await findDaemon(env), null);
  assert.deepEqual(seen.map((entry) => entry.event), ["down", "up"]);
  first.dispose();
  second.dispose();
});

test("a busy daemon (alive in daemon.json, not answering) is left alone: never a second one", async () => {
  const env = homeEnv("busy");
  mkdirSync(agoraHome(env), { recursive: true });
  const supervisor = supervise(env);
  const seen = record(supervisor);
  const info = await supervisor.start();
  const before = spawned.length;
  supervisor.watch();
  // The daemon stops answering /api/health but is alive: SIGSTOP it for a few polls.
  process.kill(info.pid, "SIGSTOP");
  let attached: Promise<DaemonInfo>;
  try {
    await sleep(2500);
    // A start (the app opened again) and a restart (the menu) meanwhile: they wait for it, then say so.
    const [started, restarted] = await Promise.allSettled([
      supervise(env, { startTimeoutMs: 1500 }).start(),
      supervise(env, { startTimeoutMs: 1500 }).restart(),
    ]);
    assert.equal(started.status, "rejected");
    const refused = (started as PromiseRejectedResult).reason as unknown;
    assert.ok(refused instanceof DaemonStartError);
    assert.equal(refused.reason, `the daemon (pid ${info.pid}) is running but not answering`);
    assert.equal(restarted.status, "rejected");
    assert.match(String((restarted as PromiseRejectedResult).reason), /is running but not answering/);
    assert.equal(readDaemonInfo(env)?.pid, info.pid, "not stopped");
    // One that answers again while a start waits for it: attached.
    attached = supervise(env).start();
    await sleep(800);
  } finally {
    process.kill(info.pid, "SIGCONT");
  }
  assert.equal((await attached).pid, info.pid);
  assert.deepEqual(seen, []);
  assert.equal(spawned.length, before, "nothing was started");
  await waitFor("the daemon to answer again", async () => (await findDaemon(env))?.pid === info.pid);
  await supervisor.stop();
  void supervisor.dispose();
});

test("a daemon.json that outlived its daemon (its pid reused, nothing on its port) is not a busy daemon", async () => {
  const env = homeEnv("stale");
  mkdirSync(agoraHome(env), { recursive: true });
  const port = await closedPort();
  // A live pid that is not a daemon: this test process.
  const stale: DaemonInfo = { pid: process.pid, port, url: `http://127.0.0.1:${port}`, token: "stale", startedAt: new Date().toISOString() };
  writeFileSync(daemonInfoPath(env), JSON.stringify(stale));
  const supervisor = supervise(env);
  const before = spawned.length;
  const info = await supervisor.start();
  assert.notEqual(info.pid, process.pid);
  assert.equal(spawned.length - before, 1);
  assert.equal((await findDaemon(env))?.pid, info.pid);
  await supervisor.stop();
  assert.equal(pidAlive(info.pid), false);
});

test("stop() wins over a restart under way: nothing is started after it", async () => {
  const env = homeEnv("stop-wins");
  const supervisor = supervise(env);
  const info = await supervisor.start();
  const before = spawned.length;

  // Asked while the restart is stopping the daemon: the restart gives way.
  const restarting = supervisor.restart();
  await supervisor.stop();
  await assert.rejects(restarting, /the daemon was stopped while restarting/);
  assert.equal(pidAlive(info.pid), false);
  assert.equal(await findDaemon(env), null);
  assert.equal(spawned.length, before, "nothing was started");

  // Asked while the restart is starting the new one: that one is stopped as soon as it answers.
  const again = await supervisor.start();
  const restartingAgain = supervisor.restart();
  await waitFor("the restart to start a daemon", () => spawned.length > before + 1);
  await supervisor.stop();
  const restarted = await restartingAgain;
  assert.notEqual(restarted.pid, again.pid);
  assert.equal(pidAlive(restarted.pid), false);
  assert.equal(await findDaemon(env), null);
});

test("dispose() resolves after a start under way: the next supervisor attaches to its daemon", async () => {
  const env = homeEnv("handover");
  const first = supervise(env);
  const before = spawned.length;
  const starting = first.start();
  await first.dispose();
  const info = await starting;
  assert.equal((await findDaemon(env))?.pid, info.pid, "answering once dispose() resolved");
  const second = supervise(env);
  assert.equal((await second.start()).pid, info.pid);
  assert.equal(spawned.length - before, 1);
  await second.stop();
});

/** An install whose bin/agoryx.js runs the real one, or fails with "boom" while `flag` exists. */
const flakyRoot = (name: string, body?: string): { root: string; flag: string } => {
  const root = join(scratch, name);
  const flag = join(root, "fail");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(root, "bin", "agoryx.js"),
    body ??
      [
        'import { existsSync } from "node:fs";',
        `if (existsSync(${JSON.stringify(flag)})) {`,
        '  console.error("boom: cannot start (test)");',
        "  process.exit(1);",
        "}",
        `await import(${JSON.stringify(pathToFileURL(join(ROOT, "bin", "agoryx.js")).href)});`,
      ].join("\n"),
  );
  return { root, flag };
};

test("a daemon that cannot start: the error says why and carries the log's tail", async () => {
  const env = homeEnv("broken");
  const { root, flag } = flakyRoot("broken-install");
  writeFileSync(flag, "");
  const supervisor = supervise(env, { root });
  await assert.rejects(supervisor.start(), (error: unknown) => {
    assert.ok(error instanceof DaemonStartError);
    assert.equal(error.reason, "the daemon exited with code 1 before it answered");
    assert.equal(error.logPath, join(agoraHome(env), "daemon.log"));
    assert.match(error.logTail, /boom: cannot start \(test\)/);
    assert.match(error.message, /boom: cannot start/);
    return true;
  });
  assert.match(supervisor.logTail(), /boom/);
  assert.equal(await findDaemon(env), null);
});

test("a daemon that never answers is ended at the start timeout", async () => {
  const env = homeEnv("silent");
  const { root } = flakyRoot("silent-install", "setInterval(() => {}, 1000);\n");
  const supervisor = supervise(env, { root, startTimeoutMs: 1000 });
  const before = spawned.length;
  await assert.rejects(supervisor.start(), /the daemon did not answer within 1s/);
  const child = spawned[before]!;
  await waitFor("the silent child to be ended", () => child.exitCode !== null || child.signalCode !== null, 5000);
});

test("five failed restarts: \"failed\" with the log's tail, and nothing more until retry()", async () => {
  const env = homeEnv("flaky");
  const { root, flag } = flakyRoot("flaky-install");
  const supervisor = supervise(env, { root, backoffMs: [50] });
  const seen = record(supervisor);
  const info = await supervisor.start();
  supervisor.watch();
  writeFileSync(flag, "");
  const before = spawned.length;
  await stopDaemon(env);
  await waitFor('"failed"', () => seen.some((entry) => entry.event === "failed"));
  assert.deepEqual(seen.map((entry) => entry.event), ["down", "failed"]);
  const failure = seen[1]!.args[0] as { message: string; logTail: string };
  assert.equal(failure.message, "the daemon exited with code 1 before it answered");
  assert.match(failure.logTail, /boom: cannot start \(test\)/);
  assert.equal(spawned.length - before, 5);

  await new Promise((resolveWait) => setTimeout(resolveWait, 600));
  assert.equal(spawned.length - before, 5, "no more tries on its own");

  rmSync(flag);
  const back = await supervisor.retry();
  assert.ok(back);
  assert.notEqual(back.pid, info.pid);
  assert.deepEqual(seen.map((entry) => entry.event), ["down", "failed", "up"]);
  assert.equal((await findDaemon(env))?.pid, back.pid);
  await supervisor.stop();
  assert.equal(pidAlive(back.pid), false);
  supervisor.dispose();
});

test("stop() with no daemon, and dispose(), leave everything as it is", async () => {
  const env = homeEnv("idle");
  const supervisor = supervise(env);
  await supervisor.stop();
  supervisor.watch();
  supervisor.dispose();
  assert.equal(existsSync(join(agoraHome(env), "daemon.json")), false);
  assert.equal(supervisor.logTail(), "");
});
