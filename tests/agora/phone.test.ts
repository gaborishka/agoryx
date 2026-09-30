import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { trackAgentProcess } from "../../internal/agora/agentprocs.js";
import { AgoraDaemon, lanAddresses } from "../../internal/agora/daemon.js";
import { exposureFile, lanInterfaces, readExposure } from "../../internal/agora/exposure.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { writeFakeBins } from "./helpers.js";

// A phone on a real daemon (fake CLIs): pairing, the device's token, Host/Origin checks, revocation,
// agent processes, logs and Web Push. "The phone" reaches the daemon the way Tailscale serve does:
// from 127.0.0.1, under the tailnet's HTTPS host name.

const ece = createRequire(import.meta.url)("http_ece") as {
  decrypt: (body: Buffer, params: { version: string; privateKey: ReturnType<typeof createECDH>; authSecret: Buffer }) => Buffer;
};

const TS_HOST = "mac.tailnet-1234.ts.net";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

interface Sent {
  endpoint: string;
  body: Buffer;
}

let home: string;
let env: NodeJS.ProcessEnv;
let daemon: AgoraDaemon;
let port: number;
const logs: string[] = [];
const pushed: Sent[] = [];
let pushStatus = 201;

const call = (
  method: string,
  path: string,
  options: { host?: string; token?: string | null; cookie?: string; origin?: string; body?: unknown; ua?: string; to?: string; port?: number; headers?: Record<string, string> } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: options.to ?? "127.0.0.1",
        port: options.port ?? port,
        method,
        path,
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...(options.token === null ? {} : { "x-agoryx-token": options.token ?? daemon.token }),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.ua ? { "user-agent": options.ua } : {}),
          ...options.headers,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

/** The phone: through the tailnet name, with its cookie and no daemon token. */
const phone = (method: string, path: string, cookie: string | undefined, body?: unknown) =>
  call(method, path, { host: TS_HOST, token: null, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { body }), origin: `https://${TS_HOST}`, ua: IPHONE });

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
};

/** A code from the computer, traded by the phone: its cookie ("agoryx_token=…") and device. */
const pairPhone = async () => {
  const made = await call("POST", "/api/pair", { body: {} });
  assert.equal(made.status, 201, made.body);
  const { code } = made.json<{ code: string }>();
  const claimed = await phone("POST", "/api/pair/claim", undefined, { code });
  assert.equal(claimed.status, 201, claimed.body);
  const setCookie = String(claimed.headers["set-cookie"]);
  const cookie = setCookie.split(";")[0]!;
  return { code, claimed, setCookie, cookie, token: decodeURIComponent(cookie.split("=")[1]!), device: claimed.json<{ device: { id: string; name: string } }>().device };
};

const newRoom = async (name: string): Promise<string> => {
  const reply = await call("POST", "/api/rooms", { body: { name, agents: [{ id: "claude", kind: "claude", label: "Claude" }] } });
  assert.equal(reply.status, 201, reply.body);
  return reply.json<{ room: { id: string } }>().room.id;
};

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-phone-"));
  writeFakeBins(home);
  // The fake Claude answers the push test's message with a mention, so the room waits for the human.
  writeFileSync(join(home, "rules.json"), JSON.stringify([{ id: "claude", match: "push-me", reply: "@ivan all set", once: true }]));
  env = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_HUMAN: "Ivan",
    AGORYX_USER: "Ivan",
    AGORYX_JEV: "off",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  // Its own pages, so the test does not depend on whether ui/dist is built (without it the daemon serves web/).
  const webDir = join(home, "web");
  mkdirSync(webDir);
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Agoryx</title>");
  writeFileSync(join(webDir, "manifest.webmanifest"), JSON.stringify({ name: "Agoryx" }));
  daemon = new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    webDir,
    opsPollMs: 50,
    hosts: [TS_HOST],
    log: (line) => logs.push(line),
    pushFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      pushed.push({ endpoint: String(input), body: Buffer.from(init?.body as Uint8Array) });
      return new Response(null, { status: pushStatus });
    }) as typeof fetch,
    runners: { claude: createClaudeRunner(join(home, "fakebin", "fake-claude")), codex: createCodexRunner(join(home, "fakebin", "fake-codex")) },
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("Host: only this daemon's names; Origin: only its own pages", async () => {
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `${TS_HOST}.evil.example`]) {
    assert.equal((await call("GET", "/api/health", { host })).status, 421, host);
    assert.equal((await call("GET", "/", { host, token: null })).status, 421, host);
  }
  assert.equal((await call("GET", "/api/health", { host: `localhost:${port}` })).status, 200);
  assert.equal((await call("GET", "/api/health", { host: TS_HOST })).status, 200);
  const crossSite = await call("GET", "/api/info", { origin: "https://evil.example" });
  assert.equal(crossSite.status, 403, crossSite.body);
  assert.equal((await call("POST", "/api/pair/claim", { host: TS_HOST, token: null, origin: "http://evil.example", body: { code: "AAAA-AAAA" } })).status, 403);
  assert.equal((await call("GET", "/api/info", { origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await call("GET", "/api/info", { host: TS_HOST, token: null, origin: `https://${TS_HOST}` })).status, 401, "its own origin passes; the token is still needed");
});

