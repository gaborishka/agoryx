import { existsSync, readFileSync } from "node:fs";
import { daemonInfoPath } from "./paths.js";

/**
 * Finding the running daemon from outside it: its record in `<AGORYX_HOME>/daemon.json` and its
 * `/api/health`. Dependency-free on purpose (node built-ins and paths.ts only), so the desktop app's
 * main process can use it without loading the daemon, its store or better-sqlite3.
 */

export interface DaemonInfo {
  pid: number;
  port: number;
  url: string;
  token: string;
  startedAt: string;
}

/** Whether a process with this pid exists (EPERM: it does, and belongs to someone else). */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const readDaemonInfo = (env: NodeJS.ProcessEnv = process.env): DaemonInfo | null => {
  const path = daemonInfoPath(env);
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as DaemonInfo;
    if (!info.pid || !info.port || !info.token || !pidAlive(info.pid)) return null;
    return info;
  } catch {
    return null;
  }
};

/**
 * The daemon daemon.json names, and whether it answered /api/health. `busy`: alive and holding its port
 * but no answer in time (git on its event loop, rooms loading, stopped in a debugger) — not gone. null:
 * none (no record, a dead pid, nothing listening on its port because the record outlived its daemon and
 * the pid was reused, or another process answering there).
 */
export const probeDaemon = async (env: NodeJS.ProcessEnv = process.env): Promise<{ info: DaemonInfo; busy: boolean } | null> => {
  const info = readDaemonInfo(env);
  if (!info) return null;
  try {
    const response = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const health = (await response.json()) as { pid?: number };
    return health.pid === info.pid ? { info, busy: false } : null;
  } catch (error) {
    // Timed out: something holds the port and does not answer. Refused: nothing is there.
    return (error as { name?: unknown } | null)?.name === "TimeoutError" ? { info, busy: true } : null;
  }
};

/** A daemon that is alive and answers /api/health, or null. */
export const findDaemon = async (env: NodeJS.ProcessEnv = process.env): Promise<DaemonInfo | null> => {
  const found = await probeDaemon(env);
  return found && !found.busy ? found.info : null;
};
