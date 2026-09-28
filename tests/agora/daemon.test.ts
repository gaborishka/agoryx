import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { blockHash } from "../../internal/agora/blocks.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { writeFakeBins } from "./helpers.js";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

let home: string;
let daemon: AgoraDaemon;
let port: number;

const call = (
  method: string,
  path: string,
  options: { token?: string | null; host?: string; origin?: string; body?: unknown } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const token = options.token === undefined ? daemon.token : options.token;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...(token ? { "x-agoryx-token": token } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
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

/** Reads SSE frames until `until` matches one, then closes. */
const readEvents = (path: string, until: (frame: { event: string; data: any }) => boolean, ms = 10_000) =>
  new Promise<Array<{ event: string; data: any }>>((resolve, reject) => {
    const frames: Array<{ event: string; data: any }> = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`no matching SSE frame within ${ms}ms (got ${frames.map((f) => f.event).join(",")})`));
    }, ms);
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, "x-agoryx-token": daemon.token } },
      (res) => {
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.*)$/m.exec(raw)?.[1];
            const data = /^data: (.*)$/m.exec(raw)?.[1];
            if (!event || !data) continue;
            const frame = { event, data: JSON.parse(data) };
            frames.push(frame);
            if (until(frame)) {
              clearTimeout(timer);
              req.destroy();
              resolve(frames);
              return;
            }
          }
        });
      },
    );
    req.on("error", (error) => {
      if (!frames.length) reject(error);
    });
    req.end();
  });

const waitFor = async (check: () => Promise<boolean>, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition not met in time");
};

const newRoom = async (name: string, extra: Record<string, unknown> = {}) => {
  const reply = await call("POST", "/api/rooms", { body: { name, ...extra } });
  assert.equal(reply.status, 201, reply.body);
  return reply.json<{ room: { id: string; workspace: string } }>().room;
};

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-daemon-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  writeFileSync(join(home, "rules.json"), "[]");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_USER: "Ivan",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  daemon = new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    opsPollMs: 50,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("the API needs the token; health does not", async () => {
  assert.equal((await call("GET", "/api/health", { token: null })).status, 200);
  assert.equal((await call("GET", "/api/rooms", { token: null })).status, 401);
  assert.equal((await call("GET", "/api/rooms", { token: "nope" })).status, 401);
  assert.equal((await call("GET", "/api/rooms")).status, 200);
});

test("DNS rebinding and cross-origin writes are refused", async () => {
  assert.equal((await call("GET", "/api/rooms", { host: "evil.example:80" })).status, 421);
  assert.equal((await call("GET", "/api/health", { host: `attacker.test:${port}` })).status, 421);
  const refused = await call("POST", "/api/rooms", { origin: "https://evil.example", body: { name: "x" } });
  assert.equal(refused.status, 403);
  const opaque = await call("POST", "/api/rooms", { origin: "null", body: { name: "x" } });
  assert.equal(opaque.status, 403);
  assert.equal((await call("GET", "/api/rooms", { host: `localhost:${port}` })).status, 200);
});

