import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeEffortsFromHelp, codexModelsFromCache } from "../../internal/agora/models.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { resumeCommands } from "../../internal/agora/service.js";
import { readTranscript } from "../../internal/agora/transcript.js";
import type { TranscriptEntry, TranscriptTool } from "../../internal/agora/types.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const scratch = () => mkdtempSync(join(tmpdir(), "agora-transcript-"));
const jsonl = (lines: unknown[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
const tools = (entries: TranscriptEntry[]) => entries.filter((e): e is TranscriptTool => e.kind === "tool");
const TS = "2026-09-29T10:00:00.000Z";

// --- Claude Code -------------------------------------------------------------------------

const claudeSession = () => [
  { type: "queue-operation", operation: "enqueue", timestamp: TS },
  { type: "user", uuid: "u1", timestamp: TS, message: { role: "user", content: "You are Claude, in an Agoryx room called R.\n\nnew in the room: …" } },
  { type: "assistant", uuid: "a1", timestamp: TS, message: { id: "msg1", role: "assistant", content: [{ type: "thinking", thinking: "Let me look first." }] } },
  { type: "assistant", uuid: "a2", timestamp: TS, message: { id: "msg1", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la", description: "List files" } }] } },
  { type: "user", uuid: "u2", timestamp: TS, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "README.md\nsrc" }] } },
  { type: "assistant", uuid: "a3", timestamp: TS, message: { id: "msg2", role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "/ws/a.txt", old_string: "one", new_string: "two" } }] } },
  {
    type: "user",
    uuid: "u3",
    cwd: "/ws",
    timestamp: TS,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "The file /ws/a.txt has been updated. Here's the result of running `cat -n`…" }] },
    toolUseResult: { filePath: "/ws/a.txt", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-one", "+two"] }] },
  },
  { type: "assistant", uuid: "a4", timestamp: TS, message: { id: "msg3", role: "assistant", content: [{ type: "tool_use", id: "tu3", name: "Read", input: { file_path: "/ws/missing" } }] } },
  { type: "user", uuid: "u4", timestamp: TS, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu3", is_error: true, content: "File does not exist." }] } },
  {
    type: "assistant",
    uuid: "a5",
    timestamp: TS,
    message: { id: "msg4", role: "assistant", content: [{ type: "tool_use", id: "tu4", name: "TodoWrite", input: { todos: [{ content: "Write it", status: "completed" }, { content: "Test it", status: "in_progress" }] } }] },
  },
  {
    type: "user",
    uuid: "u5",
    timestamp: TS,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu4", content: "Todos have been modified" }] },
    toolUseResult: { newTodos: [{ content: "Write it", status: "completed" }, { content: "Test it", status: "in_progress" }] },
  },
  // A subagent's own lines are its session, not this one's.
  { type: "assistant", uuid: "s1", isSidechain: true, timestamp: TS, message: { id: "side", role: "assistant", content: [{ type: "text", text: "sidechain" }] } },
  { type: "assistant", uuid: "a6", timestamp: TS, message: { id: "msg5", role: "assistant", content: [{ type: "text", text: "Done: **two** now." }] } },
  { type: "assistant", uuid: "a7", timestamp: TS, message: { id: "msg5", role: "assistant", content: [{ type: "text", text: "Anything else?" }] } },
  { type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: TS },
  { type: "user", uuid: "u6", timestamp: TS, message: { role: "user", content: "hi, straight in the terminal" } },
  { type: "user", uuid: "u7", timestamp: TS, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
];

test("a Claude Code session reads as the terminal shows it: prompts, thinking, tools with results, edits as diffs, todos", () => {
  const dir = scratch();
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, jsonl(claudeSession()));
    const t = readTranscript("claude", file);
    assert.equal(t.start, 0);
    assert.equal(t.end, t.size);
    assert.deepEqual(
      t.entries.map((e) => e.kind),
      ["user", "thinking", "tool", "tool", "tool", "tool", "assistant", "system", "user", "system"],
    );
    const [prompt] = t.entries;
    assert.ok(prompt?.kind === "user" && prompt.agoryx, "the room's own prompt is marked, so the view can fold it");
    const [bash, edit, read, todo] = tools(t.entries);
    assert.equal(bash!.category, "command");
    assert.equal(bash!.status, "ok");
    assert.equal(bash!.output, "README.md\nsrc");
    assert.equal(edit!.category, "edit");
    assert.equal(edit!.diffs?.length, 1);
    assert.equal(edit!.diffs![0]!.path, "a.txt", "a path in the session's folder is shown relative to it");
    assert.match(edit!.diffs![0]!.patch, /^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1,1 \+1,1 @@\n-one\n\+two/m);
    assert.equal(edit!.output, undefined, "an applied edit is its diff");
    assert.equal(read!.status, "fail");
    assert.equal(read!.output, "File does not exist.");
    assert.deepEqual(todo!.todos, [
      { text: "Write it", status: "completed" },
      { text: "Test it", status: "in_progress" },
    ]);
    const reply = t.entries.find((e) => e.kind === "assistant");
    assert.equal(reply?.kind === "assistant" && reply.text, "Done: **two** now.\n\nAnything else?", "one API message reads as one reply");
    assert.ok(!JSON.stringify(t.entries).includes("sidechain"));
    assert.deepEqual(
      t.entries.filter((e) => e.kind === "system").map((e) => e.kind === "system" && e.code),
      ["compacted", "interrupted"],
    );
    const human = t.entries.filter((e) => e.kind === "user")[1];
    assert.ok(human?.kind === "user" && human.text === "hi, straight in the terminal" && !human.agoryx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a long session is read from its end, and older pages continue exactly where the last one began", () => {
  const dir = scratch();
  try {
    const file = join(dir, "long.jsonl");
    const lines = Array.from({ length: 200 }, (_, i) => ({
      type: "assistant",
      uuid: `a${i}`,
      timestamp: TS,
      message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `reply ${i} ${"x".repeat(200)}` }] },
    }));
    writeFileSync(file, jsonl(lines));
    const whole = readTranscript("claude", file).entries.map((e) => e.id);
    assert.equal(whole.length, 200);
    const pages: string[][] = [];
    let page = readTranscript("claude", file, { window: 8000 });
    assert.ok(page.start > 0 && page.entries.length < 200);
    pages.unshift(page.entries.map((e) => e.id));
    while (page.start > 0) {
      page = readTranscript("claude", file, { end: page.start, window: 8000 });
      pages.unshift(page.entries.map((e) => e.id));
    }
    assert.deepEqual(pages.flat(), whole, "no entry is lost or shown twice across pages");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lines the view skips, even one longer than the window, never leave a page empty or stuck", () => {
  const dir = scratch();
  try {
    const file = join(dir, "rollout.jsonl");
    const item = (id: number) => ({ timestamp: TS, type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: `i${id}`, content: [{ type: "Text", text: `reply ${id}` }] } } });
    // Codex keeps a code-mode tool's raw output too; the view shows the items, so these lines add nothing.
    const raw = (size: number) => ({ timestamp: TS, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c", output: "x".repeat(size) } });
    writeFileSync(file, jsonl([...Array.from({ length: 40 }, (_, i) => item(i)), raw(20_000), item(40), raw(5_000), raw(5_000), raw(5_000), item(41)]));
    const whole = readTranscript("codex", file).entries.map((e) => e.id);
    assert.equal(whole.length, 42);
    let page = readTranscript("codex", file, { window: 8000 });
    assert.ok(page.entries.length >= 30, `the first page reaches back past the raw output (${page.entries.length})`);
    const pages = [page.entries.map((e) => e.id)];
    while (page.start > 0) {
      const before = page.start;
      page = readTranscript("codex", file, { end: before, window: 8000 });
      assert.ok(page.start < before, "every older page moves back");
      pages.unshift(page.entries.map((e) => e.id));
    }
    assert.deepEqual(pages.flat(), whole);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Codex -------------------------------------------------------------------------------

test("a Codex rollout reads as Codex shows it: commands with exit codes, patches, plans, commentary", () => {
  const dir = scratch();
  try {
    const file = join(dir, "rollout.jsonl");
    const item = (value: Record<string, unknown>) => ({ timestamp: TS, type: "event_msg", payload: { type: "item_completed", item: value } });
    writeFileSync(
      file,
      jsonl([
        { timestamp: TS, type: "session_meta", payload: { id: "t1" } },
        // The raw response items repeat what the items say: only the items are read.
        { timestamp: TS, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "dup" }] } },
        item({ type: "UserMessage", id: "i1", content: [{ type: "text", text: "[agoryx · R] new in the room" }] }),
        item({ type: "Reasoning", id: "i2", summary_text: ["Checking the tree"] }),
        item({ type: "AgentMessage", id: "i3", phase: "commentary", content: [{ type: "Text", text: "Looking at the files." }] }),
        item({ type: "CommandExecution", id: "i4", command: ["/bin/zsh", "-lc", "npm test"], exit_code: 1, aggregated_output: "1 failing", status: "completed" }),
        item({
          type: "FileChange",
          id: "i5",
          status: "completed",
          changes: { "new.txt": { type: "add", content: "hello\n" }, "old.txt": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n" } },
        }),
        item({ type: "TodoList", id: "i6", items: [{ text: "Fix test", completed: false }] }),
        item({ type: "AgentMessage", id: "i7", phase: "final_answer", content: [{ type: "Text", text: "Fixed." }] }),
        { timestamp: TS, type: "event_msg", payload: { type: "turn_aborted" } },
      ]),
    );
    const t = readTranscript("codex", file);
    assert.deepEqual(
      t.entries.map((e) => e.kind),
      ["user", "thinking", "assistant", "tool", "tool", "tool", "assistant", "system"],
    );
    assert.ok(t.entries[0]!.kind === "user" && t.entries[0]!.agoryx);
    assert.ok(t.entries[2]!.kind === "assistant" && t.entries[2]!.commentary);
    const [command, patch] = tools(t.entries);
    assert.equal(command!.title, "npm test");
    assert.equal(command!.status, "fail");
    assert.equal(command!.detail, "exit 1");
    assert.equal(command!.output, "1 failing");
    assert.deepEqual(
      patch!.diffs!.map((d) => [d.path, d.op]),
      [
        ["new.txt", "add"],
        ["old.txt", "update"],
      ],
    );
    assert.match(patch!.diffs![0]!.patch, /\+hello/);
    assert.match(patch!.diffs![1]!.patch, /^--- a\/old\.txt\n\+\+\+ b\/old\.txt\n@@ -1 \+1 @@/);
    assert.ok(!JSON.stringify(t.entries).includes('"dup"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools without a view of their own say what they are about; a generated image is shown", () => {
  const dir = scratch();
  try {
    // 1×1 PNG.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    writeFileSync(join(dir, "ig_1.png"), Buffer.from(png, "base64"));
    const item = (value: Record<string, unknown>) => ({ timestamp: TS, type: "event_msg", payload: { type: "item_completed", item: value } });
    const codex = join(dir, "rollout.jsonl");
    writeFileSync(
      codex,
      jsonl([
        { timestamp: TS, type: "session_meta", payload: { cwd: dir } },
        item({ type: "Extension", kind: "image_gen.generation", id: "g1", status: "generating", revisedPrompt: "Use case: logo\nA fox", result: png, savedPath: join(dir, "ig_1.png") }),
        item({ type: "Extension", kind: "image_gen.generation", id: "g2", status: "failed", revisedPrompt: "A cat", result: "", failure: null }),
        item({ type: "Extension", kind: "clock.sleep", id: "s1", durationMs: 20000 }),
        item({ type: "Extension", kind: "web.search", id: "w1", query: "https://example.com/a", action: { type: "openPage", url: "https://example.com/a" }, results: [{ title: "A", url: "https://example.com/a" }] }),
        item({ type: "Extension", kind: "web.search", id: "w2", query: "", action: { type: "other" }, results: [{ title: "B", url: "https://example.com/b.pdf" }] }),
        item({ type: "McpToolCall", id: "m1", server: "cua", tool: "repl", arguments: { code: "open()", title: "Open the review map" }, status: "completed", result: { content: [] } }),
      ]),
    );
    const tools = readTranscript("codex", codex).entries as TranscriptTool[];
    const [made, failed, sleep, opened, other, mcp] = tools;
    assert.equal(made!.tool, "image");
    assert.equal(made!.title, "ig_1.png");
    assert.equal(made!.status, "ok");
    assert.match(made!.images![0]!.src!, /^data:image\/png;base64,/);
    assert.match(made!.input!, /A fox/);
    assert.equal(failed!.status, "fail");
    assert.equal(failed!.images, undefined);
    assert.deepEqual([sleep!.tool, sleep!.title], ["sleep", "20 s"]);
    assert.deepEqual([opened!.tool, opened!.title], ["open page", "https://example.com/a"]);
    assert.equal(other!.title, "https://example.com/b.pdf");
    assert.deepEqual([mcp!.tool, mcp!.title], ["cua.repl", "Open the review map"]);

    const claude = join(dir, "claude.jsonl");
    const use = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: id, timestamp: TS, message: { id, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    writeFileSync(claude, jsonl([use("t1", "ToolSearch", { query: "select:WebFetch", max_results: 1 }), use("t2", "mcp__plugin_context7_context7__resolve-library-id", { libraryName: "react" })]));
    const [search, lib] = readTranscript("claude", claude).entries as TranscriptTool[];
    assert.deepEqual([search!.tool, search!.title], ["ToolSearch", "select:WebFetch"]);
    assert.deepEqual([lib!.tool, lib!.title], ["context7.resolve-library-id", "react"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an older Codex rollout without items still shows its calls and their output", () => {
  const dir = scratch();
  try {
    const file = join(dir, "old.jsonl");
    writeFileSync(
      file,
      jsonl([
        { timestamp: TS, type: "event_msg", payload: { type: "user_message", message: "fix the build" } },
        { timestamp: TS, type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "make"] }) } },
        { timestamp: TS, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "ok\n" }) } },
        { timestamp: TS, type: "event_msg", payload: { type: "agent_message", message: "Built." } },
        { timestamp: TS, type: "event_msg", payload: { type: "agent_message", message: "::pass:: nothing to add" } },
      ]),
    );
    const t = readTranscript("codex", file);
    assert.deepEqual(
      t.entries.map((e) => e.kind),
      ["user", "tool", "assistant", "assistant"],
    );
    const pass = t.entries.at(-1)!;
    assert.ok(pass.kind === "assistant" && pass.pass && pass.text === "nothing to add", "a pass reads as one, with its note");
    const [call] = tools(t.entries);
    assert.equal(call!.title, "make");
    assert.equal(call!.status, "ok");
    assert.equal(call!.output, "ok\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- models ------------------------------------------------------------------------------

test("the models and efforts on offer come from the CLIs' own help and model cache", () => {
  assert.deepEqual(claudeEffortsFromHelp("  --effort <level>   Effort level for the session (low, medium, high, xhigh, max)\n"), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(claudeEffortsFromHelp("no such flag"), null);
  assert.deepEqual(
    codexModelsFromCache({
      models: [
        { slug: "gpt-6", display_name: "GPT-6", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high" },
        { slug: "hidden-model", visibility: "hide" },
        { nope: true },
      ],
    }),
    [{ id: "gpt-6", label: "GPT-6", efforts: ["low", "high"], defaultEffort: "high" }],
  );
  assert.deepEqual(codexModelsFromCache({}), []);
});

// --- changing an agent's model and effort ------------------------------------------------

test("another model or effort for an agent is said in the room and reaches its CLI from the next turn", async () => {
  const room = createTestRoom();
  try {
    room.engine.postHuman("@claude hi");
    await withTimeout(room.engine.waitIdle());
    const agent = room.engine.updateAgent("claude", { model: "opus", effort: "high" });
    assert.deepEqual([agent.model, agent.effort], ["opus", "high"]);
    const change = room.store.events.find((event) => event.type === "agent.changed");
    assert.ok(change && change.type === "agent.changed" && change.by === room.store.state.human, "who changed it is recorded");
    const note = room.store.state.messages.at(-1)!;
    assert.match(note.text, /set Claude to model opus, effort high/);
    assert.equal(room.engine.updateAgent("claude", { model: "opus" }), room.store.state.agents[0], "no change, no event");
    assert.equal(room.store.events.filter((event) => event.type === "agent.changed").length, 1);

    room.engine.postHuman("@claude again");
    await withTimeout(room.engine.waitIdle());
    const args = room.invocations("claude").at(-1)!.args!;
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "opus"]);
    assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
    assert.ok(args.includes("--resume"), "the same session goes on with the new model");
    const session = room.store.state.sessions.claude!.sessionId;
    assert.match(
      resumeCommands(room.store, { claude: createClaudeRunner("claude") }).claude!,
      new RegExp(`--resume ${session} --model opus --effort high$`),
      "the human's own resume goes on with the same model and effort",
    );
    assert.match(createCodexRunner("codex").resumeCommand("t1", "/ws", "gpt-6", "high"), / resume t1 -m gpt-6 -c 'model_reasoning_effort="high"'$/);

    room.engine.updateAgent("claude", { model: null, effort: "" });
    const back = room.store.state.agents.find((a) => a.id === "claude")!;
    assert.equal(back.model, undefined);
    assert.equal(back.effort, undefined);
    assert.match(room.store.state.messages.at(-1)!.text, /the CLI's default model, the CLI's default effort/);

    assert.throws(() => room.engine.updateAgent("nobody", { model: "opus" }), /no agent @nobody/);
    assert.throws(() => room.engine.updateAgent("codex", { model: "--dangerously" }), /not a model name/);
    assert.throws(() => room.engine.updateAgent("codex", { model: "gpt x" }), /not a model name/);
    assert.throws(() => room.engine.updateAgent("codex", { effort: 'high" -c x="y' }), /not an effort level/);
  } finally {
    await room.cleanup();
  }
});
