import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";

const PHONE = "phone.example.test";
const call = (daemon: AgoraDaemon, path: string, options: { method?: string; cookie?: string; token?: string; host?: string; origin?: string; body?: unknown } = {}) => new Promise<{ status: number; cookies: string[]; body: string }>((resolve, reject) => {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const req = request({ hostname: "127.0.0.1", port: daemon.port, path, method: options.method ?? "GET", headers: {
    host: options.host ?? `127.0.0.1:${daemon.port}`,
    ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.token ? { "x-agoryx-token": options.token } : {}),
    ...(options.origin ? { origin: options.origin } : {}), ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
  } }, (res) => {
    let response = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { response += chunk; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, cookies: res.headers["set-cookie"] ?? [], body: response }));
  });
  req.on("error", reject); req.end(body);
});

/** Browsers key cookies by host/path/name, never by port. Both daemons below are 127.0.0.1. */
class CookieJar {
  private readonly values = new Map<string, string>();
  accept(cookies: string[]) {
    for (const cookie of cookies) {
      const pair = cookie.split(";", 1)[0]!, split = pair.indexOf("=");
      this.values.set(pair.slice(0, split), pair.slice(split + 1));
    }
  }
  get header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
}

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "agoryx-cookie-test-"));
  const make = (name: string) => new AgoraDaemon({ env: { ...process.env, AGORYX_HOME: join(root, name), AGORYX_USER: "Test" }, port: 0, advertise: false, runners: {}, watchDays: 0, hosts: [PHONE] });
  const daemons = [make("first"), make("second")];
  await Promise.all(daemons.map((daemon) => daemon.start()));
  return { daemons, make, close: async () => { await Promise.all(daemons.map((daemon) => daemon.close())); rmSync(root, { recursive: true, force: true }); } };
};

test("two localhost daemons retain separate browser logins across ports and restarts", async () => {
  const f = await fixture();
  try {
    const jar = new CookieJar();
    for (const daemon of f.daemons) {
      const login = await call(daemon, `/?t=${encodeURIComponent(daemon.token)}`);
      assert.equal(login.status, 302); jar.accept(login.cookies);
      for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/"]) assert(login.cookies[0]!.includes(flag));
    }
    assert.equal((await call(f.daemons[0]!, "/api/rooms", { cookie: jar.header })).status, 200, "logging into the second port must not log out the first");
    assert.equal((await call(f.daemons[1]!, "/api/rooms", { cookie: jar.header })).status, 200);
    await f.daemons[0]!.close(); f.daemons[0] = f.make("first"); await f.daemons[0]!.start();
    assert.equal((await call(f.daemons[0]!, "/api/rooms", { cookie: jar.header })).status, 200, "the persistent daemon identity must survive port changes");
  } finally { await f.close(); }
});

test("scoped cookies take precedence while legacy logins and explicit token headers remain supported", async () => {
  const f = await fixture(); const [first, second] = f.daemons as [AgoraDaemon, AgoraDaemon];
  try {
    const login = await call(first, `/?t=${encodeURIComponent(first.token)}`), scoped = login.cookies[0]!.split(";", 1)[0]!;
    const name = scoped.slice(0, scoped.indexOf("="));
    const legacy = `agoryx_token=${encodeURIComponent(first.token)}`;
    assert.equal((await call(first, "/api/rooms", { cookie: legacy })).status, 200);
    assert.equal((await call(first, "/api/rooms", { cookie: `${scoped}; agoryx_token=${encodeURIComponent(second.token)}` })).status, 200);
    assert.equal((await call(first, "/api/rooms", { cookie: `${name}=wrong; ${legacy}` })).status, 401, "an invalid scoped credential must not fall back to a broader cookie");
    assert.equal((await call(first, "/api/rooms", { cookie: `${name}=%malformed; ${legacy}` })).status, 401);
    assert.equal((await call(first, "/api/rooms", { cookie: `${name}=wrong`, token: first.token })).status, 200);
    assert.equal((await call(first, "/api/rooms", { cookie: scoped, token: "wrong" })).status, 401);
    assert.equal((await call(first, "/api/rooms", { cookie: scoped, origin: second.url })).status, 403);
    assert.equal((await call(first, "/api/rooms", { cookie: scoped, host: "unexpected.example" })).status, 421);
  } finally { await f.close(); }
});

test("new device pairings use the same daemon scope and legacy paired cookies still honor revocation", async () => {
  const f = await fixture(); const [first, second] = f.daemons as [AgoraDaemon, AgoraDaemon];
  try {
    const local = await call(first, `/?t=${encodeURIComponent(first.token)}`), name = local.cookies[0]!.split("=", 1)[0]!;
    const { code } = first.devices.createCode();
    const claimed = await call(first, "/api/pair/claim", { method: "POST", host: PHONE, origin: `https://${PHONE}`, body: { code } });
    assert.equal(claimed.status, 201); const scoped = claimed.cookies[0]!.split(";", 1)[0]!;
    assert.equal(scoped.split("=", 1)[0], name);
    for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"]) assert(claimed.cookies[0]!.includes(flag));
    const legacy = `agoryx_token=${scoped.slice(scoped.indexOf("=") + 1)}`;
    const device = JSON.parse(claimed.body).device;
    assert(!claimed.body.includes("agxd1."));
    assert.equal((await call(first, "/api/rooms", { cookie: scoped, host: PHONE })).status, 200);
    assert.equal((await call(first, "/api/rooms", { cookie: legacy, host: PHONE })).status, 200);
    assert.equal((await call(second, "/api/rooms", { cookie: scoped, host: PHONE })).status, 401);
    assert.equal((await call(first, "/api/rooms", { cookie: local.cookies[0]!.split(";", 1)[0]!, host: PHONE })).status, 401, "a human host token must still fail off loopback");
    const revoked = await call(first, `/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", token: first.token });
    assert.equal(revoked.status, 200);
    assert.equal((await call(first, "/api/rooms", { cookie: scoped, host: PHONE })).status, 401);
    assert.equal((await call(first, "/api/rooms", { cookie: legacy, host: PHONE })).status, 401);
  } finally { await f.close(); }
});
