import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserStep, describeBrowserTool } from "../../internal/agora/browsertools.js";
import { buildClaudeArgs, buildClaudeSettings, createClaudeRunner, describeClaudeTool } from "../../internal/agora/runners/claude.js";
import { buildCodexArgs, createCodexRunner, describeCodexItem, execShapedItem } from "../../internal/agora/runners/codex.js";
import type { TurnRequest } from "../../internal/agora/runners/types.js";
import { DEFAULT_SETTINGS, type Activity, type RoomAgent } from "../../internal/agora/types.js";
import { createTestRoom, withTimeout, type TestRoom } from "./helpers.js";

// What the runners do for the room's browser: both CLIs get the room's MCP server whenever the room has its shim,
// and a browser step in the trace never holds a value (typed text, a script, a query string, userinfo).

const SHIM = "/rooms/home/bin/agoryx";
const SID = "00000000-0000-4000-8000-000000000000";
const base: TurnRequest = { prompt: "hi", cwd: "/tmp/ws", sessionId: null, roomName: "R", settings: DEFAULT_SETTINGS, env: {}, signal: new AbortController().signal };
const withShim: TurnRequest = { ...base, env: { AGORYX_CLI: SHIM } };

const CODEX_PAIRS = [
  `mcp_servers.agoryx_browser.command="${SHIM}"`,
  'mcp_servers.agoryx_browser.args=["mcp"]',
  'mcp_servers.agoryx_browser.env_vars=["AGORYX_ROOM","AGORYX_AGENT","AGORYX_TURN","AGORYX_SEEN","AGORYX_AGENT_KEY","AGORYX_TURN_FILE","AGORYX_HOME","XDG_STATE_HOME"]',
  'mcp_servers.agoryx_browser.default_tools_approval_mode="approve"',
  "mcp_servers.agoryx_browser.startup_timeout_sec=20",
  "mcp_servers.agoryx_browser.tool_timeout_sec=90",
  "mcp_servers.agoryx_browser.supports_parallel_tool_calls=false",
];
const SECRETS = ["hunter2", "code=abc", "u:p", "document.cookie", "p4ssw0rd", "#t"];
const noSecrets = (value: unknown, what: string) => {
  const json = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!json.includes(secret), `${what} holds "${secret}": ${json}`);
};

/** The value right after `flag`, and the pairs `-c <value>` the args carry. */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const configPairs = (args: string[]) => args.flatMap((arg, index) => (args[index - 1] === "-c" ? [arg] : []));

test("Claude: --mcp-config with the room's server right before --settings, and its tools allowed", () => {
  for (const [fresh, settings] of [[true, DEFAULT_SETTINGS], [false, { ...DEFAULT_SETTINGS, network: false }], [true, { ...DEFAULT_SETTINGS, access: "readonly" as const }]] as const) {
    const request = { ...withShim, settings };
    const args = buildClaudeArgs(request, SID, fresh);
    const at = args.indexOf("--mcp-config");
    assert.ok(at > 0, "--mcp-config is there");
    assert.deepEqual(JSON.parse(args[at + 1]!), { mcpServers: { agoryx_browser: { type: "stdio", command: SHIM, args: ["mcp"] } } });
    assert.equal(args[at + 2], "--settings", "--settings ends --mcp-config's list of values");
    assert.equal(args.filter((arg) => arg === "--mcp-config").length, 1);
    assert.ok(!args.includes("--strict-mcp-config"), "the human's own MCP servers stay");
    const allow = (buildClaudeSettings(request) as { permissions: { allow: string[] } }).permissions.allow;
    assert.ok(allow.includes("mcp__agoryx_browser__*"));
    assert.deepEqual(JSON.parse(after(args, "--settings")!), buildClaudeSettings(request));
  }
});

