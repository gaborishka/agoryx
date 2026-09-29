import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { test } from "node:test";
import { agentBehind, trackAgentProcess } from "../../internal/agora/agentprocs.js";

// Whose process holds the other end of a connection: when that cannot be looked up while agent
// processes run, the answer is "unknown" (the daemon then refuses the human's token), never "the human".

test("a failed process lookup while agents run is unknown, not the human's; a working one finds no agent behind the human's own socket", async () => {
  const agent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { detached: true, stdio: "ignore" });
  trackAgentProcess(agent.pid, { AGORYX_ROOM: "room-1", AGORYX_AGENT: "claude" });
  const accepted: Socket[] = [];
  const server = createServer((socket) => accepted.push(socket));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const clients = [connect(port, "127.0.0.1"), connect(port, "127.0.0.1")];
  await new Promise<void>((done) => {
    const check = () => (accepted.length === 2 ? done() : setTimeout(check, 10));
    check();
  });
  const path = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    const failed = await agentBehind(accepted[0]!);
    assert.ok(failed && "unknown" in failed, JSON.stringify(failed));
    process.env.PATH = path;
    assert.equal(await agentBehind(accepted[0]!), null, "a failed lookup is not remembered: the next request asks again");
    assert.equal(await agentBehind(accepted[1]!), null, "the test's own process is no agent's");
  } finally {
    process.env.PATH = path;
    for (const socket of [...clients, ...accepted]) socket.destroy();
    server.close();
    agent.kill();
  }
});