test("off this computer the daemon's own token does not work, in the header, the URL or the login link", async () => {
  assert.equal((await call("GET", "/api/rooms", { host: TS_HOST })).status, 401);
  assert.equal((await call("GET", `/api/rooms?token=${daemon.token}`, { host: TS_HOST, token: null })).status, 401);
  assert.equal((await call("GET", `/?t=${daemon.token}`, { host: TS_HOST, token: null })).status, 401);
  assert.equal((await call("GET", "/api/rooms", { host: TS_HOST, token: null, cookie: `agoryx_token=${daemon.token}` })).status, 401);
  // The page itself (no secrets in it) loads, so the phone can show the pairing form.
  assert.equal((await call("GET", "/", { host: TS_HOST, token: null })).status, 200);
  assert.equal((await call("GET", "/manifest.webmanifest", { host: TS_HOST, token: null })).headers["content-type"], "application/manifest+json; charset=utf-8");
});

test("pairing needs the computer: the code is made there, the phone gets its own token as an HttpOnly cookie", async () => {
  // No daemon token: nothing to pair with.
  assert.equal((await call("POST", "/api/pair", { token: null, body: {} })).status, 401);
  const made = await call("POST", "/api/pair", { body: {} });
  assert.equal(made.status, 201, made.body);
  const pairing = made.json<{ code: string; links: Array<{ url: string; base: string; kind: string; qr: string }> }>();
  assert.match(pairing.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.equal(pairing.links[0]?.kind, "https");
  // The link carries the long secret, not the code to type.
  assert.match(pairing.links[0]!.url, new RegExp(`^https://${TS_HOST.replace(/\./g, "\\.")}/\\?pair=[2-9A-HJKMNP-Z]{26}$`));
  assert.ok(!pairing.links[0]!.url.includes(pairing.code.replace("-", "")));
  assert.match(pairing.links[0]!.qr, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(pairing.links[0]!.qr.split(",")[1]!, "base64").toString("utf8"), /^<svg /);

  assert.equal((await phone("GET", "/api/pair/claim", undefined)).status, 405);
  const wrong = await phone("POST", "/api/pair/claim", undefined, { code: "2222-2222" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.headers["set-cookie"], undefined);

  const claimed = await phone("POST", "/api/pair/claim", undefined, { code: pairing.code.toLowerCase() });
  assert.equal(claimed.status, 201, claimed.body);
  const setCookie = String(claimed.headers["set-cookie"]);
  assert.match(setCookie, /^agoryx_token=agxd1\./);
  for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"]) assert.ok(setCookie.includes(flag), `${flag} in ${setCookie}`);
  assert.ok(!claimed.body.includes("agxd1"), "the token is in the cookie only");
  assert.equal(claimed.json<{ device: { name: string } }>().device.name, "iPhone · Safari");
  assert.equal((await phone("POST", "/api/pair/claim", undefined, { code: pairing.code })).status, 400, "a code works once");
});

test("a paired phone uses rooms as the human, but cannot pair, list or revoke devices, stop the daemon or host the browser", async () => {
  const room = await newRoom("phone room");
  const { cookie, device } = await pairPhone();
  const info = await phone("GET", "/api/info", cookie);
  assert.equal(info.status, 200, info.body);
  assert.deepEqual(info.json<{ device: unknown }>().device, { id: device.id, name: device.name });
  const rooms = await phone("GET", "/api/rooms", cookie);
  assert.equal(rooms.status, 200);
  assert.ok(rooms.json<{ rooms: Array<{ id: string }> }>().rooms.some((entry) => entry.id === room));
  const snapshot = await phone("GET", `/api/rooms/${room}`, cookie);
  assert.equal(snapshot.status, 200, snapshot.body);
  assert.equal(snapshot.json<{ state: { name: string } }>().state.name, "phone room");
  assert.equal((await call("GET", "/api/info")).json<{ device: unknown }>().device, null, "the computer is no device");

  assert.equal((await phone("POST", "/api/pair", cookie, {})).status, 403);
  assert.equal((await phone("GET", "/api/devices", cookie)).status, 403);
  assert.equal((await phone("DELETE", `/api/devices/${device.id}`, cookie)).status, 403);
  assert.equal((await phone("POST", "/api/down", cookie, {})).status, 403);
  assert.equal((await phone("POST", "/api/browser/host", cookie, {})).status, 403);

  // An agent's key cannot pair either, and works on this computer only.
  const key = agentKey(daemon.token, room, "claude");
  assert.equal((await call("POST", "/api/pair", { token: key, body: {} })).status, 403);
  assert.equal((await call("GET", "/api/devices", { token: key })).status, 403);
  assert.equal((await call("GET", "/api/rooms", { host: TS_HOST, token: key })).status, 401);
});

test("the computer lists the paired devices (no secrets) and revokes one: its token is out and its live streams end", async () => {
  const room = await newRoom("revoke room");
  const { cookie, token, device } = await pairPhone();
  const listed = await call("GET", "/api/devices");
  assert.equal(listed.status, 200);
  const body = listed.json<{ devices: Array<{ id: string }>; reach: Array<{ url: string; kind: string }> }>();
  assert.ok(body.devices.some((entry) => entry.id === device.id));
  assert.deepEqual(body.reach, [{ url: `https://${TS_HOST}`, kind: "https" }]);
  assert.ok(!listed.body.includes(token) && !listed.body.includes("hash"), listed.body);

  // A live event stream the phone holds.
  const stream = await new Promise<{ ended: Promise<void> }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: `/api/rooms/${room}/events?after=0`, headers: { host: TS_HOST, cookie } },
      (res) => {
        assert.equal(res.statusCode, 200);
        res.resume();
        resolve({ ended: new Promise<void>((done) => res.on("close", () => done())) });
      },
    );
    req.on("error", reject);
    req.end();
  });

  const revoked = await call("DELETE", `/api/devices/${device.id}`);
  assert.equal(revoked.status, 200, revoked.body);
  await Promise.race([stream.ended, new Promise((_, reject) => setTimeout(() => reject(new Error("the stream did not end")), 5000))]);
  const out = await phone("GET", "/api/rooms", cookie);
  assert.equal(out.status, 401);
  assert.match(out.json<{ error: string }>().error, /not paired/);
  assert.equal((await phone("GET", `/api/rooms/${room}`, cookie)).status, 401);
  assert.equal((await call("DELETE", `/api/devices/${device.id}`)).status, 404);
});

