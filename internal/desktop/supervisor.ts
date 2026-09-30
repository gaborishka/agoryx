import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient, DaemonRequestError } from "../agora/client.js";
import { findDaemon, pidAlive, probeDaemon, readDaemonInfo, type DaemonInfo } from "../agora/daemoninfo.js";
import { agoraHome } from "../agora/paths.js";
import { launchdService, type DaemonService } from "./launchd.js";

/**
 * Keeps the daemon of one AGORYX_HOME up for the desktop app, the way `agoryx up -d` would from a terminal.
 *
 * It attaches to the daemon that is already running there, or starts `node <root>/bin/agoryx.js up`
 * detached (the user's node, never Electron: agents' shims exec the daemon's node, and better-sqlite3 is
 * built for it), and watches it: a daemon restarted from a terminal is followed, one that went away is
 * started again. The daemon outlives the app — quitting leaves rooms running; only stop() ends it, through
 * its API. It never touches a daemon of another home, and never signals a pid it has not verified.
 * A daemon that is alive but not answering (busy) is never taken for gone: nothing starts next to it,
 * and a stop that cannot reach it says so.
 *
 * With the launchd service installed for the home (`agoryx service install`), launchd owns the daemon: a
 * start is a `launchctl kickstart`, never a process of its own, so a restart never races launchd's. Before
 * it attaches to a daemon it did not start, it checks that the process listening on the daemon's port is
 * the pid in daemon.json: the page it opens gets the token.
 *
 * Events (while watching): "down" — the daemon went away, restarts follow; "up" (info) — one came up
 * after "down", "failed" or retry(); "changed" (info) — another daemon replaced the one it knew (restarted
 * from a terminal: new url/token); "failed" ({ message, logTail }) — five restarts in a row failed, and
 * nothing more is tried until retry().
 */

export interface SupervisorFailure {
  message: string;
  /** The last lines of daemon.log. */
  logTail: string;
}

export interface DaemonSupervisorEvents {
  up: [info: DaemonInfo];
  changed: [info: DaemonInfo];
  down: [];
  failed: [failure: SupervisorFailure];
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface DaemonSupervisorOptions {
  /** The Agoryx install: the folder with bin/agoryx.js. */
  root: string;
  /** The user's node (>= 22) that runs the daemon. */
  node: string;
  /** The daemon's environment (desktopEnv()); its AGORYX_HOME picks the daemon. */
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  pollMs?: number;
  /** For tests: what starts the daemon process. */
  spawnImpl?: SpawnLike;
  /**
   * The port for a daemon this supervisor starts (`agoryx up --port N`, 0 = any free port). Default: the
   * CLI's (7717, or the next free one). Tests pass 0 so they never meet a daemon on 7717.
   */
  port?: number;
  /** How long a start waits for a daemon to answer (a new one, or a busy one), and a stop for a busy one; default 20s. */
  startTimeoutMs?: number;
  /** Delays before restarts 1..5 after "down" (the last one repeats); default 0.5, 1, 2, 4, 8s. */
  backoffMs?: number[];
  /** The home's launchd service (default: launchdService(env) on macOS). When it is loaded, starts go through it. */
  service?: DaemonService | null;
  /**
   * The pids listening on a local TCP port, [] when none is visible (another user's process is not), or
   * null when that cannot be told (no lsof). Default: lsof.
   */
  listenerPids?: (port: number) => Promise<number[] | null>;
}

/** A daemon that did not come up: why, in a few words, and the end of its log. */
export class DaemonStartError extends Error {
  constructor(
    readonly reason: string,
    readonly logPath: string,
    readonly logTail: string,
  ) {
    super(`${reason}; see ${logPath}${logTail ? `\n${logTail}` : ""}`);
    this.name = "DaemonStartError";
  }
}

const MAX_RESTARTS = 5;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000];
const STOP_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const messageOf = (error: unknown): string =>
  error instanceof DaemonStartError ? error.reason : error instanceof Error ? error.message : String(error);

const notAnswering = (info: DaemonInfo): string => `the daemon (pid ${info.pid}) is running but not answering`;

