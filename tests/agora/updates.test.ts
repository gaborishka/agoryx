import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonClient } from "../../internal/agora/client.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { compareVersions, CHECK_EVERY_MS, isNewer, parseRelease, UpdateChecker, updatePath, type FetchLike } from "../../internal/agora/updates.js";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Agoryx ${tag.replace(/^v/, "")}`,
  html_url: `https://github.com/gaborishka/agoryx/releases/tag/${tag}`,
  published_at: "2026-10-01T10:00:00Z",
  body: "- Faster rooms\r\n- Fixes",
  assets: [
    { name: "SHA256SUMS.txt", browser_download_url: "https://github.com/gaborishka/agoryx/releases/download/x/SHA256SUMS.txt" },
    { name: `Agoryx-${tag.replace(/^v/, "")}-arm64.dmg`, browser_download_url: `https://github.com/gaborishka/agoryx/releases/download/${tag}/Agoryx-arm64.dmg` },
  ],
  ...extra,
});

/** A GitHub that answers `answer` and counts the calls. */
const github = (answer: () => { status: number; body?: unknown } | Error) => {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const reply = answer();
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  return { fetch, calls };
};

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-updates-"));
  return { dir, env: { ...process.env, AGORYX_HOME: join(dir, "agora"), AGORYX_UPDATE_CHECK: "" } };
};

test("versions compare as semantic versions, a pre-release before its release", () => {
  assert.equal(compareVersions("0.1.2", "0.1.1"), 1);
  assert.equal(compareVersions("v0.2.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("nightly", "1.0.0"), null);
  assert.equal(isNewer("0.1.2", "0.1.1"), true);
  assert.equal(isNewer("0.1.1", "0.1.1"), false);
  assert.equal(isNewer("0.1.0", "0.1.1"), false);
  assert.equal(isNewer("0.1.2", null), false);
});

test("a release reads as its version, its page, its DMG and its notes; drafts, pre-releases and foreign links do not pass", () => {
  const parsed = parseRelease(release("v0.2.0"));
  assert.deepEqual(parsed, {
    version: "0.2.0",
    name: "Agoryx 0.2.0",
    url: "https://github.com/gaborishka/agoryx/releases/tag/v0.2.0",
    download: "https://github.com/gaborishka/agoryx/releases/download/v0.2.0/Agoryx-arm64.dmg",
    publishedAt: "2026-10-01T10:00:00Z",
    notes: "- Faster rooms\n- Fixes",
  });
  assert.equal(parseRelease(release("v0.2.0", { draft: true })), null);
  assert.equal(parseRelease(release("v0.2.0", { prerelease: true })), null);
  assert.equal(parseRelease(release("latest")), null);
  const foreign = parseRelease(release("v0.2.0", { html_url: "https://evil.example/agoryx", assets: [{ name: "a.dmg", browser_download_url: "http://github.com/a.dmg" }] }));
  assert.equal(foreign?.url, "https://github.com/gaborishka/agoryx/releases/latest");
  assert.equal(foreign?.download, null);
});

test("the checker asks GitHub once per interval, remembers the answer across restarts, and keeps it through a failed check", async () => {
  const { dir, env } = scratch();
  try {
    let now = Date.parse("2026-10-06T08:00:00Z");
    let reply: { status: number; body?: unknown } | Error = { status: 200, body: release("v0.2.0") };
    const remote = github(() => reply);
    const checker = new UpdateChecker({ env, current: "0.1.1", fetch: remote.fetch, now: () => now });
    assert.equal(checker.status().checkedAt, null);
    const first = await checker.check();
    assert.equal(first.available, true);
    assert.equal(first.latest?.version, "0.2.0");
    assert.equal(first.current, "0.1.1");
    assert.equal(remote.calls.length, 1);
    assert.match(remote.calls[0]!, /api\.github\.com\/repos\/gaborishka\/agoryx\/releases\/latest$/);

    // Within the interval: the remembered answer, no request.
    now += CHECK_EVERY_MS / 2;
    await checker.check();
    assert.equal(remote.calls.length, 1);

    // A restarted daemon reads it back from update.json.
    const again = new UpdateChecker({ env, current: "0.1.1", fetch: remote.fetch, now: () => now });
    assert.equal(again.status().available, true);
    await again.check();
    assert.equal(remote.calls.length, 1);
    assert.equal(JSON.parse(readFileSync(updatePath(env), "utf8")).latest.version, "0.2.0");

    // GitHub down: the error is told, the release found before still stands.
    now += CHECK_EVERY_MS;
    reply = new Error("getaddrinfo ENOTFOUND api.github.com");
    const failed = await again.check();
    assert.equal(remote.calls.length, 2);
    assert.match(failed.error ?? "", /ENOTFOUND/);
    assert.equal(failed.latest?.version, "0.2.0");
    assert.equal(failed.available, true);

    // "Check for updates" asks now; the installed version is the latest.
    reply = { status: 200, body: release("v0.1.1") };
    const updated = new UpdateChecker({ env, current: "0.1.1", fetch: remote.fetch, now: () => now });
    const forced = await updated.check(true);
    assert.equal(remote.calls.length, 3);
    assert.equal(forced.available, false);
    assert.equal(forced.error, null);

    // Updated past what was remembered: nothing is offered.
    reply = { status: 200, body: release("v0.2.0") };
    await updated.check(true);
    assert.equal(new UpdateChecker({ env, current: "0.2.0", fetch: remote.fetch, now: () => now }).status().available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent checks share one request; AGORYX_UPDATE_CHECK=off asks nothing", async () => {
  const { dir, env } = scratch();
  try {
    const remote = github(() => ({ status: 200, body: release("v0.3.0") }));
    const checker = new UpdateChecker({ env, current: "0.1.1", fetch: remote.fetch });
    await Promise.all([checker.check(true), checker.check(true), checker.check()]);
    assert.equal(remote.calls.length, 1);

    const off = new UpdateChecker({ env: { ...env, AGORYX_UPDATE_CHECK: "off" }, current: "0.1.1", fetch: remote.fetch });
    const status = await off.check(true);
    assert.equal(status.disabled, true);
    assert.equal(status.available, false);
    assert.equal(remote.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/update answers what the daemon knows; POST asks again", async () => {
  const { dir, env } = scratch();
  const remote = github(() => ({ status: 200, body: release("v99.0.0") }));
  const daemon = new AgoraDaemon({ env: { ...env, AGORYX_JEV: "off" }, port: 0, advertise: false, watchDays: 0, updateFetch: remote.fetch });
  try {
    const info = await daemon.start();
    const client = new DaemonClient(info);
    const status = await client.request<{ available: boolean; current: string | null; latest: { version: string } | null }>("GET", "/api/update");
    assert.equal(status.available, true);
    assert.equal(status.latest?.version, "99.0.0");
    assert.ok(status.current);
    await client.request("GET", "/api/update");
    assert.equal(remote.calls.length, 1);
    await client.request("POST", "/api/update");
    assert.equal(remote.calls.length, 2);
  } finally {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
