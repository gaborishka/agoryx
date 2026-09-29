import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { AGENT_KEY_ENV } from "../agora/actor.js";
import { TURN_FILE_ENV } from "../agora/turn-context.js";

/**
 * The environment a terminal would give Agoryx, for an app opened from Finder or the Dock.
 *
 * A Finder-launched app gets launchd's environment: PATH `/usr/bin:/bin:/usr/sbin:/sbin`, none of what
 * the user's shell rc files export (Homebrew, ~/.local/bin, nvm, API keys, CLAUDE_CONFIG_DIR …). So the
 * app asks the user's own login shell once and runs the daemon with what it prints, the way `agoryx up`
 * from a terminal would have it. Nothing here logs or returns a value to anyone but the caller: the
 * environment holds secrets.
 *
 * Dependency-free (node built-ins and two constants): Electron's main process imports it.
 */

/**
 * Agoryx's turn variables: set for one agent's turn (its room, its key), never for a daemon. `daemonEnv()`
 * in cmd/agoryx/agora.ts removes the same list.
 */
export const TURN_ENV_VARS: readonly string[] = [
  TURN_FILE_ENV,
  "AGORYX_ROOM",
  "AGORYX_ROOM_NAME",
  "AGORYX_AGENT",
  "AGORYX_TURN",
  "AGORYX_SEEN",
  "AGORYX_OPS_DIR",
  "AGORYX_TABLE",
  AGENT_KEY_ENV,
];

/** Variables that describe the probing shell itself (its directory, depth, prompt, terminal), not the user's setup. */
const TRANSIENT_VARS = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "PS1"]);
const TRANSIENT_PREFIXES = ["TERM_PROGRAM", "ITERM_", "TMUX", "PROMPT"];

const isTransient = (key: string): boolean =>
  TRANSIENT_VARS.has(key) || TRANSIENT_PREFIXES.some((prefix) => key.startsWith(prefix));

/** A name `env -0` may print that is worth passing on (bash's exported functions and junk from interleaved output are not). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The most the probe reads from the shell: a runaway rc file is a failed probe, not a full heap. */
const MAX_PROBE_OUTPUT = 16 * 1024 * 1024;

