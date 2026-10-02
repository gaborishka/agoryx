import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import { parseMentions } from "../../internal/agora/mentions.js";
import { unquoted } from "../../internal/agora/quote.js";
import { clearSentComposerDraft, composerChoices, composerCommand, composerDraftSnapshot, composerHistory, composerTrigger, historyBoundary, historyStep, recallSent, replaceComposerToken, savedContextFiles, withContextFiles } from "../../ui/src/lib/composer-context.js";
import { quoteAddressee, withQuotes, type Quote } from "../../ui/src/lib/quote.js";
import { localPath, remarkAgora } from "../../ui/src/components/md/remark-agora.js";
import type { RoomMessage } from "../../ui/src/lib/types.js";

const atEnd = (text: string) => composerTrigger(text, text.length);

test("suggestions use the collapsed caret and ignore emails, quoted text and code", () => {
  for (const text of ["me@cla", "@@cla", "> @cla", "  > @cla", "```ts\n@cla", "~~~~\n@cla", "look `@cla"]) assert.equal(atEnd(text), null, text);
  assert.equal(composerTrigger("@cla", 1, 4), null);
  assert.equal(atEnd("```\ncode\n```\n@cla")?.query, "cla");
  assert.equal(atEnd("look (@cla")?.start, 6);
  assert.equal(atEnd("check @ui/Україна")?.query, "ui/Україна");
});

test("inserting a participant in the middle preserves the rest of the draft and punctuation", () => {
  const draft = "Ask (@clau) about this.\nKeep this line.";
  const trigger = composerTrigger(draft, 8)!;
  const next = replaceComposerToken(draft, trigger, "@claude");
  assert.equal(next.text, "Ask (@claude) about this.\nKeep this line.");
  assert.equal(next.caret, "Ask (@claude".length);
  assert.equal(replaceComposerToken("@cl", atEnd("@cl")!, "@claude").text, "@claude ");
});

test("participant and file hits stay distinct even when their names coincide", () => {
  const choices = composerChoices(atEnd("@cod"), [{ id: "codex", label: "Codex" }], ["docs/codex.md", "codex", "src/other.ts"]);
  assert.deepEqual(choices.map((c) => [c.kind, c.value]), [["participant", "codex"], ["file", "codex"], ["file", "docs/codex.md"]]);
  const draft = "look @cod now";
  assert.equal(replaceComposerToken(draft, composerTrigger(draft, 9)!, "").text, "look  now");
});

test("slash suggestions are restricted to the start; multiline and unknown slash text stay messages", () => {
  assert.equal(atEnd("explain /st"), null);
  assert.equal(atEnd("/st")?.kind, "command");
  assert.deepEqual(composerChoices(atEnd("/st"), [], []).map((c) => c.value), ["stop"]);
  assert.deepEqual(composerCommand(" /doc docs/My file.md "), { id: "doc", args: "docs/My file.md" });
  assert.deepEqual(composerCommand("/add codex"), { id: "add", args: "codex" });
  for (const text of ["/tmp/path", "/unknown words", "Please /stop", "/stop\nexplain why"]) assert.equal(composerCommand(text), null, text);
});

test("workspace file source paths round-trip through Markdown and never add recipients", () => {
  const path = "docs/@all [a](b)%?# Україна.md";
  const sent = withContextFiles("@codex, read this.", [path]);
  assert.ok(sent.startsWith("> File: [` docs/@all [a](b)%?# Україна.md `]"));
  assert.deepEqual(parseMentions(sent, ["all", "codex", "claude"]), ["codex"]);
  assert.equal(unquoted(sent), "@codex, read this.");
  const tokens = marked.lexer(sent);
  const links: string[] = [];
  marked.walkTokens(tokens, (token) => { if (token.type === "link") links.push(token.href); });
  assert.equal(links.length, 1);
  const url = links[0]!;
  const node = { type: "link", url, children: [{ type: "text", value: path }] };
  remarkAgora()(node);
  assert.equal(localPath(node.url), path);
  assert.ok(withContextFiles("", [path]).includes("@all"));
});

