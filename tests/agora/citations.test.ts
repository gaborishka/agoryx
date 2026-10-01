import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMentions } from "../../internal/agora/prompts.js";
import { createTestRoom, withTimeout } from "./helpers.js";

const handles = ["claude", "codex", "ivan"];
const citation = "> [Claude · m12](#m12)\n>\n> @claude and @all please review.\n> @ivan which option?";

test("a cited message does not add recipients; the question outside it still does", () => {
  assert.deepEqual(parseMentions(`@codex explain this.\n\n${citation}`, handles), ["codex"]);
  assert.deepEqual(parseMentions(`${citation}\n\n@Codex, ask @CLAUDE; @codex again.`, handles), ["codex", "claude"]);
  assert.deepEqual(parseMentions(citation, handles), []);
});

test("quoted headers, nested quotes, indentation and CRLF do not activate mentions", () => {
  const text = [
    "> @claude · m12",
    ">>@all",
    "  > @ivan",
    "\t> @codex",
    "@ivan, your answer?",
  ].join("\r\n");
  assert.deepEqual(parseMentions(text, handles), ["ivan"]);
  assert.deepEqual(parseMentions("> A quoted Unicode separator\u2028@all\u2029@claude\n@codex?", handles), ["codex"]);
});

test("outside quotes, mention boundaries, unknown handles and broadcast retain their meaning", () => {
  assert.deepEqual(parseMentions("mail@claude @@codex @unknown @CLAUDE! @all @ivan @claude", handles), ["claude", "all", "ivan"]);
  assert.deepEqual(parseMentions("Compare a > @codex with b > @claude.", handles), ["codex", "claude"]);
  assert.deepEqual(parseMentions("@co\n> @all\ndex", handles), []);
  assert.deepEqual(parseMentions("Please ask (@codex), then [@claude].", handles), ["codex", "claude"]);
});

test("quoting @all in a human question to Codex does not start Claude, and Codex still sees the source", async () => {
  const room = createTestRoom();
  try {
    const message = room.engine.postHuman(`@codex explain this quote.\n\n${citation}`);
    await withTimeout(room.engine.waitIdle());
    assert.deepEqual(message.mentions, ["codex"]);
    assert.equal(room.invocations("codex").length, 1);
    assert.equal(room.invocations("claude").length, 0);
    assert.ok(room.invocations("codex")[0]!.prompt!.includes(citation), "the complete quote remains in the agent's context");
  } finally {
    await room.cleanup();
  }
});

test("a quote in an agent's answer does not hand the turn to its quoted participants", async () => {
  const answer = `${citation}\n\nThat is the earlier proposal; my answer is yes.`;
  const room = createTestRoom({ rules: [{ agent: "codex", once: true, reply: answer }] });
  try {
    room.engine.postHuman("@codex cite the earlier proposal.");
    await withTimeout(room.engine.waitIdle());
    const message = room.store.state.messages.find((entry) => entry.kind === "agent" && entry.author === "codex")!;
    assert.equal(message.text, answer);
    assert.deepEqual(message.mentions, []);
    assert.equal(message.wakes, false);
    assert.equal(room.invocations("claude").length, 0);
    assert.equal(room.store.state.runs.at(-1)?.endReason, "quiet");
  } finally {
    await room.cleanup();
  }
});
