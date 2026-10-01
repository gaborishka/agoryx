import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { agentKey } from "../../internal/agora/actor.js";

let home: string;
let daemon: AgoraDaemon;
let port: number;

const call = (method: string, path: string, body?: unknown, token = daemon.token): Promise<{ status: number; json: () => any }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          "x-agoryx-token": token,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-editor-"));
  daemon = new AgoraDaemon({
    env: { ...process.env, AGORYX_HOME: join(home, "agora"), AGORYX_USER: "Ivan", AGORYX_WORKSPACES: join(home, "ws"), SHELL: "/bin/sh" },
    port: 0,
    advertise: false,
    watchDays: 0,
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("the human's editor saves a file, and a save over what changed on disk since is refused with what is there now", async () => {
  const room = (await call("POST", "/api/rooms", { name: "Editor" })).json().room as { id: string };
  const workspace = (await call("GET", `/api/rooms/${room.id}`)).json().state.workspace as string;
  writeFileSync(join(workspace, "a.txt"), "one\n");

  const opened = (await call("GET", `/api/rooms/${room.id}/file?path=a.txt`)).json();
  assert.equal(opened.text, "one\n");
  assert.match(opened.hash, /^[0-9a-f]{40}$/);

  const saved = await call("POST", `/api/rooms/${room.id}/file`, { path: "a.txt", text: "two\n", base: opened.hash });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "two\n");

  // An agent changes the file; the editor's next save, still on the old version, writes nothing.
  writeFileSync(join(workspace, "a.txt"), "agent\n");
  const stale = await call("POST", `/api/rooms/${room.id}/file`, { path: "a.txt", text: "three\n", base: saved.json().hash });
  assert.equal(stale.status, 409);
  assert.equal(stale.json().text, "agent\n");
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "agent\n");

  // A new file, in a new folder.
  assert.equal((await call("POST", `/api/rooms/${room.id}/file`, { path: "src/new.ts", text: "x", base: null })).status, 200);
  assert.equal(readFileSync(join(workspace, "src/new.ts"), "utf8"), "x");
  assert.equal((await call("POST", `/api/rooms/${room.id}/file`, { path: "src/new.ts", text: "y", base: null })).status, 409);
});

test("the editor is the human's: an agent's key, paths outside the folder, .git and .agoryx are refused", async () => {
  const room = (await call("POST", "/api/rooms", { name: "Editor guard" })).json().room as { id: string };
  const state = (await call("GET", `/api/rooms/${room.id}`)).json().state as { agents: Array<{ id: string }> };
  const key = agentKey(daemon.token, room.id, state.agents[0]!.id);
  assert.equal((await call("POST", `/api/rooms/${room.id}/file`, { path: "b.txt", text: "x", base: null }, key)).status, 403);
  for (const path of ["../escape.txt", ".git/config", ".agoryx/memory.md"]) {
    assert.equal((await call("POST", `/api/rooms/${room.id}/file`, { path, text: "x", base: null })).status, 403, path);
  }
});
