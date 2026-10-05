import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { agoraHome } from "../agora/paths.js";

/**
 * The daemon as a launchd service: `agoryx service install` writes a per-user LaunchAgent that runs
 * `node <install>/bin/agoryx.js up --login-env` at login, and again after a crash.
 *
 * One service per AGORYX_HOME, as one daemon per home: the default home's label is `dev.agoryx.daemon`,
 * another home's adds a hash of its path. `KeepAlive` restarts only an unsuccessful exit, so `agoryx down`
 * (exit 0) stays down, and so does a service start that finds its home's daemon already running
 * (`agoryx up` says so and exits 0). The plist holds no secrets: PATH, SHELL and the home only. The daemon
 * takes the rest (keys included) from the login shell each time it starts (`--login-env`).
 *
 * Dependency-free (node built-ins and paths.ts): the desktop app's supervisor loads it.
 */

export const SERVICE_LABEL = "dev.agoryx.daemon";

/**
 * What the service's plist pins: which home and workspace root. `agoryx up --login-env` never takes them
 * from the login shell, so the daemon always runs for the home its label names.
 */
export const SERVICE_PINNED_VARS: readonly string[] = ["AGORYX_HOME", "AGORYX_WORKSPACES", "XDG_STATE_HOME"];

const LAUNCHCTL = "/bin/launchctl";

export interface LaunchctlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type LaunchctlRun = (args: string[]) => Promise<LaunchctlResult>;

/** Runs /bin/launchctl; never rejects (a spawn failure is code null). */
export const runLaunchctl: LaunchctlRun = (args) =>
  new Promise((resolveRun) => {
    execFile(LAUNCHCTL, args, { timeout: 15_000, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
      resolveRun({ code, stdout: stdout ?? "", stderr: stderr ?? (error && code === null ? error.message : "") });
    });
  });

/** Where launchd looks, and how it is asked: all injectable, so tests never touch ~/Library/LaunchAgents. */
export interface LaunchdContext {
  /** The environment whose AGORYX_HOME the service runs for. */
  env: NodeJS.ProcessEnv;
  label: string;
  /** Default ~/Library/LaunchAgents. */
  agentsDir: string;
  /** Default gui/<uid>. */
  domain: string;
  launchctl: LaunchctlRun;
}

const userHome = (env: NodeJS.ProcessEnv): string => env.HOME?.trim() || homedir();