test("Codex: exec and exec resume carry the seven -c pairs of the room's server", () => {
  for (const request of [withShim, { ...withShim, sessionId: "thread-1" }, { ...withShim, settings: { ...DEFAULT_SETTINGS, access: "readonly" as const, network: false } }]) {
    const args = buildCodexArgs(request);
    const pairs = configPairs(args).filter((pair) => pair.startsWith("mcp_servers."));
    assert.deepEqual(pairs, CODEX_PAIRS);
    assert.equal(args.at(-1), "-", "the prompt still comes on stdin, last");
  }
});

test("without the shim neither CLI gets the server, and the argv is as before", () => {
  const claude = buildClaudeArgs(base, SID, true);
  assert.ok(!claude.includes("--mcp-config"));
  assert.ok(!JSON.stringify(buildClaudeSettings(base)).includes("mcp__"));
  assert.equal(claude[claude.indexOf("--settings") - 1], "--include-partial-messages");
  for (const request of [base, { ...base, sessionId: "thread-1" }]) {
    assert.ok(!buildCodexArgs(request).join(" ").includes("mcp_servers"));
  }
});

// --- What the rooms start the CLIs with --------------------------------------------------------------------------

const CLAUDE_ONLY: RoomAgent[] = [{ id: "claude", kind: "claude", label: "Claude" }];
const CODEX_ONLY: RoomAgent[] = [{ id: "codex", kind: "codex", label: "Codex" }];

const startedWith = async (room: TestRoom, kind: string): Promise<string[]> => {
  room.engine.postHuman(`@${kind} hello`);
  await withTimeout(room.engine.waitIdle());
  const entry = room.invocations(kind)[0];
  assert.ok(entry?.args, `the fake ${kind} logged its argv`);
  return entry.args;
};

for (const live of [false, true]) {
  test(`a room (${live ? "live processes" : "a process per turn"}) starts Claude with the room's server`, async () => {
    const room = createTestRoom({ agents: CLAUDE_ONLY, live, rules: [] });
    try {
      const args = await startedWith(room, "claude");
      if (live) assert.ok(args.includes("--input-format"), "a live process");
      const config = JSON.parse(after(args, "--mcp-config")!);
      assert.deepEqual(config.mcpServers.agoryx_browser, { type: "stdio", command: join(room.shimDir, "agoryx"), args: ["mcp"] });
      assert.equal(args[args.indexOf("--mcp-config") + 2], "--settings");
      assert.ok(JSON.parse(after(args, "--settings")!).permissions.allow.includes("mcp__agoryx_browser__*"));
    } finally {
      await room.cleanup();
    }
  });

  test(`a room (${live ? "live processes" : "a process per turn"}) starts Codex with the room's server`, async () => {
    const room = createTestRoom({ agents: CODEX_ONLY, live, rules: [] });
    try {
      const args = await startedWith(room, "codex");
      assert.equal(args[0], live ? "app-server" : "exec");
      const shim = join(room.shimDir, "agoryx");
      assert.deepEqual(
        configPairs(args).filter((pair) => pair.startsWith("mcp_servers.")),
        CODEX_PAIRS.map((pair) => pair.replace(`"${SHIM}"`, JSON.stringify(shim))),
      );
    } finally {
      await room.cleanup();
    }
  });
}

// --- Trace labels ------------------------------------------------------------------------------------------------