export class DaemonSupervisor extends EventEmitter<DaemonSupervisorEvents> {
  private readonly root: string;
  private readonly node: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly pollMs: number;
  private readonly spawnImpl: SpawnLike;
  private readonly port: number | undefined;
  private readonly startTimeoutMs: number;
  private readonly backoffMs: number[];
  private readonly service: DaemonService | null;
  private readonly listenerPids: (port: number) => Promise<number[] | null>;
  /** The daemon last seen alive (null: none, or it went away). */
  private current: DaemonInfo | null = null;
  private starting: Promise<DaemonInfo> | null = null;
  /** Asked to stop: its absence is wanted, not a crash. */
  private stopping = false;
  /** stop() is waiting for the daemon to go: it may still answer meanwhile. */
  private halting = false;
  /** The stop under way: a second stop() joins it (a second POST /api/down ends a closing daemon mid-close). */
  private halt: Promise<void> | null = null;
  /** Grows with every stop(): a restart gives way to a stop asked while it was stopping. */
  private stops = 0;
  private recovering = false;
  private polling = false;
  private disposed = false;
  private failure: SupervisorFailure | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Ends a restart's wait early (stop, dispose, retry). */
  private wake: (() => void) | null = null;

  constructor(options: DaemonSupervisorOptions) {
    super();
    this.root = options.root;
    this.node = options.node;
    this.env = options.env;
    this.log = options.log ?? (() => {});
    this.pollMs = options.pollMs ?? 3000;
    this.spawnImpl = options.spawnImpl ?? (spawn as SpawnLike);
    this.port = options.port;
    this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
    this.backoffMs = options.backoffMs?.length ? options.backoffMs : BACKOFF_MS;
    this.service = options.service !== undefined ? options.service : launchdService(this.env);
    this.listenerPids = options.listenerPids ?? lsofListeners;
  }

  /** The daemon last seen alive. */
  get info(): DaemonInfo | null {
    return this.current;
  }

  /** The running daemon of this home, or a new one. Rejects with a DaemonStartError (with the log's tail) when it does not come up. */
  async start(): Promise<DaemonInfo> {
    this.stopping = false;
    this.failure = null;
    return this.launch();
  }

  /** Follow the daemon from now on (every pollMs). */
  watch(): void {
    this.disposed = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref();
  }

  /**
   * Stop the daemon and start a new one; rejects like stop() and start(), and when stop() is called while
   * it is stopping (Stop Daemon and Quit during a restart): the stop wins, nothing starts.
   */
  async restart(): Promise<DaemonInfo> {
    const stopped = this.stop();
    const asked = this.stops;
    await stopped;
    if (this.stops !== asked) throw new Error("the daemon was stopped while restarting");
    return this.start();
  }

