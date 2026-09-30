import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { deviceLabel, deviceName, DeviceRegistry, formatCode, isDeviceToken, normalizeCode, PairingError } from "../../internal/agora/devices.js";

// Pairing codes and device tokens (internal/agora/devices.ts): one use, five minutes, limited guesses;
// only the hash of a token is kept, and a revoked device is out.

let home: string;
let env: NodeJS.ProcessEnv;
let clock: number;
const now = () => clock;

before(() => {
  home = mkdtempSync(join(tmpdir(), "agora-devices-"));
});

after(() => rmSync(home, { recursive: true, force: true }));

/** A registry of its own (its own file) with a clock the test moves. */
const registry = (name: string) => {
  env = { ...process.env, AGORYX_HOME: join(home, name) };
  clock = Date.parse("2026-09-30T10:00:00Z");
  return new DeviceRegistry({ env, now });
};

const phone = { address: "192.168.1.20", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };

const claimFails = (devices: DeviceRegistry, code: string, status: number, from = phone, reason?: string) =>
  assert.throws(
    () => devices.claim(code, from),
    (error: unknown) => error instanceof PairingError && error.status === status && (reason === undefined || error.reason === reason),
  );

test("a code works once, typed in any case and with or without its dash; the token is a device token", () => {
  const devices = registry("once");
  const { code, expiresAt } = devices.createCode();
  assert.match(code, /^[2-9A-HJKMNP-Z]{8}$/);
  assert.equal(Date.parse(expiresAt) - clock, 5 * 60_000);
  const typed = formatCode(code).toLowerCase();
  assert.equal(normalizeCode(typed), code);
  const { token, device } = devices.claim(typed, phone);
  assert.ok(isDeviceToken(token));
  assert.equal(device.name, "iPhone · Safari");
  assert.equal(device.push, false);
  claimFails(devices, code, 400);
  assert.equal(devices.liveCodes(), 0);
});

test("a code expires after five minutes", () => {
  const devices = registry("expiry");
  const { code } = devices.createCode();
  clock += 5 * 60_000 - 1;
  assert.equal(devices.liveCodes(), 1);
  clock += 1;
  assert.equal(devices.liveCodes(), 0);
  claimFails(devices, code, 400);
});

test("at most three codes are live: a fourth drops the oldest", () => {
  const devices = registry("live");
  const first = devices.createCode().code;
  devices.createCode();
  devices.createCode();
  const fourth = devices.createCode().code;
  assert.equal(devices.liveCodes(), 3);
  claimFails(devices, first, 400);
  assert.ok(devices.claim(fourth, phone).token);
});

test("the QR link's secret is long, works once, and spends the typed code with it (and the other way round)", () => {
  const devices = registry("secret");
  const one = devices.createCode();
  assert.match(one.secret, /^[2-9A-HJKMNP-Z]{26}$/);
  assert.ok(devices.claim(one.secret.toLowerCase(), phone).token);
  claimFails(devices, one.secret, 400, phone, "wrong");
  claimFails(devices, one.code, 400, phone, "wrong");
  const two = devices.createCode();
  assert.ok(devices.claim(two.code, phone).token);
  claimFails(devices, two.secret, 400, phone, "wrong");
});

test("wrong codes: five a minute from one address, then 429 there for typed codes while other addresses still pair", () => {
  const devices = registry("per-address");
  const { code } = devices.createCode();
  for (let i = 0; i < 5; i += 1) claimFails(devices, "AAAA-AAAA", 400, phone, "wrong");
  claimFails(devices, code, 429, phone, "slow-down");
  assert.equal(devices.liveCodes(), 1, "a limited address does not burn the code");
  clock += 60_000;
  assert.ok(devices.claim(code, phone).token, "a minute later the address may try again");
});

test("a limited address (a shared proxy's) still pairs with the QR link's secret", () => {
  const devices = registry("per-address-link");
  const { secret } = devices.createCode();
  const proxy = { address: "127.0.0.1" };
  for (let i = 0; i < 5; i += 1) claimFails(devices, "AAAA-AAAA", 400, proxy);
  claimFails(devices, "BBBB-BBBB", 429, proxy, "slow-down");
  // Wrong secrets are not counted either: nothing to guess there.
  for (let i = 0; i < 30; i += 1) claimFails(devices, "Z".repeat(26), 400, proxy, "wrong");
  assert.ok(devices.claim(secret, proxy).token);
});