test("pairing is refused where no phone can reach the daemon", async () => {
  const lonely = new AgoraDaemon({ env: { ...env, AGORYX_HOME: join(home, "lonely") }, port: 0, advertise: false });
  const lonelyPort = (await lonely.start()).port;
  try {
    const reply = await call("POST", "/api/pair", { port: lonelyPort, host: `127.0.0.1:${lonelyPort}`, token: lonely.token, body: {} });
    assert.equal(reply.status, 409);
    assert.match(reply.json<{ error: string }>().error, /--lan/);
  } finally {
    await lonely.close();
  }
});

test("--lan: the daemon also answers on this computer's LAN address, where only a paired device gets in", { skip: lanAddresses().length === 0 && "no private IPv4 address here" }, async (t) => {
  const lan = new AgoraDaemon({ env: { ...env, AGORYX_HOME: join(home, "lan") }, port: 0, advertise: false, lan: true });
  const lanPort = (await lan.start()).port;
  const address = lanAddresses()[0]!;
  const at = { to: address, port: lanPort, host: `${address}:${lanPort}` };
  try {
    assert.ok(lan.reachUrls().some((entry) => entry.url === `http://${address}:${lanPort}` && entry.kind === "lan"));
    // A sandbox (or a firewall) may refuse connections to the LAN address even from this computer.
    const health = await call("GET", "/api/health", { ...at }).catch((error: unknown) => error as Error);
    if (health instanceof Error) {
      t.skip(`connections to ${address} are refused here (${health.message})`);
      return;
    }
    assert.equal(health.status, 200);
    assert.equal((await call("GET", "/api/rooms", { ...at, token: lan.token })).status, 401, "the daemon's token only on loopback");
    // A loopback Host name over the LAN socket is still off this computer's loopback.
    assert.equal((await call("GET", "/api/rooms", { ...at, host: `127.0.0.1:${lanPort}`, token: lan.token })).status, 401);
    assert.equal((await call("GET", "/api/health", { ...at, host: `evil.example:${lanPort}` })).status, 421);
    const made = await call("POST", "/api/pair", { port: lanPort, host: `127.0.0.1:${lanPort}`, token: lan.token, body: {} });
    assert.equal(made.status, 201, made.body);
    const { code, links } = made.json<{ code: string; links: Array<{ url: string; kind: string }> }>();
    assert.match(links[0]!.url, new RegExp(`^http://${address.replace(/\./g, "\\.")}:${lanPort}/\\?pair=[2-9A-HJKMNP-Z]{26}$`));
    const claimed = await call("POST", "/api/pair/claim", { ...at, token: null, ua: "curl/8.7.1", body: { code } });
    assert.equal(claimed.status, 201, claimed.body);
    const setCookie = String(claimed.headers["set-cookie"]);
    assert.ok(!setCookie.includes("Secure"), "plain http on the LAN: a Secure cookie would not be kept");
    assert.equal((await call("GET", "/api/rooms", { ...at, token: null, cookie: setCookie.split(";")[0]! })).status, 200);
  } finally {
    await lan.close();
  }
});