  /** After "failed" (or a start that failed): try again now. Never rejects: the outcome comes as "up" or "failed". */
  async retry(): Promise<DaemonInfo | null> {
    this.stopping = false;
    this.failure = null;
    if (this.recovering) {
      // A restart is waiting out its backoff: it goes now instead.
      this.wake?.();
      return null;
    }
    try {
      const info = await this.launch();
      this.emit("up", info);
      return info;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /**
   * Stop the daemon through its API (POST /api/down, with the token from daemon.json) and wait until its
   * process is gone. A daemon too old to have /api/down gets SIGTERM — only after /api/health confirmed its pid.
   * A busy daemon is waited for (startTimeoutMs); one that never answers is an error, not "stopped".
   */
  stop(): Promise<void> {
    this.stops += 1;
    this.stopping = true;
    this.wake?.();
    this.halt ??= this.stopNow().finally(() => {
      this.halt = null;
    });
    return this.halt;
  }

  /**
   * Stop watching (and any pending restart). The daemon keeps running. Resolves once a start already under
   * way has ended: until then its daemon may not answer yet, and a new supervisor would start a second one.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.wake?.();
    return (this.starting ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    );
  }

  logPath(): string {
    return join(agoraHome(this.env), "daemon.log");
  }

  /** The last `lines` lines of daemon.log ("" without one). */
  logTail(lines = 20): string {
    let fd: number;
    try {
      fd = openSync(this.logPath(), "r");
    } catch {
      return "";
    }
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8").replace(/\s+$/, "");
      return text ? text.split(/\r?\n/).slice(-lines).join("\n") : "";
    } finally {
      closeSync(fd);
    }
  }

  // -------------------------------------------------------------------------

  private fail(error: unknown): void {
    this.failure = { message: messageOf(error), logTail: error instanceof DaemonStartError ? error.logTail : this.logTail() };
    this.log(`failed: ${this.failure.message}`);
    this.emit("failed", this.failure);
  }

  private async stopNow(): Promise<void> {
    this.halting = true;
    try {
      await this.starting?.catch(() => null);
      const found = await this.reach();
      if (found?.busy) throw new Error(notAnswering(found.info));
      this.current = null;
      if (!found) return;
      const { info } = found;
      this.log(`stopping the daemon (pid ${info.pid})`);
      try {
        await new DaemonClient(info).down();
      } catch (error) {
        if (error instanceof DaemonRequestError && error.status === 404) process.kill(info.pid, "SIGTERM");
        else if (error instanceof DaemonRequestError) throw new Error(`the daemon refused to stop: ${error.message}`);
        // Otherwise the connection closed under the request: the daemon is on its way down.
      }
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!pidAlive(info.pid)) return;
        await sleep(200);
      }
      throw new Error(`the daemon (pid ${info.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000}s`);
    } finally {
      this.halting = false;
    }
  }

  /** One start at a time: concurrent callers share it. */
  private launch(): Promise<DaemonInfo> {
    this.starting ??= (async () => {
      const found = await this.reach();
      if (found?.busy) throw new DaemonStartError(notAnswering(found.info), this.logPath(), this.logTail());
      if (found) {
        const impostor = await this.listenerMismatch(found.info);
        if (impostor) throw new DaemonStartError(impostor, this.logPath(), this.logTail());
      }
      const info = found?.info ?? (await this.startDaemon());
      if (found) this.log(`attached to the daemon at ${info.url} (pid ${info.pid})`);
      this.current = info;
      return info;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * The daemon of this home once it answers, or null when there is none. One that is alive and holds its
   * port but does not answer is not gone: it is waited for (startTimeoutMs), and still `busy` after that.
   * Starting another next to it would race it for the port and the rooms.
   */
  private async reach(): Promise<{ info: DaemonInfo; busy: boolean } | null> {
    const deadline = Date.now() + this.startTimeoutMs;
    let said = false;
    for (;;) {
      const found = await probeDaemon(this.env);
      if (!found?.busy || Date.now() >= deadline) return found;
      if (!said) this.log(`the daemon (pid ${found.info.pid}) is not answering; waiting for it`);
      said = true;
      await sleep(200);
    }
  }

  /**
   * Why the daemon daemon.json names is not the one on its port (null: it is, or that cannot be told).
   * /api/health's pid is only what the answering process says; the socket's owner is what the OS says.
   */
  private async listenerMismatch(info: DaemonInfo): Promise<string | null> {
    const pids = await this.listenerPids(info.port);
    if (pids === null || pids.includes(info.pid)) return null;
    // It stopped listening between the two looks: gone, not an impostor (the next look says so).
    if (pids.length === 0 && !(await findDaemon(this.env))) return null;
    const holder = pids.length > 0 ? `pid ${pids.join(", ")}` : "a process of another user";
    return `port ${info.port} is held by ${holder}, not by the daemon in daemon.json (pid ${info.pid}); not attaching`;
  }

  /** A new daemon: through the launchd service when it is loaded for this home, else a process of its own. */
  private async startDaemon(): Promise<DaemonInfo> {
    let viaService = false;
    try {
      viaService = Boolean(this.service && (await this.service.loaded()));
    } catch {
      viaService = false;
    }
    return viaService ? this.kickstartDaemon(this.service!) : this.spawnDaemon();
  }

  private async kickstartDaemon(service: DaemonService): Promise<DaemonInfo> {
    const logPath = this.logPath();
    this.log(`starting the daemon through launchd (${service.label}), log: ${logPath}`);
    try {
      await service.kickstart();
    } catch (error) {
      throw new DaemonStartError(`launchd did not start the daemon (${messageOf(error)})`, logPath, this.logTail());
    }
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(200);
      const info = await findDaemon(this.env);
      if (info) return info;
    }
    // launchd keeps the process: nothing here to end. It restarts a crashed one by itself.
    throw new DaemonStartError(`the daemon did not answer within ${this.startTimeoutMs / 1000}s of launchd starting it`, logPath, this.logTail());
  }

  private async spawnDaemon(): Promise<DaemonInfo> {
    const home = agoraHome(this.env);
    mkdirSync(home, { recursive: true });
    const logPath = this.logPath();
    const args = [join(this.root, "bin", "agoryx.js"), "up", ...(this.port !== undefined ? ["--port", String(this.port)] : [])];
    const cwd = this.env.HOME?.trim() || homedir();
    const fd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      // Detached, stdio to daemon.log: it is nobody's child for long, and outlives the app.
      child = this.spawnImpl(this.node, args, {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: this.env,
        ...(isDirectory(cwd) ? { cwd } : {}),
      });
    } finally {
      closeSync(fd);
    }
    let exited: string | null = null;
    child.on("exit", (code, signal) => {
      exited = signal ? `was killed by ${signal}` : `exited with code ${code}`;
    });
    child.on("error", (error) => {
      exited = `could not be started (${error.message})`;
    });
    child.unref();
    this.log(`starting the daemon (pid ${child.pid ?? "?"}), log: ${logPath}`);
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline && !exited) {
      await sleep(200);
      const info = await findDaemon(this.env);
      if (info) return info;
    }
    // Exited because another start won the race (`agoryx up`: "already running")?
    const late = await findDaemon(this.env);
    if (late) return late;
    if (!exited && child.pid) {
      // Our own child, still running and still not answering: ended, so a retry does not start a second daemon.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // gone meanwhile
      }
    }
    const reason = exited ? `the daemon ${exited} before it answered` : `the daemon did not answer within ${this.startTimeoutMs / 1000}s`;
    throw new DaemonStartError(reason, logPath, this.logTail());
  }

  private async poll(): Promise<void> {
    if (this.polling || this.starting || this.recovering || this.halting || this.disposed) return;
    this.polling = true;
    try {
      const info = await findDaemon(this.env);
      if (this.disposed || this.starting || this.recovering || this.halting) return;
      if (info) {
        if (this.current && info.pid === this.current.pid && info.port === this.current.port) return;
        const impostor = await this.listenerMismatch(info);
        if (this.disposed || this.starting || this.recovering || this.halting) return;
        if (impostor) {
          if (this.failure?.message !== impostor) this.fail(new Error(impostor));
          return;
        }
        const known = this.current !== null && this.failure === null;
        this.current = info;
        this.failure = null;
        // A daemon started from a terminal meanwhile: after a failure, it is the one that came up.
        this.emit(known ? "changed" : "up", info);
        return;
      }
      if (this.stopping || this.failure || !this.current) return;
      // Not answering is not gone: while daemon.json names a live pid, a busy daemon is left alone
      // (starting another would race it for the port and the rooms).
      if (readDaemonInfo(this.env)) return;
      void this.recover();
    } finally {
      this.polling = false;
    }
  }

  /** "down", then restarts with backoff until one comes up ("up") or five have failed ("failed"). */
  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    this.current = null;
    this.log("the daemon went away; restarting it");
    this.emit("down");
    let last: unknown = new Error("the daemon did not come back");
    try {
      for (let attempt = 0; attempt < MAX_RESTARTS; attempt += 1) {
        await this.pause(this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)]!);
        if (this.disposed || this.stopping) return;
        try {
          const info = await this.launch();
          if (this.disposed || this.stopping) return;
          this.emit("up", info);
          return;
        } catch (error) {
          last = error;
          this.log(`restart ${attempt + 1} of ${MAX_RESTARTS} failed: ${messageOf(error)}`);
        }
      }
      this.fail(last);
    } finally {
      this.recovering = false;
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolvePause) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === done) self.wake = null;
        resolvePause();
      }
      this.wake = done;
    });
  }
}

const LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof"];

/** `lsof -iTCP:<port> -sTCP:LISTEN`: the listening pids this user can see; null without lsof or an answer. */
export const lsofListeners = (port: number): Promise<number[] | null> => {
  const lsof = LSOF.find((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  if (!lsof) return Promise.resolve(null);
  return new Promise((resolveList) => {
    execFile(lsof, ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      const pids = [...new Set((stdout ?? "").split("\n").flatMap((line) => (/^p(\d+)$/.exec(line) ? [Number(line.slice(1))] : [])))];
      if (!error) return resolveList(pids);
      // Exit 1 with nothing printed: no listener this user can see. Anything else: unknown.
      const code = (error as { code?: unknown }).code;
      resolveList(code === 1 && pids.length === 0 ? [] : null);
    });
  });
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
