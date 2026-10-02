// Emulates `claude -p --output-format stream-json` and `codex exec --json`
// closely enough to drive the room engine in tests.
//
// Behaviour comes from $FAKE_RULES (JSON array). The first rule whose `agent` (the kind,
// optional), `id` (the room's agent id, $AGORYX_AGENT, optional) and `match` (substring of
// the prompt, optional) fit is used:
//   { agent, id, match, reply, table: [[...argv]], run: [[command, ...argv]] (outputs logged as runOutputs),
//     write: {path, content, via?: "shell"} (or a list), earlyWrite: {path, content} (with the edit tool, before sleepMs),
//     command: "shown as the tool call; {cwd} and {cli} expand" (commands: [...], several in order; one may be
//     {command, fail, background, parent, together, result, hang}: it exits 1 / claude runs it in the background /
//     in a subagent / asks for it in the same message as the command before it / its tool_use_result has these fields /
//     it never ends, and the turn waits on it until it is stopped),
//     between: ["command", ...] (live claude: commands the model runs after the turn ended, as when a background task wakes it),
//     workdir (codex: the folder its commands name; {cwd} expands),
//     sleepMs, afterTableMs (a pause after the table ops),
//     streamSleepMs (claude: pause after streaming the reply, before finishing),
//     error: "text", exitCode, once: true }
// Without a matching rule: first turn replies "<agent id> here", later turns pass.
// More rule fields: tailMs (the process lingers this long after its final event, as the real CLIs do while
// they shut down), lateWrite {path, content, afterMs} (written during that tail), background: true (leaves a
// long-running child in the process group), pidFile (the process's pid, written on start).
// Every invocation (in live mode: every turn) is appended to $FAKE_LOG as one JSON line.
// Live mode, as the real CLIs have it: `claude -p --input-format stream-json` (one user message per turn on
// stdin, echoed back with isReplay, `result` ends the turn) and `codex app-server` (JSON-RPC). The
// environment a live process starts with is fixed; the turn's own comes from $AGORYX_TURN_FILE, like the tools
// in the agent's shell read it. $FAKE_STARTUP_MS: a delay before the CLI starts work (once per process). $FAKE_NO_LIVE=1: the CLI is one that does not know the live flags (exits 2).
// With CLAUDE_CONFIG_DIR / CODEX_HOME set, the turn is also written to a native
// session file in the real CLI's format, like `claude -p` and `codex exec` do.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const kind = process.argv[2];
const args = process.argv.slice(3);
const rawOut = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let out = rawOut;
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

// $FAKE_RATE_LIMITS (JSON {used, resetsAt: epoch seconds, minutes?}): the limits the CLI reports, in its own shapes —
// Claude's rate_limit_event, Codex app-server's account/rateLimits/updated and its session files' token_count.
const fakeLimits = () => JSON.parse(process.env.FAKE_RATE_LIMITS);
const codexRateLimits = (spelling) => {
  const { used, resetsAt, minutes = 10080 } = fakeLimits();
  return spelling === "snake"
    ? { limit_id: "codex", primary: { used_percent: used, window_minutes: minutes, resets_at: resetsAt }, secondary: null, plan_type: "pro", rate_limit_reached_type: null }
    : { limitId: "codex", primary: { usedPercent: used, windowDurationMins: minutes, resetsAt }, secondary: null, planType: "pro", rateLimitReachedType: null };
};
const claudeRateLimitEvent = (sessionId) => {
  const { used, resetsAt } = fakeLimits();
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: used / 100, resetsAt }, seven_day: { utilization: used / 200, resetsAt: resetsAt + 86400 } } },
    uuid: randomUUID(),
    session_id: sessionId,
  };
};
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
      ...(process.env.FAKE_RATE_LIMITS ? [{ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: codexRateLimits("snake") } }] : []),
      { timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: reply } },
    );
  }
  appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
};

const liveClaude = kind === "claude" && args.includes("--input-format");
const liveCodex = kind === "codex" && args[0] === "app-server";