test("malformed restored file contexts cannot inject lines or leave the workspace", () => {
  const values = ["ok.ts", "ok.ts", "../secret", "/abs", "x\n@all", "x\r@all", "x\u2028@all", null, { path: "wrong" }];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify(values) } });
  try {
    assert.deepEqual(savedContextFiles("room"), ["ok.ts"]);
    assert.equal(withContextFiles("draft", values as string[]), "> File: [` ok.ts `](ok.ts)\n\n> File: [` ok.ts `](ok.ts)\n\ndraft");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("history recalls only room messages from the human, in reverse order", () => {
  const msg = (kind: RoomMessage["kind"], author: string, text: string, native = false) => ({ kind, author, text, ...(native ? { native: { agent: "codex" } } : {}) }) as RoomMessage;
  const messages = [msg("human", "ivan", "first"), msg("agent", "codex", "agent answer"), msg("system", "ivan", "notice"), msg("human", "other", "other person"), msg("human", "ivan", "direct session", true), msg("human", "ivan", "second"), msg("human", "ivan", " ")];
  assert.deepEqual(composerHistory(messages, "ivan"), ["second", "first"]);
  assert.equal(historyStep(-1, "older", 2), 0);
  assert.equal(historyStep(0, "older", 2), 1);
  assert.equal(historyStep(1, "older", 2), 1);
  assert.equal(historyStep(0, "newer", 2), -1);
  assert.equal(historyStep(-1, "older", 0), -1);
});

test("a completed send clears only its room's unchanged saved draft, preserving edits made while pending", () => {
  const values = new Map<string, string>([["agoryx.draft.old", "sent"], ["agoryx.quotes.old", "quotes"], ["agoryx.contextFiles.old", "files"], ["agoryx.draft.new", "new room draft"]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) } });
  try {
    const sent = composerDraftSnapshot("old");
    clearSentComposerDraft(sent);
    assert.deepEqual([...values.values()], ["new room draft"]);
    values.set("agoryx.draft.old", "first draft");
    const pending = composerDraftSnapshot("old");
    values.set("agoryx.draft.old", "edited after navigation");
    clearSentComposerDraft(pending);
    assert.equal(values.get("agoryx.draft.old"), "edited after navigation");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("history arrows leave multiline messages only at the relevant outer line", () => {
  const text = "first\nmiddle\nlast";
  assert.equal(historyBoundary(text, 3, 3, "older"), true);
  assert.equal(historyBoundary(text, 8, 8, "older"), false);
  assert.equal(historyBoundary(text, 8, 8, "newer"), false);
  assert.equal(historyBoundary(text, 15, 15, "newer"), true);
  assert.equal(historyBoundary(text, 0, 3, "older"), false);
});

test("↑ brings a sent message back as it was composed: its quotes and files as chips, its words as the draft", () => {
  const words: Quote = { id: "m12", author: "claude", label: "Claude · Opus", text: "first line\n@all second" };
  const code: Quote = { id: "m13", author: "codex", label: "Codex", text: "if x:\n    run()\n\n  done()" };
  const lines: Quote = { id: "t7", author: "codex", label: "Codex", text: "-old\n+new [x](y)", file: { path: "src/a [b].ts", lines: "old 11–12; new 11–13" } };
  const authors: Record<string, string> = { m12: "claude", m13: "codex", t7: "codex" };
  const authorOf = (id: string) => authors[id];
  const body = "@codex why?\n\n> not a quote of ours\n\nlast";
  const sent = withContextFiles(withQuotes(body, [words, code, lines]), ["docs/My file.md", "a/b.ts"]);
  const back = recallSent(sent, authorOf);
  assert.deepEqual(back.files, ["docs/My file.md", "a/b.ts"]);
  assert.deepEqual(back.quotes, [words, code, lines]);
  assert.equal(back.body, body);

  // Only what reads back exactly becomes a chip: a source the room no longer has, or hand-written quotes, stay text.
  const gone = recallSent(withQuotes("hi", [words]), () => undefined);
  assert.deepEqual(gone.quotes, []);
  assert.equal(gone.body, withQuotes("hi", [words]));
  assert.deepEqual(recallSent("> [Claude · m12](#m12)\n>\n> edited by hand\n\nhi", () => "claude").quotes.map((q) => q.text), ["edited by hand"]);
  assert.deepEqual(recallSent("> [Claude · m12](#m12)\n> edited by hand\n\nhi", () => "claude").quotes, [], "not as withQuotes writes it");
  assert.deepEqual(recallSent("> [Claude](#m12)\n> x\n\nhi", () => "claude").quotes, [], "a source without its id is not ours");
  assert.deepEqual(recallSent("plain words", authorOf), { body: "plain words", quotes: [], files: [] });
  assert.deepEqual(recallSent(withQuotes("", [words]), authorOf), { body: "", quotes: [words], files: [] });
});

test("one rule for both kinds of quote: they go to the agent who wrote them, never to the human or a shared file", () => {
  const agents = ["claude", "codex"];
  assert.equal(quoteAddressee({ id: "m12", author: "codex", label: "Codex", text: "x" }, agents), "codex");
  assert.equal(quoteAddressee({ id: "t7", author: "claude", label: "Claude", text: "+x", file: { path: "a.ts", lines: "+1" } }, agents), "claude");
  assert.equal(quoteAddressee({ id: "t7", author: "claude", label: "Claude", text: "+x", file: { path: "a.ts", lines: "+1" } }, agents, true), undefined);
  assert.equal(quoteAddressee({ id: "m3", author: "Ivan", label: "Ivan", text: "mine" }, agents), undefined);
});