test("browser steps are labelled without their values", () => {
  const cases: Array<[string, unknown, string]> = [
    ["navigate", { url: "https://u:p@host/cb?code=abc#t" }, "navigate https://host/cb"],
    ["navigate", { url: "localhost:5173/settings?tab=2" }, "navigate http://localhost:5173/settings"],
    ["navigate", { url: "file:///Users/me/p4ssw0rd.txt" }, "navigate a file: URL"],
    ["navigate", { url: "javascript:document.cookie" }, "navigate a javascript: URL"],
    ["navigate", { url: "about:blank" }, "navigate about:blank"],
    ["navigate", { go: "back" }, "navigate back"],
    ["navigate", {}, "navigate (no URL)"],
    ["snapshot", { waitForText: "hunter2" }, "snapshot"],
    ["click", { ref: "e12" }, "click e12"],
    ["click", { x: 320.4, y: 139.6 }, "click at 320,140"],
    ["click", { ref: "hunter2" }, "click"],
    ["type", { ref: "e5", text: "hunter2" }, "type e5 (7 characters)"],
    ["type", { ref: "e5", text: "x" }, "type e5 (1 character)"],
    ["type", { ref: "hunter2", text: "" }, "type (0 characters)"],
    ["press", { key: "Enter" }, "press Enter"],
    ["press", { key: "Meta+a" }, "press Meta+a"],
    ["press", { key: "h" }, "press a character key"],
    ["press", { key: "Shift+H" }, "press a character key"],
    ["press", { key: "hunter2" }, "press a key"],
    ["screenshot", {}, "screenshot"],
    ["screenshot", { ref: "e3" }, "screenshot e3"],
    ["eval", { expression: "document.cookie" }, "eval (15 characters)"],
  ];
  for (const [op, args, label] of cases) {
    assert.equal(browserStep(op, args), label, `${op} ${JSON.stringify(args)}`);
    noSecrets(browserStep(op, args), op);
  }
  assert.ok(browserStep("navigate", { url: `http://localhost/${"a".repeat(400)}` }).length <= 160, "at most 160 characters");
  assert.equal(describeBrowserTool("browser_download", {}), null, "not a tool of the room's browser");
  assert.equal(describeBrowserTool("snapshot", {}), null);
});

test("Claude's trace: a browser tool is a value-free browser step", () => {
  assert.deepEqual(describeClaudeTool("mcp__agoryx_browser__browser_type", { ref: "e5", text: "hunter2" }), { kind: "browser", label: "browser type e5 (7 characters)" });
  assert.deepEqual(describeClaudeTool("mcp__agoryx_browser__browser_navigate", { url: "https://u:p@host/cb?code=abc#t" }), { kind: "browser", label: "browser navigate https://host/cb" });
  assert.deepEqual(describeClaudeTool("mcp__agoryx_browser__browser_eval", { expression: "document.cookie" }), { kind: "browser", label: "browser eval (15 characters)" });
  const other = describeClaudeTool("mcp__agoryx_browser__browser_download", { path: "p4ssw0rd" });
  assert.equal(other.kind, "tool");
  noSecrets(other, "an unknown tool of the server");
  // Another server's tool named like ours is not the room's browser.
  assert.notEqual(describeClaudeTool("mcp__playwright__browser_type", { ref: "e5", text: "x" }).kind, "browser");
});

test("Codex's trace: an MCP call to the room's browser is a value-free browser step, from exec and app-server alike", () => {
  const argsObject = { url: "https://u:p@host/cb?code=abc#t" };
  const exec = describeCodexItem({ type: "mcp_tool_call", server: "agoryx_browser", tool: "browser_navigate", arguments: argsObject, status: "completed" });
  assert.deepEqual(exec, { kind: "browser", label: "browser navigate https://host/cb", status: "ok" });
  const text = describeCodexItem({ type: "mcp_tool_call", server: "agoryx_browser", tool: "browser_type", arguments: JSON.stringify({ ref: "e5", text: "hunter2" }), status: "in_progress" });
  assert.deepEqual(text, { kind: "browser", label: "browser type e5 (7 characters)", status: "running" });
  const failed = describeCodexItem({
    type: "mcp_tool_call",
    server: "agoryx_browser",
    tool: "browser_eval",
    arguments: { expression: "document.cookie" },
    status: "failed",
    error: { message: "ReferenceError at document.cookie, code=abc" },
  });
  assert.deepEqual(failed, { kind: "browser", label: "browser eval (15 characters)", status: "fail" });
  const shaped = execShapedItem({ type: "mcpToolCall", id: "i1", server: "agoryx_browser", tool: "browser_type", arguments: { ref: "e5", text: "hunter2" }, status: "inProgress" });
  assert.deepEqual(describeCodexItem(shaped!), { kind: "browser", label: "browser type e5 (7 characters)", status: "running" });
  // Another server's browser_* stays an MCP tool call.
  assert.deepEqual(describeCodexItem({ type: "mcp_tool_call", server: "playwright", tool: "browser_type", arguments: { text: "hunter2" }, status: "completed" }), {
    kind: "tool",
    label: "playwright.browser_type",
    status: "ok",
  });
  noSecrets([exec, text, failed, describeCodexItem(shaped!)], "Codex's browser steps");
});