export interface ProbeOptions {
  /** The shell to ask; default `$SHELL` (of `env`), else /bin/zsh. */
  shell?: string;
  timeoutMs?: number;
  /** The environment the shell starts with; default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface ProbeMarkers {
  start: string;
  end: string;
}

/**
 * `env -0`'s output between the markers, as a map; null without both markers. What rc files print
 * before (banners, `echo`, oh-my-zsh) or after is ignored, and so is any entry that is not NAME=value.
 */
export const parseShellEnvOutput = (output: string, markers: ProbeMarkers): Record<string, string> | null => {
  const start = output.indexOf(markers.start);
  if (start === -1) return null;
  const from = start + markers.start.length;
  const end = output.indexOf(markers.end, from);
  if (end === -1) return null;
  const env: Record<string, string> = {};
  for (const entry of output.slice(from, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!ENV_NAME.test(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return env;
};

/** The command the shell runs after its rc files; each marker is printed in two halves, so an echoed command line (`set -x`) never contains it. */
const probeCommand = (markers: ProbeMarkers, half: number): string => {
  const envBin = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";
  const split = (marker: string) => `printf '%s%s' '${marker.slice(0, half)}' '${marker.slice(half)}'`;
  return `${split(markers.start)}; ${envBin} -0; ${split(markers.end)}`;
};

/** Interactive + login (what a new terminal tab runs), except csh, which takes -l only on its own. */
const shellArgs = (shell: string, command: string): string[] =>
  /^t?csh$/.test(basename(shell)) ? ["-c", command] : ["-i", "-l", "-c", command];

const killGroup = (pid: number | undefined): void => {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
};

/**
 * Runs the user's login shell (interactive, so .zshrc/.bashrc run too) and returns the environment it
 * ends up with, or null on any failure: no such shell, no markers, no PATH, or no answer within
 * `timeoutMs` (then the shell's whole process group is killed). The shell gets no stdin and no
 * terminal of its own, so an rc file that waits for input or a tty fails instead of hanging.
 */
export const probeLoginShell = (options: ProbeOptions = {}): Promise<Record<string, string> | null> => {
  const env = options.env ?? process.env;
  const shell = options.shell ?? (env.SHELL?.trim() || "/bin/zsh");
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!isAbsolute(shell) || !isExecutableFile(shell)) return Promise.resolve(null);
  const id = randomBytes(8).toString("hex");
  const markers: ProbeMarkers = { start: `__AGORYX_ENV_${id}_START__`, end: `__AGORYX_ENV_${id}_END__` };
  const half = "__AGORYX_ENV_".length + 4;
  const home = env.HOME?.trim();
  return new Promise((resolveProbe) => {
    let settled = false;
    let output = "";
    let timer: NodeJS.Timeout | undefined;
    // detached: its own process group (and session, so no controlling terminal), which a timeout kills whole.
    const child = spawn(shell, shellArgs(shell, probeCommand(markers, half)), {
      env,
      ...(home && isDirectory(home) ? { cwd: home } : {}),
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const finish = (result: Record<string, string> | null, kill: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stdout?.destroy();
      if (kill) {
        killGroup(child.pid);
      } else if (child.exitCode === null && child.signalCode === null) {
        // The answer is in. A shell that lingers past it is ended (the shell only: what its rc files
        // started in the background, e.g. a plugin's update check, is left alone).
        const linger = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 3000);
        linger.unref();
      }
      child.unref();
      resolveProbe(result && result.PATH ? result : null);
    };
    timer = setTimeout(() => finish(null, true), timeoutMs);
    child.on("error", () => finish(null, true));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > MAX_PROBE_OUTPUT) return finish(null, true);
      if (output.includes(markers.end)) {
        const parsed = parseShellEnvOutput(output, markers);
        if (parsed) finish(parsed, false);
      }
    });
    child.on("close", () => finish(parseShellEnvOutput(output, markers), false));
  });
};

/** PATH entries in order, without empty (current-directory) entries and repeats. */
const pathEntries = (...paths: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const path of paths) {
    for (const entry of (path ?? "").split(delimiter)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries;
};

const withoutTurnVars = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  for (const key of TURN_ENV_VARS) delete env[key];
  return env;
};

/**
 * The app's environment overlaid by the login shell's whole environment, so the daemon sees what a
 * terminal `agoryx up` would: except what only describes the probing shell (PWD, SHLVL, PS1, TERM_PROGRAM …)
 * and Agoryx's turn variables. PATH is the shell's, then the app's entries it lacks.
 */
export const mergeShellEnv = (base: NodeJS.ProcessEnv, shell: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(shell)) {
    if (!isTransient(key)) env[key] = value;
  }
  const path = pathEntries(shell.PATH, base.PATH);
  if (path.length > 0) env.PATH = path.join(delimiter);
  return withoutTurnVars(env);
};

/** Where installers put the tools a terminal would find: Homebrew, the Claude installer, Volta, Bun, npm, Cargo. */
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "~/.volta/bin", "~/.bun/bin", "~/.npm-global/bin", "~/.cargo/bin"];

/** PATH when the shell could not be asked: the usual install directories that exist, then `env`'s PATH. */
export const fallbackPath = (env: NodeJS.ProcessEnv): string => {
  const home = env.HOME?.trim() || homedir();
  const current = pathEntries(env.PATH);
  const extra = FALLBACK_DIRS.map((dir) => (dir.startsWith("~/") ? join(home, dir.slice(2)) : dir)).filter(
    (dir) => !current.includes(dir) && isDirectory(dir),
  );
  return [...extra, ...current].join(delimiter);
};

/** The environment for the daemon an app starts: the login shell's (see mergeShellEnv), else `base` with fallbackPath. */
export const desktopEnv = async (
  base: NodeJS.ProcessEnv = process.env,
  probe: Omit<ProbeOptions, "env"> = {},
): Promise<{ env: NodeJS.ProcessEnv; source: "login-shell" | "fallback" }> => {
  const shell = await probeLoginShell({ ...probe, env: base });
  if (shell) return { env: mergeShellEnv(base, shell), source: "login-shell" };
  return { env: withoutTurnVars({ ...base, PATH: fallbackPath(base) }), source: "fallback" };
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where `name` runs from under `env`: a path (absolute, or with a slash) → itself when it is an
 * executable file; a bare name → the first executable file of that name in PATH's absolute entries.
 */
export const findExecutable = (name: string, env: NodeJS.ProcessEnv): string | null => {
  if (!name) return null;
  if (name.includes("/")) {
    const full = resolve(name);
    return isExecutableFile(full) ? full : null;
  }
  for (const dir of pathEntries(env.PATH)) {
    if (!isAbsolute(dir)) continue;
    const full = join(dir, name);
    if (isExecutableFile(full)) return full;
  }
  return null;
};
