import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lastCodexSessionLimits, limitKey, mergeLimits } from "./limits.js";
import { agoraHome } from "./paths.js";
import type { AgentKind, LimitReport, LimitSnapshot } from "./types.js";

/**
 * The latest limits each CLI reported, per subscription, in `<agoraHome>/limits.json` — so a restarted daemon
 * still shows them (with their age) before any agent speaks again. Only what the CLIs said is kept.
 */

export const limitsFile = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "limits.json");

/** Which login a CLI runs under: its home when the room's env sets one, else "default". */
export const limitAccount = (kind: AgentKind, env: NodeJS.ProcessEnv): string =>
  (kind === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME)?.trim() || "default";

const isSnapshot = (value: unknown): value is LimitSnapshot => {
  const entry = value as LimitSnapshot | null;
  return Boolean(entry && typeof entry.kind === "string" && typeof entry.account === "string" && Array.isArray(entry.windows) && typeof entry.at === "string");
};

/** Every subscription's latest report; none when the file is missing or unreadable. */
export const readLimits = (env: NodeJS.ProcessEnv = process.env): LimitSnapshot[] => {
  try {
    const parsed = JSON.parse(readFileSync(limitsFile(env), "utf8")) as { limits?: unknown };
    return Array.isArray(parsed.limits) ? parsed.limits.filter(isSnapshot) : [];
  } catch {
    return [];
  }
};

/** What a report says, without when: two reports that say the same thing have the same one. */
const saying = (snapshot: LimitSnapshot): string =>
  JSON.stringify([snapshot.status, snapshot.limited, snapshot.plan, snapshot.windows.map((window) => [window.id, window.usedPercent, window.resetsAt])]);

/** A report that says nothing new is kept only this often (Claude repeats its own after every model request). */
const REPEAT_MS = 60_000;

/**
 * Merges one report into the file (renamed into place) and returns every subscription's latest — or null when
 * it said what the file already says, within the last minute (nothing written).
 */
export const recordLimits = (env: NodeJS.ProcessEnv, snapshot: LimitSnapshot): LimitSnapshot[] | null => {
  const byKey = new Map(readLimits(env).map((entry) => [limitKey(entry), entry]));
  const key = limitKey(snapshot);
  const previous = byKey.get(key);
  const merged = mergeLimits(previous, snapshot);
  if (previous && saying(previous) === saying(merged) && Date.parse(merged.at) - Date.parse(previous.at) < REPEAT_MS) return null;
  byKey.set(key, merged);
  const limits = [...byKey.values()];
  const file = limitsFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify({ version: 1, limits }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return limits;
};

/** How much of a session file's end is read: token_count events come after every model request. */
const TAIL_BYTES = 256 * 1024;

/** The last limits in a Codex session file (its token_count events), or null. */
export const readCodexSessionLimits = (file: string): LimitReport | null => {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    // A tail read from the middle of a line starts at the next whole one.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return lastCodexSessionLimits(text);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
