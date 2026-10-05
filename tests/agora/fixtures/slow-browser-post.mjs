// A browser command whose body arrives late, as a slow agent process would send it: a fake agent's turn runs
//   node tests/agora/fixtures/slow-browser-post.mjs <started-file> <go-file>
// It sends POST /api/browser under the agent's key (read as bin/agoryx-mcp.mjs reads it) with half of the body,
// writes <started-file>, waits for <go-file>, sends the rest and prints "<status> <error or ok>".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const [started, go] = process.argv.slice(2);
const env = process.env;
const key = env.AGORYX_TURN_FILE ? JSON.parse(readFileSync(env.AGORYX_TURN_FILE, "utf8")).key : env.AGORYX_AGENT_KEY;
const url = new URL(JSON.parse(readFileSync(join(env.AGORYX_HOME, "daemon.json"), "utf8")).url);
const body = JSON.stringify({ op: "snapshot", args: {} });
const half = Math.floor(body.length / 2);

const req = request(
  {
    host: url.hostname,
    port: url.port,
    path: "/api/browser",
    method: "POST",
    headers: { host: url.host, "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-agoryx-token": key },
  },
  (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (text += chunk));
    res.on("end", () => {
      const parsed = JSON.parse(text);
      process.stdout.write(`${res.statusCode} ${parsed.error ?? "ok"}\n`);
      process.exit(0);
    });
  },
);
req.on("error", (error) => {
  process.stdout.write(`ERROR ${error.message}\n`);
  process.exit(1);
});
req.flushHeaders();
req.write(body.slice(0, half));
writeFileSync(started, "");
const wait = setInterval(() => {
  if (!existsSync(go)) return;
  clearInterval(wait);
  req.end(body.slice(half));
}, 20);
setTimeout(() => {
  process.stdout.write("ERROR no go within 30 s\n");
  process.exit(1);
}, 30_000).unref();
