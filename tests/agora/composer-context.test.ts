import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import { parseMentions } from "../../internal/agora/mentions.js";
import { unquoted } from "../../internal/agora/quote.js";
import { clearSentComposerDraft, composerChoices, composerCommand, composerDraftSnapshot, composerHistory, composerTrigger, historyBoundary, historyStep, replaceComposerToken, savedContextFiles, withContextFiles } from "../../ui/src/lib/composer-context.js";
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
