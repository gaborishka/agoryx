import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { headlineWindow, lastCodexSessionLimits, limitPace, mergeLimits, parseClaudeRateLimit, parseCodexRateLimits } from "../../internal/agora/limits.js";
import { limitAccount, limitsFile, readCodexSessionLimits, readLimits, recordLimits } from "../../internal/agora/limits-store.js";
import type { LimitSnapshot } from "../../internal/agora/types.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "limits");
const lines = (name: string) =>
  readFileSync(join(fixtures, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const AT = "2026-09-29T23:43:00.000Z";

test("Claude's rate_limit_event: every unified window, as a percent, with its reset and length", () => {
  const [event] = lines("claude-stream.jsonl");
  const report = parseClaudeRateLimit(event!, AT);
  assert.deepEqual(report, {
    windows: [
      { id: "five_hour", minutes: 300, usedPercent: 7, resetsAt: new Date(1790742000 * 1000).toISOString(), at: AT },
      { id: "seven_day", minutes: 10080, usedPercent: 45, resetsAt: new Date(1790730000 * 1000).toISOString(), at: AT },
    ],
    complete: true,
    status: "allowed",
    limited: false,
  });
  assert.equal(parseClaudeRateLimit({ type: "result" }, AT), null);
});

test("Claude's older single-window event is partial, and a rejected status is the limit reached", () => {
  const [, event] = lines("claude-stream.jsonl");
  const report = parseClaudeRateLimit(event!, AT)!;
  assert.equal(report.complete, false);
  assert.equal(report.limited, true);
  assert.deepEqual(report.windows.map((window) => [window.id, window.usedPercent, window.minutes]), [["five_hour", 100, 300]]);
});

test("Codex app-server's account/rateLimits/updated: camelCase windows, null ones skipped, the plan kept", () => {
  const [notification] = lines("codex-app-server.jsonl");
  assert.equal(notification!.method, "account/rateLimits/updated");
  const report = parseCodexRateLimits((notification!.params as Record<string, unknown>).rateLimits, AT);
  assert.deepEqual(report, {
    windows: [{ id: "primary", minutes: 10080, usedPercent: 67, resetsAt: new Date(1791048507 * 1000).toISOString(), at: AT }],
    complete: true,
    limited: false,
    plan: "pro",
  });
  assert.equal(parseCodexRateLimits(null), null);
  assert.equal(parseCodexRateLimits({ primary: null, secondary: null }), null);
  assert.equal(parseCodexRateLimits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 }, rateLimitReachedType: "primary" })?.limited, true);
});

test("Codex session files: the last token_count's rate_limits, dated by its line; an older resets_in_seconds too", () => {
  const text = readFileSync(join(fixtures, "codex-session.jsonl"), "utf8");
  const report = lastCodexSessionLimits(text)!;
  assert.deepEqual(report.windows, [
    { id: "primary", minutes: 10080, usedPercent: 67, resetsAt: new Date(1791048507 * 1000).toISOString(), at: "2026-09-29T23:09:11.450Z" },
  ]);
  assert.equal(report.plan, "pro");
  assert.equal(lastCodexSessionLimits('{"type":"event_msg","payload":{"type":"task_started"}}\n'), null);
  const older = lastCodexSessionLimits(
    `${JSON.stringify({ timestamp: "2026-09-29T10:00:00.000Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 600 } } } })}\n`,
  )!;
  assert.equal(older.windows[0]!.resetsAt, "2026-09-29T10:10:00.000Z");
});

test("Codex's other quota buckets (Spark, premium) are not the account's: the last \"codex\" report wins", () => {
  // Recorded: a gpt-6-astra session whose last token_counts are the Spark bucket at 0% and an empty premium one.
  const text = readFileSync(join(fixtures, "codex-session-buckets.jsonl"), "utf8");
  const report = lastCodexSessionLimits(text)!;
  assert.deepEqual(report.windows.map((window) => [window.id, window.minutes, window.usedPercent]), [["primary", 10080, 79]]);
  assert.equal(report.plan, "pro");
  const [, spark] = text.split("\n").map((line) => (line ? (JSON.parse(line) as { payload: { rate_limits: unknown } }) : null));
  assert.equal(parseCodexRateLimits(spark!.payload.rate_limits, AT), null);
  assert.equal(parseCodexRateLimits({ limitId: "codex_bengalfox", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1 } }, AT), null);
});

