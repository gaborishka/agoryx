/**
 * Subscription limits, exactly as the agents' CLIs report them — nothing is estimated, and nothing acts on them.
 *
 * Claude Code (`-p --output-format stream-json --verbose`) prints a `rate_limit_event` per model request:
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790742000,"rateLimitType":"five_hour",
 *    "unifiedWindows":{"five_hour":{"utilization":0.07,"resetsAt":…},"seven_day":{"utilization":0.45,"resetsAt":…}}}}
 * Codex reports `rate_limits` on its token counts: `account/rateLimits/updated` from `app-server` (camelCase:
 * usedPercent, windowDurationMins, resetsAt) and `token_count` events in its session files (snake_case:
 * used_percent, window_minutes, resets_at). `codex exec --json` itself prints none. Each report is one quota
 * bucket (`limit_id`): "codex" is the account's; others ("codex_bengalfox" for GPT-5.3-Codex-Spark, "premium")
 * have windows of their own and are not the account's, so they are skipped.
 *
 * Pure: the UI imports it for the pace (limits-store.ts keeps them on disk).
 */
import type { LimitReport, LimitSnapshot, LimitWindow } from "./types.js";

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Epoch seconds → ISO. */
const isoFromSeconds = (seconds: number | undefined): string | undefined =>
  seconds === undefined || seconds <= 0 ? undefined : new Date(seconds * 1000).toISOString();

/** Claude names its windows; their lengths follow from the names. */
export const claudeWindowMinutes = (id: string): number | undefined =>
  id === "five_hour" ? 300 : id.startsWith("seven_day") ? 7 * 24 * 60 : undefined;

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value * 10) / 10));

/** Claude's `rate_limit_event`, or null for anything else. `at`: when it was read. */
export const parseClaudeRateLimit = (event: Json, at = new Date().toISOString()): LimitReport | null => {
  if (event.type !== "rate_limit_event") return null;
  const info = asObject(event.rate_limit_info);
  if (!info) return null;
  const status = str(info.status);
  const windows: LimitWindow[] = [];
  const unified = asObject(info.unifiedWindows);
  if (unified) {
    for (const [id, raw] of Object.entries(unified)) {
      const entry = asObject(raw);
      const utilization = num(entry?.utilization);
      if (utilization === undefined) continue;
      const minutes = claudeWindowMinutes(id);
      const resetsAt = isoFromSeconds(num(entry?.resetsAt));
      windows.push({ id, ...(minutes ? { minutes } : {}), usedPercent: clampPercent(utilization * 100), ...(resetsAt ? { resetsAt } : {}), at });
    }
  } else {
    // The older shape: one window, with its utilization when the CLI gives one.
    const id = str(info.rateLimitType);
    const utilization = num(info.utilization);
    if (id && utilization !== undefined) {
      const minutes = claudeWindowMinutes(id);
      const resetsAt = isoFromSeconds(num(info.resetsAt));
      windows.push({ id, ...(minutes ? { minutes } : {}), usedPercent: clampPercent(utilization * 100), ...(resetsAt ? { resetsAt } : {}), at });
    }
  }
  if (!windows.length && !status) return null;
  return { windows, complete: Boolean(unified), ...(status ? { status, limited: status === "rejected" } : {}) };
};

/** Codex's own bucket id for the account's limits; a report without one (older CLIs) is the account's too. */
export const CODEX_ACCOUNT_LIMIT = "codex";

/**
 * Codex's `rate_limits` object, in either spelling: app-server's camelCase or the session file's snake_case.
 * `at`: when Codex said it (a session line's timestamp), which also anchors an older `resets_in_seconds`.
 * Null for another bucket than the account's. `sparse`: app-server's rolling `account/rateLimits/updated`, where
 * a null window or plan is "not in this update", not "gone" — merged over what was known, not replacing it.
 */
export const parseCodexRateLimits = (raw: unknown, at = new Date().toISOString(), { sparse = false } = {}): LimitReport | null => {
  const limits = asObject(raw);
  if (!limits) return null;
  const limitId = str(limits.limitId) ?? str(limits.limit_id);
  if (limitId && limitId !== CODEX_ACCOUNT_LIMIT) return null;
  const windows: LimitWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const entry = asObject(limits[id]);
    if (!entry) continue;
    const used = num(entry.usedPercent) ?? num(entry.used_percent);
    if (used === undefined) continue;
    const minutes = num(entry.windowDurationMins) ?? num(entry.window_minutes);
    const resetsIn = num(entry.resets_in_seconds) ?? num(entry.resetsInSeconds);
    const resetsAt = isoFromSeconds(num(entry.resetsAt) ?? num(entry.resets_at)) ?? (resetsIn !== undefined ? new Date(Date.parse(at) + resetsIn * 1000).toISOString() : undefined);
    windows.push({ id, ...(minutes ? { minutes } : {}), usedPercent: clampPercent(used), ...(resetsAt ? { resetsAt } : {}), at });
  }
  const reached = str(limits.rateLimitReachedType) ?? str(limits.rate_limit_reached_type);
  const plan = str(limits.planType) ?? str(limits.plan_type);
  if (!windows.length && !reached) return null;
  return { windows, complete: !sparse, limited: Boolean(reached), ...(plan ? { plan } : {}) };
};