/** `dev.agoryx.daemon` for the default home, `dev.agoryx.daemon.<hash>` for any other. */
export const serviceLabel = (env: NodeJS.ProcessEnv): string => {
  const home = agoraHome(env);
  const standard = agoraHome({ HOME: userHome(env) });
  return home === standard ? SERVICE_LABEL : `${SERVICE_LABEL}.${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
};

export const launchdContext = (env: NodeJS.ProcessEnv, overrides: Partial<LaunchdContext> = {}): LaunchdContext => ({
  env,
  label: overrides.label ?? serviceLabel(env),
  agentsDir: overrides.agentsDir ?? join(userHome(env), "Library", "LaunchAgents"),
  domain: overrides.domain ?? `gui/${process.getuid?.() ?? 0}`,
  launchctl: overrides.launchctl ?? runLaunchctl,
});

export const plistPath = (ctx: LaunchdContext): string => join(ctx.agentsDir, `${ctx.label}.plist`);

export interface ServiceSpec {
  label: string;
  /** node, bin/agoryx.js, up, --login-env */
  program: string[];
  workingDirectory: string;
  logPath: string;
  environment: Record<string, string>;
}

/**
 * The service for `env`'s home: the user's node (the one better-sqlite3 is built for) running this
 * install's bin/agoryx.js. Its environment is PATH (node's folder first), SHELL (which login shell
 * `--login-env` asks) and the pinned variables that are set — nothing else from `env`.
 */
export const serviceSpec = (options: { ctx: LaunchdContext; root: string; node: string }): ServiceSpec => {
  const { ctx, root, node } = options;
  const env = ctx.env;
  const path: string[] = [];
  for (const entry of [dirname(node), ...(env.PATH ?? "").split(delimiter), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (entry.startsWith("/") && !path.includes(entry)) path.push(entry);
  }
  const environment: Record<string, string> = { PATH: path.join(delimiter) };
  const shell = env.SHELL?.trim();
  if (shell?.startsWith("/")) environment.SHELL = shell;
  for (const key of SERVICE_PINNED_VARS) {
    const value = env[key]?.trim();
    if (value) environment[key] = value;
  }
  return {
    label: ctx.label,
    program: [node, join(root, "bin", "agoryx.js"), "up", "--login-env"],
    workingDirectory: userHome(env),
    logPath: join(agoraHome(env), "daemon.log"),
    environment,
  };
};

const xml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const unxml = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export const renderPlist = (spec: ServiceSpec): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.program.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(spec.environment).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(spec.workingDirectory)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${xml(spec.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(spec.logPath)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    // A crash restarts it; `agoryx down`, and a start that found the daemon already running, exit 0 and stay down.
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    // Rooms close on SIGTERM (running turns are stopped first): more than launchd's default 20s before SIGKILL.
    "  <key>ExitTimeOut</key>",
    "  <integer>30</integer>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

/** ProgramArguments of a plist this module wrote (null when there is none). */
export const parsePlistProgram = (text: string): string[] | null => {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (array === undefined) return null;
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]!));
};

export interface LaunchctlPrint {
  state?: string;
  pid?: number;
  lastExitCode?: string;
}

/** The service's own fields from `launchctl print <domain>/<label>` (one tab deep; nested blocks are skipped). */
export const parseLaunchctlPrint = (text: string): LaunchctlPrint => {
  const result: LaunchctlPrint = {};
  for (const line of text.split("\n")) {
    const match = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "state") result.state = value!.trim();
    else if (key === "pid" && /^\d+$/.test(value!.trim())) result.pid = Number(value);
    else if (key === "last exit code") result.lastExitCode = value!.trim();
  }
  return result;
};

export interface ServiceStatus {
  label: string;
  plistPath: string;
  /** The plist is in LaunchAgents: launchd loads it at login. */
  installed: boolean;
  /** launchd knows the service now (`launchctl print` finds it). */
  loaded: boolean;
  /** "running", "not running" … (loaded only). */
  state?: string;
  pid?: number;
  /** "(never exited)", "0", "1" … (loaded only). */
  lastExitCode?: string;
  /** What the plist runs. */
  program?: string[];
  /** The plist's node or bin/agoryx.js that no longer exist (a node upgrade, a moved install). */
  missing: string[];
}

export const serviceStatus = async (ctx: LaunchdContext): Promise<ServiceStatus> => {
  const path = plistPath(ctx);
  const installed = existsSync(path);
  let program: string[] | undefined;
  if (installed) {
    try {
      program = parsePlistProgram(readFileSync(path, "utf8")) ?? undefined;
    } catch {
      program = undefined;
    }
  }
  const missing = (program ?? []).slice(0, 2).filter((file) => file.startsWith("/") && !existsSync(file));
  const printed = await ctx.launchctl(["print", `${ctx.domain}/${ctx.label}`]);
  const loaded = printed.code === 0;
  return {
    label: ctx.label,
    plistPath: path,
    installed,
    loaded,
    ...(loaded ? parseLaunchctlPrint(printed.stdout) : {}),
    ...(program ? { program } : {}),
    missing,
  };
};

const failed = (what: string, result: LaunchctlResult): Error =>
  new Error(`launchctl ${what} failed (${result.code ?? "not run"}): ${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`);

export interface InstallResult {
  status: ServiceStatus;
  /** The plist was written (new, or different from the one there). */
  written: boolean;
  /** A loaded service was booted out first (its daemon stopped) to load the new plist. */
  reloaded: boolean;
}

/**
 * Write the plist and load it. The same plist, already loaded, is left alone (its daemon keeps running);
 * a different one replaces it, which stops the service's daemon (bootout) before the new one loads.
 */
export const installService = async (options: { ctx: LaunchdContext; root: string; node: string }): Promise<InstallResult> => {
  const { ctx } = options;
  const spec = serviceSpec(options);
  const text = renderPlist(spec);
  const path = plistPath(ctx);
  // launchd opens the log itself, and does not create its folder.
  mkdirSync(dirname(spec.logPath), { recursive: true });
  mkdirSync(ctx.agentsDir, { recursive: true });
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  const before = await serviceStatus(ctx);
  if (current === text && before.loaded) return { status: before, written: false, reloaded: false };
  let reloaded = false;
  if (before.loaded) {
    const out = await ctx.launchctl(["bootout", `${ctx.domain}/${ctx.label}`]);
    if (out.code !== 0 && out.code !== 3) throw failed("bootout", out);
    reloaded = true;
  }
  const written = current !== text;
  if (written) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, path);
  }
  const loaded = await ctx.launchctl(["bootstrap", ctx.domain, path]);
  if (loaded.code !== 0) throw failed("bootstrap", loaded);
  return { status: await serviceStatus(ctx), written, reloaded };
};

export interface UninstallResult {
  /** A plist was removed. */
  removed: boolean;
  /** The service was loaded (and its daemon, if running, stopped). */
  unloaded: boolean;
}

/** Unload the service (launchd stops its daemon with SIGTERM: rooms close as on Ctrl-C) and remove the plist. */
export const uninstallService = async (ctx: LaunchdContext): Promise<UninstallResult> => {
  const before = await serviceStatus(ctx);
  if (before.loaded) {
    const out = await ctx.launchctl(["bootout", `${ctx.domain}/${ctx.label}`]);
    if (out.code !== 0 && out.code !== 3) throw failed("bootout", out);
  }
  const path = plistPath(ctx);
  const removed = existsSync(path);
  rmSync(path, { force: true });
  return { removed, unloaded: before.loaded };
};

/** Ask launchd to start the service's daemon now (nothing happens when it is running). */
export const kickstartService = async (ctx: LaunchdContext): Promise<void> => {
  const out = await ctx.launchctl(["kickstart", `${ctx.domain}/${ctx.label}`]);
  if (out.code !== 0) throw failed("kickstart", out);
};

/** The parent of a process (null when it cannot be told). */
export const parentPid = (pid: number): Promise<number | null> =>
  new Promise((resolveParent) => {
    execFile("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      const ppid = Number((stdout ?? "").trim());
      resolveParent(!error && Number.isInteger(ppid) && ppid > 0 ? ppid : null);
    });
  });

/**
 * Whether the daemon with this pid is the one the service runs: launchd's pid itself, or its child (an
 * install that is not built runs `up` from source in a child process of bin/agoryx.js).
 */
export const runByService = async (status: ServiceStatus, daemonPid: number): Promise<boolean> =>
  status.pid !== undefined && (status.pid === daemonPid || (await parentPid(daemonPid)) === status.pid);

/** What the app's supervisor and `agoryx up -d` need: whether the home has a loaded service, and a way to start it. */
export interface DaemonService {
  label: string;
  loaded(): Promise<boolean>;
  kickstart(): Promise<void>;
}

/** The launchd service of `env`'s home, on macOS; null elsewhere. `loaded()` is false until it is installed and loaded. */
export const launchdService = (env: NodeJS.ProcessEnv, overrides: Partial<LaunchdContext> = {}): DaemonService | null => {
  if (process.platform !== "darwin" && !overrides.launchctl) return null;
  const ctx = launchdContext(env, overrides);
  return {
    label: ctx.label,
    async loaded() {
      if (!existsSync(plistPath(ctx))) return false;
      return (await ctx.launchctl(["print", `${ctx.domain}/${ctx.label}`])).code === 0;
    },
    kickstart: () => kickstartService(ctx),
  };
};