// --- Whole turns from the CLIs' own event streams ---------------------------------------------------------------

/** A CLI that reads its prompt and prints `lines`, one JSON event each. */
const scriptedCli = (dir: string, name: string, lines: unknown[]): string => {
  const path = join(dir, name);
  const body = lines.map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\ncat <<'EOF'\n${body}\nEOF\n`);
  chmodSync(path, 0o755);
  return path;
};

test("a whole Claude turn: browser steps and a failed one, and the trace keeps no value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-browser-runner-"));
  try {
    const session = "11111111-1111-4111-8111-111111111111";
    const bin = scriptedCli(dir, "claude", [
      { type: "system", subtype: "init", session_id: session },
      { type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "t1", name: "mcp__agoryx_browser__browser_type", input: { ref: "e5", text: "hunter2" } }] } },
      {
        type: "user",
        session_id: session,
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "typing hunter2 into https://host/cb?code=abc failed" }] }] },
      },
      { type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "t2", name: "mcp__agoryx_browser__browser_eval", input: { expression: "document.cookie" } }] } },
      { type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "p4ssw0rd" }] } },
      { type: "assistant", session_id: session, message: { content: [{ type: "text", text: "Done." }] } },
      { type: "result", subtype: "success", session_id: session, is_error: false, result: "Done." },
    ]);
    const activities: Activity[] = [];
    const result = await createClaudeRunner(bin).run(
      { ...withShim, cwd: dir, env: { PATH: process.env.PATH, AGORYX_CLI: SHIM } },
      { onSession: () => {}, onText: () => {}, onActivity: (activity) => activities.push(activity) },
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual(
      activities.map(({ kind, label, status, detail }) => ({ kind, label, status, detail })),
      [
        { kind: "browser", label: "browser type e5 (7 characters)", status: "running", detail: undefined },
        { kind: "browser", label: "browser type e5 (7 characters)", status: "fail", detail: undefined },
        { kind: "browser", label: "browser eval (15 characters)", status: "running", detail: undefined },
        { kind: "browser", label: "browser eval (15 characters)", status: "ok", detail: undefined },
      ],
    );
    noSecrets(activities, "Claude's trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a whole Codex turn: an MCP call to the room's browser, and the trace keeps no value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-browser-runner-"));
  try {
    const item = { id: "item_1", type: "mcp_tool_call", server: "agoryx_browser", tool: "browser_navigate", arguments: { url: "https://u:p@host/cb?code=abc#t" } };
    const bin = scriptedCli(dir, "codex", [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.started", item: { ...item, status: "in_progress" } },
      { type: "item.completed", item: { ...item, status: "failed", error: { message: "net::ERR at https://u:p@host/cb?code=abc" } } },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Done." } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]);
    const activities: Activity[] = [];
    const result = await createCodexRunner(bin).run(
      { ...withShim, cwd: dir, env: { PATH: process.env.PATH, AGORYX_CLI: SHIM, CODEX_HOME: join(dir, "codex-home") } },
      { onSession: () => {}, onText: () => {}, onActivity: (activity) => activities.push(activity) },
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual(
      activities.map(({ kind, label, status }) => ({ kind, label, status })),
      [
        { kind: "browser", label: "browser navigate https://host/cb", status: "running" },
        { kind: "browser", label: "browser navigate https://host/cb", status: "fail" },
      ],
    );
    noSecrets(activities, "Codex's trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