/** The environment a tool in this turn's agent shell sees: the process's, and the turn's own from the turn file. */
const turnEnv = () => {
  const env = { ...process.env };
  const file = env.AGORYX_TURN_FILE;
  if (!file) return env;
  try {
    const context = JSON.parse(readFileSync(file, "utf8"));
    if (context.agent === env.AGORYX_AGENT && context.room === env.AGORYX_ROOM) {
      env.AGORYX_TURN = context.turn;
      env.AGORYX_SEEN = context.seen;
      if (context.key) env.AGORYX_AGENT_KEY = context.key;
      else delete env.AGORYX_AGENT_KEY;
      return env;
    }
  } catch {
    // no turn in progress
  }
  delete env.AGORYX_TURN;
  delete env.AGORYX_SEEN;
  delete env.AGORYX_AGENT_KEY;
  return env;
};

/** Runs one turn: everything from the log line to the final event. `live`: the process stays up afterwards. */
let liveTurns = 0;
const runTurn = async ({ prompt, sessionId, resumed, live }) => {
  const env = turnEnv();
  if (live) liveTurns += 1;
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
      live,
      pid: process.pid,
      env: {
        AGORYX_AGENT: env.AGORYX_AGENT,
        AGORYX_ROOM: env.AGORYX_ROOM,
        AGORYX_TURN: env.AGORYX_TURN,
        AGORYX_SEEN: env.AGORYX_SEEN,
        PATH_HEAD: (env.PATH || "").split(":")[0],
        CLAUDECODE: env.CLAUDECODE,
        AGORYX_AGENT_KEY: env.AGORYX_AGENT_KEY,
        TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
      },
      // What the live process itself was started with: fixed, whatever turn it is.
      procEnv: { AGORYX_TURN: process.env.AGORYX_TURN, AGORYX_SEEN: process.env.AGORYX_SEEN, AGORYX_AGENT_KEY: process.env.AGORYX_AGENT_KEY, AGORYX_TURN_FILE: process.env.AGORYX_TURN_FILE },
    })}\n`,
  );

  if (!live && resumed && !existsSync(sessionFile(sessionId))) {
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
      (!rule.id || rule.id === env.AGORYX_AGENT) &&
      (!rule.match || prompt.includes(rule.match)) &&
      (!rule.once || !used.includes(index)),
  );
  const rule = ruleIndex >= 0 ? rules[ruleIndex] : null;
  if (rule?.once) writeFileSync(usedFile, JSON.stringify([...used, ruleIndex]));
  if (rule?.pidFile) writeFileSync(rule.pidFile, String(process.pid));
  if (rule?.background) {
    // A tool the agent started that outlives the turn: same process group, so a group kill takes it down.
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    child.unref();
    appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ kind, turn, backgroundPid: child.pid })}\n`);
  }

  const firstTurn = !resumed;
  const reply = rule?.reply ?? (firstTurn ? `${env.AGORYX_AGENT || kind} here` : "::pass::");

  if (kind === "claude") {
    out({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
  } else {
    if (!resumed && !live) out({ type: "thread.started", thread_id: sessionId });
    out({ type: "turn.started" });
  }

  // Written with the edit tool before the pause (sleepMs): a first draft the turn goes on changing.
  if (rule?.earlyWrite) {
    const full = join(process.cwd(), rule.earlyWrite.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, rule.earlyWrite.content);
    if (kind === "claude") {
      out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: `tw${turn}-early`, name: "Write", input: { file_path: full, content: "" } }] } });
      out({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: `tw${turn}-early`, content: "ok", is_error: false }] } });
    } else {
      out({ type: "item.completed", item: { id: "edit_early", type: "file_change", changes: [{ path: full, kind: "add" }], status: "completed" } });
    }
  }
  if (rule?.sleepMs) await sleep(rule.sleepMs);
  // Until `agoryx read new` shows this text: an order between agents that holds under any load, as a sleep does not.
  if (rule?.waitForText) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      let seen = "";
      try {
        seen = execFileSync("agoryx", ["read", "new"], { encoding: "utf8", env: process.env });
      } catch {
        // not yet
      }
      if (seen.includes(rule.waitForText) || Date.now() > deadline) break;
      await sleep(50);
    }
  }

  const tableOutputs = [];
  for (const argv of rule?.table ?? []) {
    try {
      tableOutputs.push(execFileSync("agoryx", argv, { encoding: "utf8", env: process.env }).trim());
    } catch (error) {
      tableOutputs.push(`ERR ${String(error.stderr || error.message).trim()}`);
    }
  }
  if (tableOutputs.length) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ kind, turn, tableOutputs })}\n`);
  if (rule?.afterTableMs) await sleep(rule.afterTableMs);

  // Any command, as an agent's shell would run it (the human's own CLI, say), with the turn's environment.
  const runOutputs = [];
  for (const [command, ...argv] of rule?.run ?? []) {
    try {
      runOutputs.push(execFileSync(command, argv, { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }).trim());
    } catch (error) {
      runOutputs.push(`ERR ${String(error.stderr || error.message).trim()}`);
    }
  }
  if (runOutputs.length) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ kind, turn, runOutputs })}\n`);

  // Written with the agent's own edit tool (reported, as the real CLIs do), unless `via: "shell"`.
  let editIndex = 0;
  for (const write of [rule?.write ?? []].flat()) {
    const full = join(process.cwd(), write.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, write.content);
    if (write.via === "shell") continue;
    editIndex += 1;
    if (kind === "claude") {
      const id = `tw${turn}-${editIndex}`;
      out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: full, content: "" } }] } });
      out({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } });
    } else {
      out({ type: "item.completed", item: { id: `edit_${editIndex}`, type: "file_change", changes: [{ path: full, kind: "update" }], status: "completed" } });
    }
  }
  // Codex's built-in image_gen: saved under CODEX_HOME, not reported in the --json stream.
  if (rule?.image && kind === "codex" && process.env.CODEX_HOME) {
    const dir = join(process.env.CODEX_HOME, "generated_images", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `ig_${turn}.png`), rule.image);
  }
  for (const argv of rule?.git ?? []) {
    execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.com", ...argv], { stdio: "ignore" });
  }

  if (rule?.error) {
    process.stderr.write(`${rule.error}\n`);
    if (kind === "claude") out({ type: "result", subtype: "error_during_execution", is_error: true, result: rule.error, session_id: sessionId });
    else out({ type: "turn.failed", error: { message: rule.error } });
    if (live && rule.exitCode === undefined) return;
    process.exit(rule.exitCode ?? 1);
  }

  writeNativeTurn(sessionId, prompt, reply, resumed);

  const commands = (rule?.commands ?? [rule?.command ?? "ls -a"])
    .map((command) => (typeof command === "string" ? { command } : command))
    .map((step) => ({ ...step, command: step.command.replaceAll("{cwd}", process.cwd()).replaceAll("{cli}", process.env.AGORYX_CLI ?? "agoryx") }));
  if (kind === "claude") {
    // Commands asked for in one message: their calls come together, then each one's result.
    const messages = [];
    commands.forEach((step, i) => {
      const call = { ...step, id: i ? `tu${turn}-${i}` : `tu${turn}` };
      if (step.together && messages.length) messages.at(-1).push(call);
      else messages.push([call]);
    });
    for (const calls of messages) {
      const parent = calls[0].parent ?? null;
      const content = calls.map(({ id, command, background }) => ({ type: "tool_use", id, name: "Bash", input: { command, ...(background ? { run_in_background: true } : {}) } }));
      out({ type: "assistant", session_id: sessionId, parent_tool_use_id: parent, message: { content } });
      for (const { id, fail, result, hang } of calls) {
        // It never ends: the calls after it in its message never start.
        if (hang) {
          setInterval(() => {}, 60_000);
          await new Promise(() => {});
        }
        out({ type: "user", session_id: sessionId, parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, content: fail ? "Exit code 1" : "ok", is_error: Boolean(fail) }] }, ...(result ? { tool_use_result: { stdout: "", stderr: "", interrupted: false, ...result } } : {}) });
      }
    }
    if (process.env.FAKE_RATE_LIMITS) out(claudeRateLimitEvent(sessionId));
    out({ type: "stream_event", session_id: sessionId, event: { type: "message_start" } });
    for (const piece of reply.match(/.{1,8}/gs) ?? []) {
      out({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
    }
    if (rule?.streamSleepMs) await sleep(rule.streamSleepMs);
    out({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: reply }] } });
    out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001 * (live ? liveTurns : 1) });
    if (live && rule?.between) {
      await sleep(50);
      rule.between.forEach((command, i) => {
        const id = `between${turn}-${i}`;
        out({ type: "assistant", session_id: sessionId, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
        out({ type: "user", session_id: sessionId, parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } });
      });
    }
  } else {
    const workdir = rule?.workdir ? { cwd: rule.workdir.replaceAll("{cwd}", process.cwd()) } : {};
    commands.forEach(({ command, fail }, i) => {
      const id = i ? `item_1_${i}` : "item_1";
      const wrapped = `/bin/zsh -lc '${command.replace(/'/g, "'\\''")}'`;
      out({ type: "item.started", item: { id, type: "command_execution", command: wrapped, ...workdir, status: "in_progress" } });
      out({ type: "item.completed", item: { id, type: "command_execution", command: wrapped, ...workdir, aggregated_output: ".\n", exit_code: fail ? 1 : 0, status: fail ? "failed" : "completed" } });
    });
    out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: reply } });
    out({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 6 } });
  }

  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ kind, turn, readyAt: Date.now() })}\n`);

  // What a real CLI does after its answer: shutting down takes a while (hooks, MCP servers, state), and
  // whatever it still writes then is not the turn's. A live process has no such tail.
  if (!live && rule?.tailMs) {
    if (rule.lateWrite) {
      await sleep(rule.lateWrite.afterMs ?? 100);
      const full = join(process.cwd(), rule.lateWrite.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, rule.lateWrite.content);
    }
    await sleep(rule.tailMs);
  }
};

const main = async () => {
  if ((liveClaude || liveCodex) && process.env.FAKE_NO_LIVE) {
    process.stderr.write("error: unknown option '--input-format' (this CLI has no live mode)\n");
    process.exit(2);
  }
  // A slow start (hooks, plugins, MCP), once per process: what a live process pays once instead of every turn.
  if (process.env.FAKE_STARTUP_MS) await sleep(Number(process.env.FAKE_STARTUP_MS));
  if (liveClaude) return runLiveClaude();
  if (liveCodex) return runLiveCodex();
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
  await runTurn({ prompt, sessionId, resumed, live: false });
};

/** Lines from stdin, one at a time, until it closes. */
const eachLine = async (handle) => {
  let carry = "";
  const queue = [];
  let running = false;
  let ended = false;
  const drain = async () => {
    if (running) return;
    running = true;
    while (queue.length) await handle(queue.shift());
    running = false;
    if (ended) process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    carry += chunk;
    let index = carry.indexOf("\n");
    while (index !== -1) {
      const line = carry.slice(0, index).trim();
      carry = carry.slice(index + 1);
      if (line) queue.push(line);
      index = carry.indexOf("\n");
    }
    void drain();
  });
  process.stdin.on("end", () => {
    ended = true;
    void drain();
    if (!running && !queue.length) process.exit(0);
  });
};

/** `claude -p --input-format stream-json --replay-user-messages`: a user message per turn, on one process. */
const runLiveClaude = async () => {
  const sid = args.indexOf("--session-id");
  const res = args.indexOf("--resume");
  const resumedAtStart = res >= 0;
  const sessionId = resumedAtStart ? args[res + 1] : args[sid + 1];
  if (resumedAtStart && !existsSync(sessionFile(sessionId))) {
    process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    process.exit(1);
  }
  let done = 0;
  await eachLine(async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type !== "user") return;
    const content = message.message?.content;
    const prompt = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
    out({ type: "user", uuid: message.uuid, isReplay: true, session_id: sessionId, message: { role: "user", content: prompt } });
    await runTurn({ prompt, sessionId, resumed: resumedAtStart || done > 0, live: true });
    done += 1;
  });
};

/** `codex app-server`: JSON-RPC over stdio; the turn's events are the exec ones, in app-server's shapes. */
const runLiveCodex = async () => {
  let threadId = null;
  let done = 0;
  const rpc = (value) => rawOut(value);
  const tokenUsage = { inputTokens: 12, cachedInputTokens: 2, outputTokens: 6, reasoningOutputTokens: 0, totalTokens: 18 };
  const translate = (event) => {
    const base = { threadId, turnId: `turn-${done + 1}` };
    switch (event.type) {
      case "turn.started":
        return rpc({ method: "turn/started", params: { threadId, turn: { id: base.turnId, status: "inProgress" } } });
      case "item.started":
      case "item.completed": {
        const item = event.item;
        const method = event.type === "item.started" ? "item/started" : "item/completed";
        if (item.type === "command_execution") {
          return rpc({
            method,
            params: {
              ...base,
              item: { type: "commandExecution", id: item.id, command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}), status: item.status === "in_progress" ? "inProgress" : item.status === "failed" ? "failed" : "completed", aggregatedOutput: item.aggregated_output ?? "", exitCode: item.exit_code ?? null },
            },
          });
        }
        if (item.type === "file_change") {
          return rpc({ method, params: { ...base, item: { type: "fileChange", id: item.id, status: "completed", changes: item.changes.map((change) => ({ path: change.path, kind: { type: change.kind }, diff: "" })) } } });
        }
        if (item.type === "agent_message") {
          rpc({ method: "item/started", params: { ...base, item: { type: "agentMessage", id: item.id, text: "", phase: "final_answer" } } });
          rpc({ method: "item/agentMessage/delta", params: { ...base, itemId: item.id, delta: item.text } });
          return rpc({ method: "item/completed", params: { ...base, item: { type: "agentMessage", id: item.id, text: item.text, phase: "final_answer" } } });
        }
        return;
      }
      case "turn.completed":
        rpc({ method: "thread/tokenUsage/updated", params: { ...base, tokenUsage: { total: tokenUsage, last: tokenUsage } } });
        if (process.env.FAKE_RATE_LIMITS) rpc({ method: "account/rateLimits/updated", params: { rateLimits: codexRateLimits("camel") } });
        return rpc({ method: "turn/completed", params: { threadId, turn: { id: base.turnId, status: "completed", error: null } } });
      case "turn.failed":
        rpc({ method: "error", params: { ...base, willRetry: false, error: { message: event.error.message } } });
        return rpc({ method: "turn/completed", params: { threadId, turn: { id: base.turnId, status: "failed", error: { message: event.error.message } } } });
      default:
    }
  };
  out = translate;
  let resumedAtStart = false;
  await eachLine(async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "initialize") return rpc({ id: message.id, result: { userAgent: "fake-codex" } });
    if (message.method === "thread/start") {
      threadId = randomUUID();
      return rpc({ id: message.id, result: { thread: { id: threadId } } });
    }
    if (message.method === "thread/resume") {
      if (!existsSync(sessionFile(message.params.threadId))) {
        return rpc({ id: message.id, error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` } });
      }
      threadId = message.params.threadId;
      resumedAtStart = true;
      return rpc({ id: message.id, result: { thread: { id: threadId } } });
    }
    if (message.method === "turn/start") {
      const prompt = (message.params.input ?? []).map((part) => part.text ?? "").join("");
      rpc({ id: message.id, result: { turn: { id: `turn-${done + 1}`, status: "inProgress" } } });
      await runTurn({ prompt, sessionId: threadId, resumed: resumedAtStart || done > 0, live: true });
      done += 1;
    }
  });
};

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(3);
});