test("Codex app-server's rolling update is sparse: a null window or plan keeps what was known", () => {
  const full = parseCodexRateLimits(
    { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1790760000 }, secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 1791000000 }, planType: "plus" },
    AT,
  )!;
  const rolling = parseCodexRateLimits(
    { limitId: "codex", primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1790760000 }, secondary: null, planType: null, rateLimitReachedType: null },
    AT,
    { sparse: true },
  )!;
  assert.equal(rolling.complete, false);
  const base = { kind: "codex" as const, account: "default", source: "codex-app-server" as const, at: AT };
  const merged = mergeLimits({ ...base, ...full }, { ...base, ...rolling });
  assert.deepEqual(merged.windows.map((window) => [window.id, window.usedPercent]).sort(), [["primary", 41], ["secondary", 70]]);
  assert.equal(merged.plan, "plus");
  assert.equal(merged.complete, true);
  assert.equal(merged.limited, false);
});

test("a session file is read from its tail: a partial first line is skipped, the last report found", () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-limits-"));
  try {
    const file = join(dir, "rollout.jsonl");
    const filler = `${JSON.stringify({ type: "response_item", payload: { text: "x".repeat(1000) } })}\n`.repeat(400);
    writeFileSync(file, filler + readFileSync(join(fixtures, "codex-session.jsonl"), "utf8"));
    assert.equal(readCodexSessionLimits(file)?.windows[0]?.usedPercent, 67);
    assert.equal(readCodexSessionLimits(join(dir, "missing.jsonl")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const snapshot = (overrides: Partial<LimitSnapshot> = {}): LimitSnapshot => ({
  kind: "claude",
  account: "default",
  source: "claude-stream",
  at: AT,
  complete: true,
  windows: [
    { id: "five_hour", minutes: 300, usedPercent: 7, resetsAt: "2026-09-30T03:40:00.000Z", at: AT },
    { id: "seven_day", minutes: 10080, usedPercent: 45, resetsAt: "2026-09-30T00:20:00.000Z", at: AT },
  ],
  ...overrides,
});

test("a partial report replaces only the windows it names; a complete one replaces them all", () => {
  const partial = snapshot({ complete: false, status: "rejected", limited: true, windows: [{ id: "five_hour", minutes: 300, usedPercent: 100, at: AT }] });
  const merged = mergeLimits(snapshot(), partial);
  assert.deepEqual(merged.windows.map((window) => [window.id, window.usedPercent]), [["seven_day", 45], ["five_hour", 100]]);
  assert.equal(merged.limited, true);
  assert.equal(merged.complete, true);
  const complete = snapshot({ windows: [{ id: "five_hour", minutes: 300, usedPercent: 3, at: AT }] });
  assert.deepEqual(mergeLimits(merged, complete).windows.map((window) => window.id), ["five_hour"]);
});

test("limits are kept per CLI and login in <AGORYX_HOME>/limits.json, across a restart; a repeat is not rewritten", () => {
  const home = mkdtempSync(join(tmpdir(), "agora-limits-"));
  const env = { AGORYX_HOME: home };
  try {
    assert.deepEqual(readLimits(env), []);
    assert.equal(recordLimits(env, snapshot())!.length, 1);
    const codex: LimitSnapshot = {
      kind: "codex",
      account: limitAccount("codex", { CODEX_HOME: "/tmp/codex-work" }),
      source: "codex-app-server",
      at: AT,
      complete: true,
      plan: "pro",
      windows: [{ id: "primary", minutes: 10080, usedPercent: 67, resetsAt: "2026-10-03T21:28:27.000Z", at: AT }],
    };
    assert.equal(recordLimits(env, codex)!.length, 2);
    // The same words half a minute later: nothing new, nothing written.
    const later = new Date(Date.parse(AT) + 30_000).toISOString();
    assert.equal(recordLimits(env, { ...snapshot(), at: later }), null);
    // A new number is kept at once.
    const moved = snapshot({ at: later, windows: [{ ...snapshot().windows[0]!, usedPercent: 9 }, snapshot().windows[1]!] });
    recordLimits(env, moved);
    // A daemon that starts again reads them back.
    const back = readLimits(env);
    assert.deepEqual(
      back.map((entry) => [entry.kind, entry.account, entry.windows[0]!.usedPercent]),
      [["claude", "default", 9], ["codex", "/tmp/codex-work", 67]],
    );
    assert.equal(limitAccount("claude", {}), "default");
    writeFileSync(limitsFile(env), "not json");
    assert.deepEqual(readLimits(env), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pace: used against how much of the window has gone by", () => {
  const resetsAt = "2026-09-30T05:00:00.000Z";
  const window = { minutes: 300, resetsAt };
  const at = (iso: string) => Date.parse(iso);
  // Half the window gone, 40% used: on pace.
  assert.deepEqual(limitPace({ ...window, usedPercent: 40 }, at("2026-09-30T02:30:00.000Z")), { state: "on-pace", elapsedPercent: 50 });
  // Half gone, 80% used: at that rate it runs out at 62.5% of the window, 03:07:30, before the 05:00 reset.
  assert.deepEqual(limitPace({ ...window, usedPercent: 80 }, at("2026-09-30T02:30:00.000Z")), {
    state: "ahead",
    elapsedPercent: 50,
    runsOutAt: "2026-09-30T03:07:30.000Z",
  });
  assert.equal(limitPace({ ...window, usedPercent: 3 }, at("2026-09-30T00:05:00.000Z")).state, "early");
  // Heavy use right after the reset is not "too early to say".
  const heavy = limitPace({ ...window, usedPercent: 60 }, at("2026-09-30T00:14:00.000Z"));
  assert.equal(heavy.state, "ahead");
  assert.equal(heavy.elapsedPercent, 4.7);
  assert.equal(limitPace({ ...window, usedPercent: 100 }, at("2026-09-30T04:00:00.000Z")).state, "out");
  assert.equal(limitPace({ ...window, usedPercent: 90 }, at("2026-09-30T05:00:01.000Z")).state, "reset");
  assert.equal(limitPace({ usedPercent: 10 }).state, "unknown");
  assert.equal(limitPace({ usedPercent: 10, resetsAt }).state, "unknown");
});

test("the indicator shows the window closest to running out, the shorter on a tie, none that has reset", () => {
  const now = Date.parse("2026-09-30T00:00:00.000Z");
  const five = { id: "five_hour", minutes: 300, usedPercent: 30, resetsAt: "2026-09-30T02:00:00.000Z", at: AT };
  const week = { id: "seven_day", minutes: 10080, usedPercent: 45, resetsAt: "2026-10-03T00:00:00.000Z", at: AT };
  assert.equal(headlineWindow([five, week], now)?.id, "seven_day");
  assert.equal(headlineWindow([week, { ...five, usedPercent: 45 }], now)?.id, "five_hour");
  assert.equal(headlineWindow([{ ...week, resetsAt: "2026-09-29T00:00:00.000Z" }], now), undefined);
});

const FAKE_LIMITS = JSON.stringify({ used: 42, resetsAt: Math.floor(Date.now() / 1000) + 3600 });

for (const live of [false, true]) {
  test(`each CLI's limits reach the engine as the account's snapshot${live ? " (live processes)" : " (a process per turn)"}`, async () => {
    const seen: LimitSnapshot[] = [];
    const room = createTestRoom({ env: { FAKE_RATE_LIMITS: FAKE_LIMITS }, live, onLimits: (entry) => seen.push(entry) });
    try {
      room.engine.postHuman("hello");
      await withTimeout(room.engine.waitIdle());
      const claude = seen.filter((entry) => entry.kind === "claude");
      const codex = seen.filter((entry) => entry.kind === "codex");
      assert.ok(claude.length >= 1, "claude reported");
      assert.ok(codex.length >= 1, "codex reported");
      assert.equal(claude[0]!.source, "claude-stream");
      assert.equal(claude[0]!.account, room.env.CLAUDE_CONFIG_DIR);
      assert.deepEqual(claude[0]!.windows.map((window) => [window.id, window.usedPercent]), [["five_hour", 42], ["seven_day", 21]]);
      // `codex exec` prints none: they come from its session file. app-server says them itself.
      assert.equal(codex[0]!.source, live ? "codex-app-server" : "codex-session");
      assert.equal(codex[0]!.account, room.env.CODEX_HOME);
      assert.deepEqual(codex[0]!.windows.map((window) => [window.id, window.usedPercent, window.minutes]), [["primary", 42, 10080]]);
      assert.equal(codex[0]!.plan, "pro");
    } finally {
      await room.cleanup();
    }
  });
}

test("without limits from the CLI, nothing is reported", async () => {
  const seen: LimitSnapshot[] = [];
  const room = createTestRoom({ onLimits: (entry) => seen.push(entry) });
  try {
    room.engine.postHuman("hello");
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(seen, []);
  } finally {
    await room.cleanup();
  }
});