test("--lan on a running daemon: it starts listening on the LAN address on its own port without a restart, and stops again", { skip: lanAddresses().length === 0 && "no Wi-Fi or Ethernet address here" }, async () => {
  const later = new AgoraDaemon({ env: { ...env, AGORYX_HOME: join(home, "later") }, port: 0, advertise: false });
  const laterPort = (await later.start()).port;
  const address = lanAddresses()[0]!;
  try {
    assert.deepEqual(later.reachUrls(), []);
    const on = await call("POST", "/api/exposure", { port: laterPort, host: `127.0.0.1:${laterPort}`, token: later.token, body: { lan: true } });
    assert.equal(on.status, 200, on.body);
    assert.deepEqual(on.json<{ addresses: string[] }>().addresses, lanAddresses());
    assert.ok(later.reachUrls().some((entry) => entry.url === `http://${address}:${laterPort}`));
    assert.equal((await call("GET", "/api/health", { port: laterPort, host: `${address}:${laterPort}` })).status, 200, "its LAN Host is accepted");
    assert.deepEqual(readExposure({ ...env, AGORYX_HOME: join(home, "later") }), { lan: true, hosts: [] });
    const off = await call("POST", "/api/exposure", { port: laterPort, host: `127.0.0.1:${laterPort}`, token: later.token, body: { lan: false } });
    assert.deepEqual(off.json(), { lan: false, hosts: [], addresses: [] });
    assert.equal((await call("GET", "/api/health", { port: laterPort, host: `${address}:${laterPort}` })).status, 421);
  } finally {
    await later.close();
  }
});

