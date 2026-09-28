// Emulates `claude -p --output-format stream-json` and `codex exec --json`
// closely enough to drive the room engine in tests.
//
// Behaviour comes from $FAKE_RULES (JSON array). The first rule whose `agent`
// (optional) and `match` (substring of the prompt, optional) fit is used:
//   { agent, match, reply, table: [[...argv]], write: {path, content} (or a list),
//     command: "shown as the tool call; {cwd} and {cli} expand", sleepMs,
//     error: "text", exitCode, once: true }
// Without a matching rule: first turn replies "<agent> here", later turns pass.
// Every invocation is appended to $FAKE_LOG as one JSON line.
// With CLAUDE_CONFIG_DIR / CODEX_HOME set, the turn is also written to a native
// session file in the real CLI's format, like `claude -p` and `codex exec` do.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const kind = process.argv[2];
const args = process.argv.slice(3);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const stateDir = process.env.FAKE_STATE;
mkdirSync(join(stateDir, "sessions"), { recursive: true });
const sessionFile = (id) => join(stateDir, "sessions", `${kind}-${id}`);
const counterFile = join(stateDir, `${kind}-turns`);

const pad = (n) => String(n).padStart(2, "0");
/** Appends one turn to the native session file the real CLI would keep. */
const writeNativeTurn = (sessionId, prompt, reply, resumed) => {
  const now = new Date();
  const ts = now.toISOString();
  const lines = [];
  let file;
  if (kind === "claude") {
    if (!process.env.CLAUDE_CONFIG_DIR) return;
    const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${sessionId}.jsonl`);
    const promptId = randomUUID();
    lines.push(
      { type: "queue-operation", operation: "enqueue", timestamp: ts, sessionId },
      { type: "user", isSidechain: false, promptId, uuid: randomUUID(), timestamp: ts, sessionId, message: { role: "user", content: prompt } },
      { type: "assistant", isSidechain: false, uuid: randomUUID(), timestamp: ts, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", isSidechain: false, promptId, uuid: randomUUID(), timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu", content: "ok" }] } },
      { type: "assistant", isSidechain: false, uuid: randomUUID(), timestamp: ts, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: reply }] } },
      { type: "last-prompt", lastPrompt: prompt.slice(0, 40), sessionId },
    );
  } else {
    if (!process.env.CODEX_HOME) return;
    const dir = join(process.env.CODEX_HOME, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(dir, { recursive: true });
    const index = join(process.env.CODEX_HOME, `rollout-${sessionId}`);
    file = existsSync(index) ? readFileSync(index, "utf8") : join(dir, `rollout-${ts.slice(0, 19).replace(/:/g, "-")}-${sessionId}.jsonl`);
    writeFileSync(index, file);
    const turnId = randomUUID();
    if (!resumed) lines.push({ timestamp: ts, type: "session_meta", payload: { id: sessionId, cwd: process.cwd(), originator: "codex_exec" } });
    lines.push(
      { timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>fake</environment_context>" }] } },
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
      { timestamp: ts, type: "event_msg", payload: { type: "item_completed", turn_id: turnId, item: { type: "UserMessage", id: randomUUID(), content: [{ type: "text", text: prompt }] } } },
      { timestamp: ts, type: "event_msg", payload: { type: "item_completed", turn_id: turnId, item: { type: "AgentMessage", id: randomUUID(), phase: "final_answer", content: [{ type: "Text", text: reply }] } } },
      { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: reply } },
    );
  }
  appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
};

const main = async () => {
  const prompt = await readStdin();
  let sessionId;
  let resumed = false;
  if (kind === "claude") {
    const sid = args.indexOf("--session-id");
    const res = args.indexOf("--resume");
    if (res >= 0) {
      sessionId = args[res + 1];
      resumed = true;
    } else sessionId = args[sid + 1];
  } else {
    if (args[0] === "exec" && args[1] === "resume") {
      sessionId = args[2];
      resumed = true;
    } else sessionId = randomUUID();
  }

  const turn = (existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0) + 1;
  writeFileSync(counterFile, String(turn));
  appendFileSync(
    process.env.FAKE_LOG,
    `${JSON.stringify({
      kind,
      turn,
      args,
      prompt,
      cwd: process.cwd(),
      sessionId,
      resumed,
      env: {
        AGORYX_AGENT: process.env.AGORYX_AGENT,
        AGORYX_ROOM: process.env.AGORYX_ROOM,
        AGORYX_TURN: process.env.AGORYX_TURN,
        PATH_HEAD: (process.env.PATH || "").split(":")[0],
        CLAUDECODE: process.env.CLAUDECODE,
      },
    })}\n`,
  );

  if (resumed && !existsSync(sessionFile(sessionId))) {
    if (kind === "claude") {
      process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    } else {
      process.stderr.write(`Error: thread/resume failed: no rollout found for thread id ${sessionId}\n`);
    }
    process.exit(1);
  }
  writeFileSync(sessionFile(sessionId), "1");

  const rules = process.env.FAKE_RULES ? JSON.parse(readFileSync(process.env.FAKE_RULES, "utf8")) : [];
  const usedFile = join(stateDir, "used-rules.json");
  const used = existsSync(usedFile) ? JSON.parse(readFileSync(usedFile, "utf8")) : [];
  const ruleIndex = rules.findIndex(
    (rule, index) =>
      (!rule.agent || rule.agent === kind) &&
      (!rule.match || prompt.includes(rule.match)) &&
      (!rule.once || !used.includes(index)),
  );
  const rule = ruleIndex >= 0 ? rules[ruleIndex] : null;
  if (rule?.once) writeFileSync(usedFile, JSON.stringify([...used, ruleIndex]));

  const firstTurn = !resumed;
  const reply = rule?.reply ?? (firstTurn ? `${kind} here` : "::pass::");

  if (kind === "claude") {
    out({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
  } else {
    if (!resumed) out({ type: "thread.started", thread_id: sessionId });
    out({ type: "turn.started" });
  }

  if (rule?.sleepMs) await sleep(rule.sleepMs);

  const tableOutputs = [];
  for (const argv of rule?.table ?? []) {
    try {
      tableOutputs.push(execFileSync("agoryx", argv, { encoding: "utf8", env: process.env }).trim());
    } catch (error) {
      tableOutputs.push(`ERR ${String(error.stderr || error.message).trim()}`);
    }
  }
  if (tableOutputs.length) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ kind, turn, tableOutputs })}\n`);

  for (const write of [rule?.write ?? []].flat()) {
    mkdirSync(dirname(join(process.cwd(), write.path)), { recursive: true });
    writeFileSync(join(process.cwd(), write.path), write.content);
  }

  if (rule?.error) {
    process.stderr.write(`${rule.error}\n`);
    if (kind === "claude") out({ type: "result", subtype: "error_during_execution", is_error: true, result: rule.error, session_id: sessionId });
    else out({ type: "turn.failed", error: { message: rule.error } });
    process.exit(rule.exitCode ?? 1);
  }

  writeNativeTurn(sessionId, prompt, reply, resumed);

  const command = (rule?.command ?? "ls -a").replaceAll("{cwd}", process.cwd()).replaceAll("{cli}", process.env.AGORYX_CLI ?? "agoryx");
  if (kind === "claude") {
    out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: `tu${turn}`, name: "Bash", input: { command } }] } });
    out({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: `tu${turn}`, content: "ok", is_error: false }] } });
    out({ type: "stream_event", session_id: sessionId, event: { type: "message_start" } });
    for (const piece of reply.match(/.{1,8}/gs) ?? []) {
      out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
    }
    out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: reply }] } });
    out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001 });
  } else {
    const wrapped = `/bin/zsh -lc '${command.replace(/'/g, "'\\''")}'`;
    out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: wrapped, status: "in_progress" } });
    out({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: wrapped, aggregated_output: ".\n", exit_code: 0, status: "completed" } });
    out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: reply } });
    out({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 6 } });
  }
};

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(3);
});
