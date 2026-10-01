import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { uploadName, uploadsDir } from "../../internal/agora/uploads.js";
import { writeFakeBins } from "./helpers.js";

const call = (port: number, token: string, method: string, path: string, body?: unknown) =>
  new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
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
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

test("upload names keep the name and lose folders and link-breaking characters", () => {
  assert.equal(uploadName("shot.png"), "shot.png");
  assert.equal(uploadName("../../etc/passwd"), "passwd");
  assert.equal(uploadName("C:\\Users\\me\\notes (1).md"), "notes 1.md");
  assert.equal(uploadName(".hidden"), "hidden");
  assert.equal(uploadName(""), "file");
  assert.equal(uploadName(`${"a".repeat(300)}.txt`).length, 120);
  assert.ok(uploadName(`${"a".repeat(300)}.txt`).endsWith(".txt"));
});

test("the human attaches a file: it is kept outside the workspace; an agent may not upload", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-uploads-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  const env: NodeJS.ProcessEnv = { ...process.env, AGORYX_HOME: join(home, "agora") };
  const daemon = new AgoraDaemon({ env, port: 0, advertise: false, runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) } });
  const { port } = await daemon.start();
  const api = (method: string, path: string, body?: unknown) => call(port, daemon.token, method, path, body);
  try {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const up = await api("POST", "/api/uploads", { name: "screen shot.png", data: png.toString("base64") });
    assert.equal(up.status, 201, JSON.stringify(up.json));
    const path = String(up.json.path);
    assert.ok(path.startsWith(uploadsDir(env)), path);
    assert.ok(path.endsWith("/screen shot.png"), path);
    assert.deepEqual(readFileSync(path), png);

    assert.equal((await api("POST", "/api/uploads", { name: "x.txt", data: "" })).status, 400);
    assert.equal((await api("POST", "/api/uploads", { name: "x.txt" })).status, 400);

    const dir = join(home, "work");
    mkdirSync(dir);
    const made = await api("POST", "/api/rooms", { name: "Files", dir });
    const roomId = (made.json.room as { id: string }).id;
    assert.deepEqual(readdirSync(dir).filter((f) => !f.startsWith(".")), [], "nothing is written into the workspace");
    const refused = await call(port, agentKey(daemon.token, roomId, "claude"), "POST", "/api/uploads", { name: "a.txt", data: "aGk=" });
    assert.equal(refused.status, 403);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});