test("Web Push: a device subscribes (https endpoints only), gets a test and a push when a room starts waiting; a gone subscription is dropped", async () => {
  const { cookie, device } = await pairPhone();
  const keyed = await phone("GET", "/api/push", cookie);
  assert.equal(keyed.status, 200);
  const { publicKey, subscribed } = keyed.json<{ publicKey: string; subscribed: boolean }>();
  assert.match(publicKey, /^[\w-]{80,}$/);
  assert.equal(subscribed, false);
  assert.equal((await call("GET", "/api/push")).json<{ publicKey: unknown }>().publicKey, null, "the computer has the app's own notifications");

  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const authSecret = randomBytes(16);
  const subscription = { endpoint: "https://push.example/send/abc123", keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } };
  assert.equal((await phone("POST", "/api/push", cookie, { subscription: { ...subscription, endpoint: "http://push.example/send/abc123" } })).status, 400);
  assert.equal((await phone("POST", "/api/push", cookie, { subscription: { endpoint: "https://push.example/x", keys: {} } })).status, 400);
  assert.equal((await call("POST", "/api/push", { body: { subscription } })).status, 403, "only a paired device subscribes");
  const on = await phone("POST", "/api/push", cookie, { subscription });
  assert.equal(on.status, 200, on.body);
  assert.equal((await phone("GET", "/api/push", cookie)).json<{ subscribed: boolean }>().subscribed, true);

  // A push carries only an id; the phone's service worker asks the daemon what it says.
  const decrypt = (sent: Sent) => JSON.parse(ece.decrypt(sent.body, { version: "aes128gcm", privateKey: receiver, authSecret }).toString("utf8")) as Record<string, string>;
  const notes = new Map<string, Record<string, string | null>>();
  const open = async (sent: Sent) => {
    const { id, ...rest } = decrypt(sent);
    assert.deepEqual(rest, {}, "nothing but the id in the push");
    if (!notes.has(id!)) {
      const reply = await phone("GET", `/api/push/note/${id}`, cookie);
      assert.equal(reply.status, 200, reply.body);
      notes.set(id!, reply.json());
    }
    return notes.get(id!)!;
  };
  pushed.length = 0;
  const tested = await phone("POST", "/api/push/test", cookie, {});
  assert.deepEqual(tested.json(), { sent: 1, failed: 0 });
  assert.equal(pushed[0]?.endpoint, subscription.endpoint);
  assert.equal((await open(pushed[0]!)).body, "Сповіщення працюють.");
  // A push the daemon did not send (anyone holding vapid.json and devices.json can push) has no note.
  assert.equal((await phone("GET", "/api/push/note/forged-id-1234", cookie)).status, 404);
  const other = await pairPhone();
  assert.equal((await phone("GET", `/api/push/note/${decrypt(pushed[0]!).id}`, other.cookie)).status, 404, "a note is for its own device");
  assert.equal((await call("GET", `/api/push/note/${decrypt(pushed[0]!).id}`)).status, 403);

  // A room's run ends: it waits for the human, and the phone is told which room.
  pushed.length = 0;
  const room = await newRoom("waiting room");
  const posted = await call("POST", `/api/rooms/${room}/messages`, { body: { text: "push-me" } });
  assert.equal(posted.status, 201, posted.body);
  const forRoom = async () => {
    for (const sent of [...pushed]) if ((await open(sent)).room === room) return (await open(sent)) as Record<string, string>;
    return null;
  };
  await waitFor(async () => (await forRoom()) !== null);
  const note = (await forRoom())!;
  assert.equal(note.tag, `room-${room}`);
  assert.ok(note.title!.includes("waiting room"), JSON.stringify(note));

  // The push service says the subscription is gone: it is dropped.
  pushStatus = 410;
  try {
    const gone = await phone("POST", "/api/push/test", cookie, {});
    assert.deepEqual(gone.json(), { sent: 0, failed: 1 });
    assert.equal(daemon.devices.pushTargets().some((target) => target.device.id === device.id), false);
  } finally {
    pushStatus = 201;
  }
  assert.ok(!logs.some((line) => line.includes("push.example")), "push endpoints are not logged");
});

test("an agent's process cannot pair (claim a code) nor use a paired device's token", async () => {
  const { token } = await pairPhone();
  const made = await call("POST", "/api/pair", { body: {} });
  const { code } = made.json<{ code: string }>();
  // A process tracked as an agent's (as the daemon tracks the CLIs it starts) makes the requests itself.
  const script = `
    const http = require("node:http");
    const ask = (path, headers, body) => new Promise((done) => {
      const req = http.request({ host: "127.0.0.1", port: ${port}, method: body ? "POST" : "GET", path, headers: { host: ${JSON.stringify(TS_HOST)}, ...headers, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => { res.resume(); res.on("end", () => done(res.statusCode)); });
      req.end(body);
    });
    process.stdin.once("data", async () => {
      const claim = await ask("/api/pair/claim", {}, JSON.stringify({ code: ${JSON.stringify(code)} }));
      const rooms = await ask("/api/rooms", { cookie: "agoryx_token=" + encodeURIComponent(process.env.DEVICE_TOKEN) });
      process.stdout.write(JSON.stringify({ claim, rooms }));
      process.exit(0);
    });
  `;
  const agent = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, DEVICE_TOKEN: token } });
  trackAgentProcess(agent.pid, { AGORYX_ROOM: "room-x", AGORYX_AGENT: "claude" });
  let out = "";
  agent.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const exited = new Promise<void>((done) => agent.on("exit", () => done()));
  agent.stdin!.write("go\n");
  await exited;
  assert.deepEqual(JSON.parse(out), { claim: 403, rooms: 403 });
  // The code was not used up by the refused claim; the human's phone still can.
  assert.equal((await phone("POST", "/api/pair/claim", undefined, { code })).status, 201);
});

