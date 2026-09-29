// A one-call MCP client, as an agent's CLI would be: a fake agent's turn runs
//   node tests/agora/fixtures/mcp-call.mjs <tool> '<json arguments>'
// It starts the room's MCP server the way the room hands it to the CLIs ($AGORYX_CLI mcp; without the shim,
// bin/agoryx-agent.mjs mcp), initializes, calls the tool once and prints what came back:
// "TOOL ERROR: " before the text of a tool error, "[image image/png, N base64 characters]" for an image.
// Exit 0 whenever the server answered; 1 on a protocol failure.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [tool, json = "{}"] = process.argv.slice(2);
if (!tool) {
  process.stderr.write("usage: mcp-call.mjs <tool> [json arguments]\n");
  process.exit(2);
}

const [command, ...args] = process.env.AGORYX_CLI
  ? [process.env.AGORYX_CLI, "mcp"]
  : [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "agoryx-agent.mjs"), "mcp"];
const server = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });

const failWith = (text) => {
  process.stderr.write(`mcp-call: ${text}\n`);
  server.kill();
  process.exit(1);
};
const guard = setTimeout(() => failWith("no answer within 90 s"), 90_000);

const waiting = new Map();
let buffer = "";
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  }
});
server.on("error", (error) => failWith(error.message));

const request = (id, method, params) =>
  new Promise((resolve) => {
    waiting.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const init = await request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "mcp-call", version: "0" },
});
if (init.error || init.result?.serverInfo?.name !== "agoryx_browser") failWith(`initialize failed: ${JSON.stringify(init)}`);
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const answer = await request(2, "tools/call", { name: tool, arguments: JSON.parse(json) });
if (answer.error) failWith(`tools/call failed: ${JSON.stringify(answer.error)}`);
const lines = [];
for (const item of answer.result.content ?? []) {
  if (item.type === "text") lines.push(item.text);
  else if (item.type === "image") lines.push(`[image ${item.mimeType}, ${item.data.length} base64 characters]`);
}
process.stdout.write(`${answer.result.isError ? "TOOL ERROR: " : ""}${lines.join("\n")}\n`);

clearTimeout(guard);
server.stdin.end();
server.on("exit", (code) => process.exit(code === 0 ? 0 : 1));