/** The last `rate_limits` in a Codex session file's text (its token_count events), or null. */
export const lastCodexSessionLimits = (text: string): LimitReport | null => {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes('"rate_limits"')) continue;
    let event: Json;
    try {
      event = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const payload = asObject(event.payload);
    if (payload?.type !== "token_count" || !payload.rate_limits) continue;
    const at = str(event.timestamp) ?? new Date().toISOString();
    const report = parseCodexRateLimits(payload.rate_limits, Number.isNaN(Date.parse(at)) ? new Date().toISOString() : at);
    if (report) return report;
  }
  return null;
};

/**
 * A new report over what was known: a complete one replaces the windows; a partial one (Claude's older single
 * window, Codex's rolling update) replaces only the windows it names and keeps a plan it leaves out. Whether the
 * CLI is refusing now goes with the newest report.
 */
export const mergeLimits = (previous: LimitSnapshot | undefined, next: LimitSnapshot): LimitSnapshot => {
  if (!previous || next.complete) return next;
  const named = new Set(next.windows.map((window) => window.id));
  const { status: _status, limited: _limited, ...kept } = previous;
  return {
    ...kept,
    ...next,
    windows: [...previous.windows.filter((window) => !named.has(window.id)), ...next.windows],
    complete: previous.complete,
  };
};

// ---------------------------------------------------------------------------
// Pace: used% against how much of the window has gone by
// ---------------------------------------------------------------------------

export type PaceState =
  /** The CLI gave no reset time or no window length: nothing to compare with. */
  | "unknown"
  /** The window reset after the CLI said this: the number is from the window before. */
  | "reset"
  /** Used up. */
  | "out"
  /** Too little of the window has gone by, and too little used, to say. */
  | "early"
  /** Used no faster than the window goes by. */
  | "on-pace"
  /** Used faster: at this rate it runs out before the reset (`runsOutAt`). */
  | "ahead";

export interface Pace {
  state: PaceState;
  /** How much of the window has gone by, 0–100. */
  elapsedPercent?: number;
  /** Ahead of pace: when it runs out at the rate so far (ISO). */
  runsOutAt?: string;
}

/** Below this much of the window gone, a rate says little… */
const EARLY_PERCENT = 5;
/** …unless more than this much is used already. */
const EARLY_USED_PERCENT = 10;

/**
 * Where a window stands at `now`: used% against elapsed%. The rate is the window's so far (used / elapsed),
 * the same measure as the CLIs' own "on pace" hints — a hint, not a forecast.
 */
export const limitPace = (window: Pick<LimitWindow, "usedPercent" | "minutes" | "resetsAt">, now = Date.now()): Pace => {
  const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (!window.minutes || Number.isNaN(resets)) return window.usedPercent >= 100 ? { state: "out" } : { state: "unknown" };
  if (resets <= now) return { state: "reset" };
  const length = window.minutes * 60_000;
  const start = resets - length;
  const elapsed = Math.max(0, Math.min(1, (now - start) / length));
  const elapsedPercent = Math.round(elapsed * 1000) / 10;
  if (window.usedPercent >= 100) return { state: "out", elapsedPercent };
  // Right after a reset only a little use says nothing yet; more than that is already ahead.
  if (elapsedPercent < EARLY_PERCENT && window.usedPercent <= EARLY_USED_PERCENT) return { state: "early", elapsedPercent };
  if (window.usedPercent <= elapsedPercent) return { state: "on-pace", elapsedPercent };
  const runsOut = start + (100 / window.usedPercent) * (now - start);
  return { state: "ahead", elapsedPercent, runsOutAt: new Date(Math.min(runsOut, resets)).toISOString() };
};

/** The window a compact indicator shows: the one closest to running out, the shorter on a tie. */
export const headlineWindow = (windows: LimitWindow[], now = Date.now()): LimitWindow | undefined =>
  windows
    .filter((window) => limitPace(window, now).state !== "reset")
    .sort((a, b) => b.usedPercent - a.usedPercent || (a.minutes ?? Infinity) - (b.minutes ?? Infinity))[0];

/** A key for one subscription. */
export const limitKey = (snapshot: Pick<LimitSnapshot, "kind" | "account">): string => `${snapshot.kind}:${snapshot.account}`;