test("/raw/: a paired device gets a key of its own that dies when it is revoked; the computer's key works on the computer only", async () => {
  const room = await newRoom("raw room");
  const local = (await call("GET", `/api/rooms/${room}`)).json<{ rawBase: string; state: { workspace: string } }>();
  writeFileSync(join(local.state.workspace, "secret.env"), "SECRET=hunter2\n");
  assert.match(local.rawBase, /^\/raw\/[^/]+\/[0-9a-f]{32}\/$/);
  assert.equal((await call("GET", `${local.rawBase}secret.env`, { token: null })).status, 200);
  assert.equal((await call("GET", `${local.rawBase}secret.env`, { host: TS_HOST, token: null })).status, 404, "the computer's key off the computer");

  const { cookie, device } = await pairPhone();
  const mine = (await phone("GET", `/api/rooms/${room}`, cookie)).json<{ rawBase: string }>().rawBase;
  assert.ok(mine.includes(`/${device.id}.`), mine);
  assert.notEqual(mine, local.rawBase);
  const file = await call("GET", `${mine}secret.env`, { host: TS_HOST, token: null });
  assert.equal(file.status, 200, "sandboxed previews load it without the cookie");
  assert.equal(file.body, "SECRET=hunter2\n");
  const forged = mine.replace(/\/([0-9a-f]+)\./, "/000000000000.");
  assert.equal((await call("GET", `${forged}secret.env`, { host: TS_HOST, token: null })).status, 404);

  assert.equal((await call("DELETE", `/api/devices/${device.id}`)).status, 200);
  assert.equal((await call("GET", `${mine}secret.env`, { host: TS_HOST, token: null })).status, 404, "revoked: its key is dead");
  assert.equal((await call("GET", `${mine}secret.env`, { token: null })).status, 404, "on the computer too");
});