test("twenty wrong codes in ten minutes from anywhere stop typed codes; their QR links still work, and a new code can be typed", () => {
  const devices = registry("total");
  const one = devices.createCode();
  const two = devices.createCode();
  for (let i = 0; i < 19; i += 1) claimFails(devices, "AAAA-AAAA", 400, { address: `10.0.0.${i}` });
  claimFails(devices, "AAAA-AAAA", 429, { address: "10.0.1.1" }, "typing-stopped");
  claimFails(devices, one.code, 429, { address: "10.0.2.2" }, "typing-stopped");
  assert.equal(devices.liveCodes(), 2, "nothing is burned");
  assert.ok(devices.claim(one.secret, { address: "10.0.2.2" }).token, "the QR link still pairs");
  const fresh = devices.createCode().code;
  assert.ok(devices.claim(fresh, { address: "10.0.2.3" }).token, "a new code works");
  assert.ok(devices.claim(two.secret, { address: "10.0.2.4" }).token);
});

test("only the token's hash is stored (0600); the token authenticates, a changed one does not; lastSeen moves", () => {
  const devices = registry("hash");
  const { token, device } = devices.claim(devices.createCode().code, phone);
  const file = readFileSync(devices.file, "utf8");
  assert.ok(!file.includes(token) && !file.includes(token.split(".")[2]!), "the secret is not in the file");
  assert.equal(statSync(devices.file).mode & 0o777, 0o600);
  clock += 90_000;
  const seen = devices.authenticate(token);
  assert.equal(seen?.id, device.id);
  assert.equal(seen?.lastSeen, new Date(clock).toISOString());
  assert.equal(devices.authenticate(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`), null);
  assert.equal(devices.authenticate(`agxd1.${device.id}.x`), null);
  assert.equal(devices.authenticate("not-a-token"), null);
  // Another registry on the same file (a restarted daemon) knows the device.
  assert.equal(new DeviceRegistry({ env, now }).authenticate(token)?.id, device.id);
});

test("revoking a device (by id or a unique prefix) shuts its token out, in memory and on disk", () => {
  const devices = registry("revoke");
  const one = devices.claim(devices.createCode().code, phone);
  const two = devices.claim(devices.createCode().code, { address: "192.168.1.21", userAgent: "curl/8.7.1" });
  assert.equal(two.device.name, "curl");
  assert.equal(devices.revoke(""), null);
  assert.equal(devices.revoke("zzzz"), null);
  assert.ok(devices.has(one.device.id));
  assert.equal(devices.revoke(one.device.id.slice(0, 5))?.id, one.device.id);
  assert.equal(devices.has(one.device.id), false);
  assert.equal(devices.authenticate(one.token), null);
  assert.equal(new DeviceRegistry({ env, now }).authenticate(one.token), null);
  assert.equal(devices.authenticate(two.token)?.id, two.device.id);
  assert.deepEqual(
    devices.list().map((device) => device.id),
    [two.device.id],
  );
});

test("a push subscription is kept per device and never shown in the list", () => {
  const devices = registry("push");
  const { device } = devices.claim(devices.createCode().code, phone);
  const subscription = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } };
  assert.ok(devices.setPush(device.id, subscription));
  assert.equal(devices.list()[0]?.push, true);
  assert.ok(!JSON.stringify(devices.list()).includes("web.push.apple.com"));
  assert.deepEqual(devices.pushTargets()[0]?.subscription, subscription);
  devices.setPush(device.id, null);
  assert.equal(devices.pushTargets().length, 0);
  assert.equal(devices.setPush("nope", subscription), false);
});

test("a device is named from its User-Agent", () => {
  assert.equal(deviceName(undefined), "", "not recognised: each place names it in its own language");
  assert.equal(deviceName("SomethingElse/1.0"), "");
  assert.equal(deviceLabel({ name: "", id: "abc" }), "unknown browser (abc)");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36"), "Android · Chrome");
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1"), "iPhone · Chrome");
  assert.equal(deviceName("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "iPad · Safari");
  assert.equal(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0"), "Mac · Firefox");
  assert.equal(deviceName("curl/8.7.1"), "curl");
});
