import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMentions } from "../../internal/agora/prompts.js";
import { unquoted } from "../../internal/agora/quote.js";
import { quoteMarkdown, withQuotes, type Quote } from "../../ui/src/lib/quote.js";

const quoted: Quote = { id: "m12", author: "claude", label: "Claude", text: "@claude, ask @all about this." };
const handles = ["codex", "claude", "ivan"];

test("a source-linked quote preserves the draft and sends only its explicit recipients", () => {
  const draft = "@codex, compare these claims.\nMy second line stays.";
  const sent = withQuotes(draft, [quoted]);
  assert.ok(sent.endsWith(`\n\n${draft}`), "the draft is sent unchanged after the quote");
  assert.ok(sent.includes("[Claude · m12](#m12)"), "the source message stays navigable");
  assert.ok(sent.includes(quoted.text), "the selected words stay in the agent's context");
  assert.deepEqual(parseMentions(sent, handles), ["codex"]);
});

test("all quote line endings stay inert, including restored CR text and Unicode separators", () => {
  for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
    const sent = withQuotes("@codex, explain.", [{ ...quoted, text: `Source${separator}@all${separator}@ivan` }]);
    assert.deepEqual(parseMentions(sent, handles), ["codex"], `quoted separator ${JSON.stringify(separator)}`);
  }
});

test("a multiline source label cannot turn its contents into recipients", () => {
  const sent = withQuotes("@codex, explain.", [{ ...quoted, label: "Claude\r\n@all\n@ivan" }]);
  assert.deepEqual(parseMentions(sent, handles), ["codex"]);
});

test("a selected code passage retains indentation and whitespace in its quoted lines", () => {
  const sent = quoteMarkdown({ ...quoted, text: "if ready:\n    run()\n    \n  keep_two_spaces()" });
  assert.ok(sent.includes(">     run()"), "Python indentation must not be trimmed from the selected source");
  assert.ok(sent.includes(">     \n"), "a whitespace-only source line must not be dropped");
  assert.ok(sent.includes(">   keep_two_spaces()"));
});

test("multiple citations with no new address retain broadcast semantics and their source order", () => {
  const second: Quote = { id: "m13", author: "codex", label: "Codex", text: "> @ivan\n\n@all" };
  const sent = withQuotes("What do you think?", [quoted, second]);
  assert.deepEqual(parseMentions(sent, handles), []);
  assert.ok(sent.indexOf("#m12") < sent.indexOf("#m13"));
  assert.ok(sent.endsWith("What do you think?"));
  assert.deepEqual(parseMentions(quoteMarkdown(second), handles), []);
});

test("the room preview shows the new question, while quote-only messages keep a preview", () => {
  const draft = "@codex, what do you think?";
  assert.equal(unquoted(withQuotes(draft, [quoted, { ...quoted, id: "m13" }])), draft);
  const justQuote = quoteMarkdown(quoted);
  assert.equal(unquoted(justQuote), justQuote);
  const ordinary = "My answer comes first.\n\n> Earlier context";
  assert.equal(unquoted(ordinary), ordinary);
});