test("behind Tailscale serve (every request from 127.0.0.1) wrong codes are counted per forwarded client, so a guesser does not lock the phone out", async () => {
  const made = await call("POST", "/api/pair", { body: {} });
  const { code, links } = made.json<{ code: string; links: Array<{ url: string }> }>();
  const guesser = { "x-forwarded-for": "100.64.0.66" };
  for (let i = 0; i < 5; i += 1) {
    const wrong = await call("POST", "/api/pair/claim", { host: TS_HOST, token: null, headers: guesser, body: { code: "ZZZZ-ZZZZ" } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json<{ reason: string }>().reason, "wrong");
  }
  const limited = await call("POST", "/api/pair/claim", { host: TS_HOST, token: null, headers: guesser, body: { code } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json<{ reason: string }>().reason, "slow-down");
  // A client cannot pick its own address: the proxy's entry is the last one.
  const spoofed = await call("POST", "/api/pair/claim", { host: TS_HOST, token: null, headers: { "x-forwarded-for": "1.2.3.4, 100.64.0.66" }, body: { code } });
  assert.equal(spoofed.status, 429);
  // The phone, another tailnet address, types the code.
  const typed = await call("POST", "/api/pair/claim", { host: TS_HOST, token: null, headers: { "x-forwarded-for": "100.64.0.7" }, ua: IPHONE, body: { code } });
  assert.equal(typed.status, 201, typed.body);
  // And a limited address still pairs with a scanned link.
  const again = (await call("POST", "/api/pair", { body: {} })).json<{ links: Array<{ url: string }> }>();
  const secret = new URL(again.links[0]!.url).searchParams.get("pair")!;
  assert.ok(links[0]!.url !== again.links[0]!.url);
  const scanned = await call("POST", "/api/pair/claim", { host: TS_HOST, token: null, headers: guesser, ua: IPHONE, body: { code: secret } });
  assert.equal(scanned.status, 201, scanned.body);
});

test("exposure: the human changes it on the running daemon (no restart) and it is saved; an agent or a paired device cannot", async () => {
  const { cookie } = await pairPhone();
  const room = await newRoom("exposure room");
  const key = agentKey(daemon.token, room, "claude");
  assert.deepEqual((await call("GET", "/api/exposure")).json(), { lan: false, hosts: [TS_HOST], addresses: [] });
  assert.equal((await call("POST", "/api/exposure", { token: key, body: { lan: true } })).status, 403);
  assert.equal((await phone("POST", "/api/exposure", cookie, { lan: false, hosts: [] })).status, 403);
  assert.equal((await call("POST", "/api/exposure", { body: { lan: "yes" } })).status, 400);
  assert.equal((await call("POST", "/api/exposure", { body: { lan: false, hosts: ["evil.example/x"] } })).status, 400);
  try {
    const moved = await call("POST", "/api/exposure", { body: { lan: false, hosts: ["other.tailnet-1234.ts.net"] } });
    assert.equal(moved.status, 200, moved.body);
    assert.equal((await call("GET", "/api/health", { host: TS_HOST })).status, 421, "the old name is refused at once");
    assert.equal((await call("GET", "/api/health", { host: "other.tailnet-1234.ts.net" })).status, 200);
    assert.deepEqual(readExposure(env), { lan: false, hosts: ["other.tailnet-1234.ts.net"] });
    const closed = await call("POST", "/api/exposure", { body: { lan: false, hosts: [] } });
    assert.deepEqual(closed.json(), { lan: false, hosts: [], addresses: [] });
    assert.equal(existsSync(exposureFile(env)), false, "local only: nothing saved");
    assert.equal((await call("POST", "/api/pair", { body: {} })).status, 409);
  } finally {
    await call("POST", "/api/exposure", { body: { lan: false, hosts: [TS_HOST] } });
  }
  assert.equal((await call("GET", "/api/health", { host: TS_HOST })).status, 200);
  assert.ok(readFileSync(exposureFile(env), "utf8").includes(TS_HOST));
});

test("--lan listens on Wi-Fi and Ethernet only: not on VPN tunnels, VM or container bridges", () => {
  const entry = (address: string) => ({ address, family: "IPv4" as const, internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` });
  const interfaces = {
    lo0: [{ ...entry("127.0.0.1"), internal: true }],
    en0: [entry("192.168.0.192")],
    en5: [entry("10.1.2.3")],
    utun4: [entry("10.20.30.40")],
    bridge100: [entry("192.168.64.1")],
    vmnet8: [entry("172.16.5.1")],
    en1: [entry("8.8.8.8")],
  };
  assert.deepEqual(lanInterfaces(interfaces, "darwin"), [
    { address: "192.168.0.192", iface: "en0" },
    { address: "10.1.2.3", iface: "en5" },
  ]);
  const linux = { eth0: [entry("192.168.1.5")], wlp2s0: [entry("192.168.1.6")], docker0: [entry("172.17.0.1")], tun0: [entry("10.8.0.2")], tailscale0: [entry("100.64.0.1")] };
  assert.deepEqual(
    lanInterfaces(linux, "linux").map((found) => found.iface),
    ["eth0", "wlp2s0"],
  );
});

test("no token and no pairing code reaches the daemon's log", () => {
  assert.ok(logs.some((line) => line.startsWith("paired a device: iPhone · Safari")), logs.join("\n"));
  assert.ok(logs.some((line) => line.startsWith("made a pairing code")), logs.join("\n"));
  const text = logs.join("\n");
  assert.ok(!text.includes(daemon.token));
  assert.ok(!/agxd1\./.test(text), "no device token");
  assert.ok(!/pair=/.test(text), "no pairing link");
  assert.ok(!/[2-9A-HJKMNP-Z]{26}/.test(text), "no link secret");
  assert.ok(!/\b[2-9A-HJKMNP-Z]{4}-?[2-9A-HJKMNP-Z]{4}\b/.test(text.replace(/[0-9a-f]{12}/g, "")), `no pairing code in:\n${text}`);
});