test("the ?t= login sets a strict HttpOnly cookie that then authorises the API", async () => {
  assert.equal((await call("GET", "/?t=wrong", { token: null })).status, 401);
  const login = await call("GET", `/?t=${daemon.token}`, { token: null });
  assert.equal(login.status, 302);
  const cookie = String(login.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const pair = cookie.split(";")[0]!;
  const withCookie = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/rooms", headers: { host: `127.0.0.1:${port}`, cookie: pair } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(withCookie, 200);
});

test("a message wakes both agents; SSE carries patches; the snapshot has the conversation", async () => {
  const room = await newRoom("Daemon talk");
  const done = readEvents(
    `/api/rooms/${room.id}/events?after=0`,
    (frame) => frame.event === "room" && frame.data.event.type === "run.ended",
  );
  const posted = await call("POST", `/api/rooms/${room.id}/messages`, { body: { text: "Hello both" } });
  assert.equal(posted.status, 201);
  const frames = await done;
  const types = frames.filter((f) => f.event === "room").map((f) => f.data.event.type);
  assert.ok(types.includes("message.posted"));
  assert.ok(types.includes("turn.started"));
  const message = frames.find((f) => f.event === "room" && f.data.event.type === "message.posted");
  assert.ok(message!.data.patch.message, "message.posted carries a message patch");
  const presence = frames.filter((f) => f.event === "presence").map((f) => f.data.agents);
  assert.deepEqual(presence[0], { claude: "idle", codex: "idle" }, "the stream opens with who is busy now");
  assert.ok(presence.some((agents) => agents.claude === "working"), "turn starts reach the stream as presence");

  const snap = (await call("GET", `/api/rooms/${room.id}`)).json<any>();
  const texts = snap.state.messages.map((m: any) => `${m.author}:${m.kind}:${m.text}`);
  assert.ok(texts.includes("Ivan:human:Hello both"));
  assert.ok(texts.includes("claude:agent:claude here"));
  assert.ok(texts.includes("codex:agent:codex here"));
  assert.equal(snap.driven, true);
  assert.match(snap.rawBase, new RegExp(`^/raw/${room.id}/[0-9a-f]{32}/$`));
  assert.match(snap.resume.claude, /--resume/);
  assert.match(snap.resume.codex, /resume/);
});

test("a client that subscribes mid-turn gets the text already streamed since its snapshot", async () => {
  writeFileSync(join(home, "rules.json"), JSON.stringify([{ agent: "claude", match: "Stream slowly", reply: "a long streamed answer", streamSleepMs: 2500 }]));
  try {
    const room = await newRoom("Late subscriber");
    await call("POST", `/api/rooms/${room.id}/messages`, { body: { text: "Stream slowly" } });
    let seq = 0;
    await waitFor(async () => {
      const snap = (await call("GET", `/api/rooms/${room.id}`)).json<any>();
      seq = snap.state.seq;
      return Object.values(snap.streams).some((s: any) => s.text === "a long streamed answer");
    });
    const frames = await readEvents(`/api/rooms/${room.id}/events?after=${seq}`, (frame) => frame.event === "stream");
    const stream = frames.find((f) => f.event === "stream")!.data;
    assert.equal(stream.reset, true);
    assert.equal(stream.text, "a long streamed answer");
  } finally {
    writeFileSync(join(home, "rules.json"), "[]");
  }
});

test("table ops from the human land in the snapshot; bad ops are 400", async () => {
  const room = await newRoom("Daemon table");
  const asked = await call("POST", `/api/rooms/${room.id}/table`, { body: { op: "ask", text: "Which storage?" } });
  assert.equal(asked.status, 201, asked.body);
  assert.match(asked.json<{ text: string }>().text, /^Q1 · /);
  const bad = await call("POST", `/api/rooms/${room.id}/table`, { body: { op: "decide", target: "P9" } });
  assert.equal(bad.status, 400);
  await waitFor(async () => (await call("GET", `/api/rooms/${room.id}`)).json<any>().state.runs.at(-1)?.status === "ended");
  const snap = (await call("GET", `/api/rooms/${room.id}`)).json<any>();
  assert.equal(snap.state.table.questions[0].text, "Which storage?");
  assert.equal(snap.ops[0].op.op, "ask");
  assert.equal(snap.ops[0].op.by, "Ivan");
});

test("settings are validated; an unknown action is 404", async () => {
  const room = await newRoom("Daemon settings");
  const changed = await call("POST", `/api/rooms/${room.id}/settings`, { body: { budget: 4, access: "root" } });
  assert.equal(changed.status, 200);
  const settings = changed.json<{ settings: Record<string, unknown> }>().settings;
  assert.equal(settings.budget, 4);
  assert.notEqual(settings.access, "root");
  assert.equal((await call("POST", `/api/rooms/${room.id}/explode`, { body: {} })).status, 404);
  assert.equal((await call("GET", "/api/rooms/no-such-room")).status, 404);
});

test("a room can start from its first message alone, and be renamed later", async () => {
  const created = await call("POST", "/api/rooms", { body: { text: "@codex Порівняй SQLite і JSONL для журналу подій, будь ласка, з цифрами" } });
  assert.equal(created.status, 201, created.body);
  const room = created.json<{ room: { id: string; name: string } }>().room;
  assert.equal(room.name, "Порівняй SQLite і JSONL для журналу подій, будь ласка, з…");
  await waitFor(async () => (await call("GET", `/api/rooms/${room.id}`)).json<any>().state.runs.at(-1)?.status === "ended");
  assert.equal((await call("POST", "/api/rooms", { body: {} })).status, 400);
  for (const bad of [{ budget: 0 }, { budget: 2.5 }, { budget: 1000 }, { human: "@Claude" }, { human: " @ " }]) {
    const refused = await call("POST", "/api/rooms", { body: { name: "Refused", ...bad } });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }

  const renamed = await call("POST", `/api/rooms/${room.id}/rename`, { body: { name: "  Журнал подій  " } });
  assert.equal(renamed.status, 200, renamed.body);
  assert.equal(renamed.json<{ room: { name: string } }>().room.name, "Журнал подій");
  const snap = (await call("GET", `/api/rooms/${room.id}`)).json<any>();
  assert.equal(snap.state.name, "Журнал подій");
  assert.equal(snap.state.runs.length, 1, "a rename wakes nobody");
  assert.equal((await call("POST", `/api/rooms/${room.id}/rename`, { body: { name: " " } })).status, 400);
});

test("the canonical file: read it, edit it against a base, see each revision's diff", async () => {
  const room = await newRoom("Daemon doc");
  const first = await call("GET", `/api/rooms/${room.id}/doc`);
  assert.equal(first.status, 200, first.body);
  const doc = first.json<{ path: string; text: string; hash: string; exists: boolean }>();
  assert.deepEqual([doc.path, doc.text, doc.exists], ["README.md", "# Daemon doc\n", true]);

  const saved = await call("POST", `/api/rooms/${room.id}/doc`, { body: { text: "# Daemon doc\n\nA line.\n", base: doc.hash } });
  assert.equal(saved.status, 200, saved.body);
  const { revision } = saved.json<{ revision: { seq: number; by: string; added: number } }>();
  assert.deepEqual([revision.by, revision.added], ["Ivan", 2]);

  const stale = await call("POST", `/api/rooms/${room.id}/doc`, { body: { text: "overwrite", base: doc.hash } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json<{ current: { text: string } }>().current.text, "# Daemon doc\n\nA line.\n");
  assert.equal((await call("POST", `/api/rooms/${room.id}/doc`, { body: { text: 1 } })).status, 400);

  const rev = (await call("GET", `/api/rooms/${room.id}/doc?rev=${revision.seq}`)).json<any>();
  assert.equal(rev.text, "# Daemon doc\n\nA line.\n");
  assert.deepEqual(
    rev.diff.filter((item: any) => item.t && item.t !== " "),
    [
      { t: "+", s: "" },
      { t: "+", s: "A line." },
    ],
  );
  const snap = (await call("GET", `/api/rooms/${room.id}`)).json<any>();
  assert.deepEqual(
    snap.state.docRevisions.map((entry: any) => entry.by),
    ["agoryx", "Ivan"],
  );
  assert.equal(snap.state.runs.length, 0, "an edit wakes nobody");

  const bare = await newRoom("Daemon no doc", { doc: "" });
  assert.equal((await call("GET", `/api/rooms/${bare.id}/doc`)).status, 404);
  const none = await newRoom("Daemon null doc", { doc: null });
  assert.equal((await call("GET", `/api/rooms/${none.id}/doc`)).status, 404, "null (agoryx new --doc none) means no canonical file");
  assert.equal((await call("POST", "/api/rooms", { body: { name: "Bad doc", doc: "../up.md" } })).status, 400);
});

test("a turn's exact change: counts in the snapshot, the patch on request", async () => {
  writeFileSync(
    join(home, "rules.json"),
    JSON.stringify([{ agent: "claude", match: "clock", write: { path: "clock.ts", content: "export const t = 0;\n" }, reply: "Wrote clock.ts.", once: true }]),
  );
  try {
    const room = await newRoom("Daemon changes");
    await call("POST", `/api/rooms/${room.id}/messages`, { body: { text: "@claude write the clock" } });
    let turn: any;
    await waitFor(async () => {
      const snap = (await call("GET", `/api/rooms/${room.id}`)).json<any>();
      turn = snap.state.turns.find((entry: any) => entry.changes?.length);
      return Boolean(turn) && snap.state.runs.at(-1)?.status === "ended";
    });
    assert.deepEqual(turn.changes, [{ path: "clock.ts", status: "A", added: 1, removed: 0 }]);
    const reply = await call("GET", `/api/rooms/${room.id}/turn-diff?turn=${turn.id}`);
    assert.equal(reply.status, 200, reply.body);
    const body = reply.json<any>();
    assert.equal(body.agent, "claude");
    assert.match(body.patch, /^diff --git a\/clock\.ts b\/clock\.ts\n[^]*\+export const t = 0;/);
    assert.equal(body.truncated, false);
    assert.equal((await call("GET", `/api/rooms/${room.id}/turn-diff?turn=t999`)).status, 404);
    assert.equal((await call("GET", `/api/rooms/${room.id}/turn-diff?turn=../x`)).status, 400);
  } finally {
    writeFileSync(join(home, "rules.json"), "[]");
  }
});

test("/raw/ serves workspace files under a sandbox CSP and refuses bad keys, .git and symlink escapes", async () => {
  const room = await newRoom("Daemon raw");
  const snap = (await call("GET", `/api/rooms/${room.id}`)).json<{ rawBase: string }>();
  mkdirSync(join(room.workspace, "site"), { recursive: true });
  writeFileSync(join(room.workspace, "site", "index.html"), "<h1>hi</h1>");
  const outside = mkdtempSync(join(tmpdir(), "agora-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(room.workspace, "escape"));
  try {
    const page = await call("GET", `${snap.rawBase}site/`, { token: null });
    assert.equal(page.status, 200);
    assert.ok(page.body.startsWith("<h1>hi</h1>"), "the file itself comes first");
    assert.match(page.body, /agoryxFrame/, "html gets the height reporter the page uses to size live frames");
    assert.match(String(page.headers["content-security-policy"]), /^sandbox allow-scripts/);
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'self'/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");

    const wrongKey = snap.rawBase.replace(/[0-9a-f]{32}/, "0".repeat(32));
    assert.equal((await call("GET", `${wrongKey}site/index.html`, { token: null })).status, 404);
    assert.equal((await call("GET", `${snap.rawBase}.git/config`, { token: null })).status, 404);
    assert.equal((await call("GET", `${snap.rawBase}escape/secret.txt`, { token: null })).status, 404);
    assert.equal((await call("GET", `${snap.rawBase}..%2F..%2Fetc%2Fpasswd`, { token: null })).status, 404);
    assert.equal((await call("POST", `${snap.rawBase}site/index.html`, { token: null, body: {} })).status, 405);

    const file = await call("GET", `/api/rooms/${room.id}/file?path=escape/secret.txt`);
    assert.equal(file.status, 404);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("html and svg fences in a message are served as sandboxed pages, found by the hash of their body", async () => {
  const room = await newRoom("Daemon blocks");
  const snap = (await call("GET", `/api/rooms/${room.id}`)).json<{ rawBase: string }>();
  const html = "<!doctype html><canvas id=c></canvas><script>c.width=10</script>";
  const pic = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>';
  const text = ["Look:", "```html", html, "```", "and", "```svg", pic, "```", "```js", "not live", "```"].join("\n");
  const posted = (await call("POST", `/api/rooms/${room.id}/messages`, { body: { text } })).json<{ message: { id: string } }>();
  const id = posted.message.id;

  const page = await call("GET", `${snap.rawBase}~block/m:${id}/${blockHash(html)}`, { token: null });
  assert.equal(page.status, 200);
  assert.ok(page.body.startsWith(html));
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.match(String(page.headers["content-security-policy"]), /^sandbox allow-scripts/);

  const image = await call("GET", `${snap.rawBase}~block/m:${id}/${blockHash(pic)}`, { token: null });
  assert.equal(image.status, 200);
  assert.equal(image.body, pic);
  assert.match(String(image.headers["content-type"]), /^image\/svg\+xml/);

  assert.equal((await call("GET", `${snap.rawBase}~block/m:${id}/${blockHash("not live")}`, { token: null })).status, 404);
  assert.equal((await call("GET", `${snap.rawBase}~block/m:nope/${blockHash(html)}`, { token: null })).status, 404);
  const wrongKey = snap.rawBase.replace(/[0-9a-f]{32}/, "0".repeat(32));
  assert.equal((await call("GET", `${wrongKey}~block/m:${id}/${blockHash(html)}`, { token: null })).status, 404);
});

test("static UI is served with a CSP; unknown paths fall back to the app shell", async () => {
  const index = await call("GET", "/", { token: null });
  assert.equal(index.status, 200);
  assert.match(String(index.headers["content-security-policy"]), /frame-ancestors 'none'/);
  // Whichever page is served (ui/dist or web/), the script it references must load.
  const script = /<script[^>]*\ssrc="(\/[^"]+\.js)"/.exec(String(index.body))?.[1];
  assert.ok(script, "index.html references a script");
  assert.equal((await call("GET", script, { token: null })).status, 200);
  assert.equal((await call("GET", "/../package.json", { token: null })).status, 404);
  const route = await call("GET", "/rooms/whatever", { token: null });
  assert.equal(route.status, 200);
  assert.equal(route.body, index.body);
});
