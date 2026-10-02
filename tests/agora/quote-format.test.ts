import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMentions } from "../../internal/agora/prompts.js";
import { unquoted } from "../../internal/agora/quote.js";
import { fromMarkdown } from "../../ui/node_modules/mdast-util-from-markdown/index.js";
import { gfmFromMarkdown } from "../../ui/node_modules/mdast-util-gfm/index.js";
import { gfm } from "../../ui/node_modules/micromark-extension-gfm/index.js";
import { parseMarkdownIntoBlocks } from "../../ui/node_modules/streamdown/dist/index.js";
import { messageRefId, remarkAgora, wholeBlocks } from "../../ui/src/components/md/remark-agora.js";
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

// m61 in room P10: Claude wrote about `@all` and `@claude` in backticks and the room read both as addresses.
const P10_M61 = [
  "@codex P8 готовий: обидва твої зауваження з m57 виправив і перевірив у демо.",
  "- `@cl` + Tab вставляє `@claude`.",
  "- Вставка в середину тексту: `Ask (@codex) …`, курсор стає після імені.",
  "- Вибраний файл стає чіпом. `@all` у назві файлу нікого не кличе.",
  "Так у мене пішло `@claude read @queue`, хоча я хотів вставити файл.",
].join("\n");

test("code names no one: an @handle in inline code or a fenced block is shown, not said", () => {
  assert.deepEqual(parseMentions(P10_M61, ["codex", "claude"]), ["codex"]);
  assert.deepEqual(parseMentions("Run this:\n\n```sh\nagoryx say \"@all done\"\n```\n\n@claude, check it.", ["codex", "claude"]), ["claude"]);
  assert.deepEqual(parseMentions("~~~\n@codex\n~~~~\n@claude", ["codex", "claude"]), ["claude"], "a tilde fence closes on a run at least as long");
  assert.deepEqual(parseMentions("````\n```\n@codex\n```\n````\n@claude", ["codex", "claude"]), ["claude"], "a shorter run inside a fence does not close it");
  assert.deepEqual(parseMentions("```\n@codex never closed", ["codex"]), [], "an open fence runs to the end");
  assert.deepEqual(parseMentions("``a ` @codex`` and @claude", ["codex", "claude"]), ["claude"], "a double-backtick span holds a single backtick");
  assert.deepEqual(parseMentions("```inline``` @codex", ["codex"]), ["codex"], "backticks in the info string: inline code, not a fence");
  assert.deepEqual(parseMentions("a`x`@codex", ["codex"]), ["codex"], "a code span ends a word, as the page shows it");
  assert.deepEqual(parseMentions("it's `odd\n\n@codex and `this", ["codex"]), ["codex"], "a span does not cross a blank line");
  assert.deepEqual(parseMentions("Example:\n\n    @codex do it\n\n@claude", ["codex", "claude"]), ["claude"], "an indented code block");
  assert.deepEqual(parseMentions("Run it,\n    @codex then check", ["codex"]), ["codex"], "an indented line that carries on a paragraph is prose");
});

test("a code span stays in its paragraph, heading or table cell, and an escaped backtick opens none", () => {
  const handles = ["codex", "claude"];
  assert.deepEqual(parseMentions("- Run `npm test` and `npm run lint\n- @codex check `foo` too", handles), ["codex"], "a list item starts a block");
  assert.deepEqual(parseMentions("# Title `x\n@codex body` y", handles), ["codex"], "a heading is a line of its own");
  assert.deepEqual(parseMentions("Setup `x\n***\n@codex y` z", handles), ["codex"], "a rule ends a paragraph");
  assert.deepEqual(parseMentions("| cmd | note |\n|---|---|\n| `ls | grep @codex` | x |", handles), ["codex"], "a pipe ends a cell, even in backticks");
  assert.deepEqual(parseMentions("Use \\`@codex\\` literally", handles), ["codex"]);
  assert.deepEqual(parseMentions("Use \\\\`@codex` literally", handles), [], "an escaped backslash escapes nothing after it");
  assert.deepEqual(parseMentions("> run `agoryx say\n\"@all done\"` to finish", handles), [], "a span runs on from a quote into the line markdown continues it with");
  assert.deepEqual(parseMentions("- use `npm i\n  then @codex` check", handles), [], "and within one item's paragraph");
  assert.deepEqual(parseMentions("Run `x, @codex\n> quoted\nso `y` it is", handles), ["codex"], "a quote breaks into a paragraph");
});

test("a long message is read in time that grows with its length, not with its square", () => {
  // 20 000 quoted lines with a code span each are one paragraph: once 2.5 s, each span walking every line.
  const long = Array.from({ length: 20_000 }, () => "> `q` @codex").join("\n");
  const started = performance.now();
  assert.deepEqual(parseMentions(long, ["codex"]), []);
  assert.deepEqual(parseMentions(`${"`a` ".repeat(20_000)}@codex`, ["codex"]), ["codex"]);
  // Runs of 1, 2, 3… backticks, none closed: each opener once read the rest of the text for its closer (3.2 s).
  let runs = "";
  for (let k = 1; runs.length < 1_000_000; k += 1) runs += "`".repeat(k) + " x ";
  assert.deepEqual(parseMentions(`${runs}@codex`, ["codex"]), ["codex"]);
  assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} ms`);
  // A line of a few megabytes of a rule, a delimiter row or quote marks once overflowed the stack in a regex.
  for (const line of ["-".repeat(3_500_000), "|-".repeat(1_750_000), ">".repeat(3_500_000), "* ".repeat(2_000_000)]) {
    assert.deepEqual(parseMentions(`x\n${line}\n@codex`, ["codex"]), ["codex"]);
  }
});

test("on the page an @handle inside a quote stays plain text; outside it is a mention", () => {
  const tree = {
    type: "root",
    children: [
      { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "@codex said P3" }] }] },
      { type: "paragraph", children: [{ type: "text", value: "@codex, see P3" }] },
    ],
  };
  remarkAgora()(tree);
  const quote = tree.children[0]!.children[0]!.children;
  assert.deepEqual(quote.map((node: { type: string }) => node.type), ["text", "link"], "the table ref still links; the handle does not");
  assert.equal((quote[0] as { value: string }).value, "@codex said ");
  const said = tree.children[1]!.children;
  assert.equal((said[0] as { url: string }).url, "#@codex");
});

test("a fence indented under a list item, and a bare CR, end where the page ends them", () => {
  const listed = "2. Run it:\n\n    ```sh\n    agoryx say \"@all done\"\n\n    agoryx read new\n    ```\n\n@codex";
  assert.deepEqual(parseMentions(listed, ["codex"]), ["codex"], "@all in a list item's fenced block wakes no one");
  assert.deepEqual(parseMentions("hi\r> @codex", ["codex"]), [], "a bare CR starts the quoted line");
  assert.deepEqual(parseMentions("hi\r@codex", ["codex"]), ["codex"]);
  // A ``` in a code block's text, or in an indented line of prose, neither closes nor opens one.
  const nested = "```py\ndef f():\n    s = \"\"\"\n    ```\n    \"\"\"\n```\n\n@codex thoughts?";
  assert.deepEqual(parseMentions(nested, ["codex"]), ["codex"]);
  assert.deepEqual(parseMentions("Use triple backticks like\n    ```\nto open a block. @codex check?", ["codex"]), ["codex"]);
  assert.deepEqual(parseMentions("- ```sh\n  agoryx say \"@all\"\n  ```\n\n@codex", ["codex"]), ["codex"], "a fence on the item's own line");
  // A fence in a nested item may sit at its parent item's column; a line left of the item ends the fence with it.
  const nestedItem = "1. Run it:\n    - first this\n    ```sh\n    agoryx say \"@all done\"\n\n    agoryx read new\n    ```\n\n@codex";
  assert.deepEqual(parseMentions(nestedItem, ["codex"]), ["codex"]);
  assert.deepEqual(parseMentions("- a\n  ```\n  code\n\n@codex after", ["codex"]), ["codex"]);
  // A lazy line carries on the item's paragraph, so the item's column still holds for the fence after it.
  assert.deepEqual(parseMentions("1.  Step\nlazy\n    ```\n    @claude\n\n    x\n    ```\n@codex", ["codex", "claude"]), ["codex"]);
  assert.deepEqual(parseMentions("-\n\n    a\n\n2. b\n\n    @codex", ["codex"]), ["codex"], "an empty item a blank line ended holds no code under it");
  assert.deepEqual(parseMentions(">\t\t>x\n\t@codex", ["codex"]), [], "a tab after > runs to its stop: the second > is past four columns, so the quote holds indented code");
  assert.deepEqual(parseMentions(">\t\t>`\n@codex`", ["codex"]), ["codex"]);
  assert.deepEqual(parseMentions(">  >~~~\n>`\n@codex`", ["codex"]), [], "a fence two quotes in closes on a line one quote in");
  assert.deepEqual(parseMentions(">  >```\n>x\n    @codex", ["codex"]), ["codex"]);
});

// What the page tints, read from the real markdown trees the renderer gets, with their source. A posted message
// is parsed whole; only the live stream is split into blocks.
const whole = (text: string) => [text];
const streamed = wholeBlocks(parseMarkdownIntoBlocks);
const tinted = (text: string, split = whole): string[] => {
  const handles: string[] = [];
  const visit = (node: { type: string; url?: string; align?: unknown[]; children?: never[] }) => {
    if (node.type === "link" && node.url?.startsWith("#@")) handles.push(node.url.slice(2));
    // A table row shows as many cells as the header has; the HTML drops the rest.
    if (node.type === "table") for (const row of node.children ?? []) for (const cell of (row as { children: never[] }).children.slice(0, node.align!.length)) visit(cell);
    else for (const child of node.children ?? []) visit(child);
  };
  for (const block of split(text)) {
    // As the renderer reads it: with GFM, whose autolinks split a text into nodes with no position.
    const tree = fromMarkdown(block, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as { type: string };
    remarkAgora()(tree as never, { value: block });
    visit(tree as never);
  }
  return [...new Set(handles)].sort();
};

test("the page tints exactly the @handles that wake: a line markdown only continues into a quote still wakes", () => {
  const handles = ["codex", "claude"];
  for (const text of [
    "> what you said\n@codex can you check?",
    "> @claude wrote this\n> and @codex this",
    "> *quoted* @claude\nand @codex, yours?",
    "> a\n>\n> @claude\n\n@codex",
    "- > @claude in a list's quote",
    "> quoted \"www.x.io\"\n@codex",
    "> see www.x.io and *this*\n@codex, @claude?",
    "> hi &#10;@codex",
    // A quote's nested quote or list that a line runs on from.
    "> - point one\n> - point two @codex\nAgreed with both.",
    "> > @codex wrote\n> @claude replied\nI side with codex",
    "> 1. step @claude\n> 2. step\nI'd skip 2, @codex",
    // A deeper quote starts a paragraph of its own, so no span runs into it; four columns in, > is only text.
    "> run `x\n> > nested\nthen `@codex` here",
    "> x `a\n    > > y\n@codex` b",
    // A quote left of the list its paragraph is in starts a quote of its own.
    "- > x\n> y `a\n@codex` b",
    // Fences and spans, as the page draws their ends.
    "1. Run:\n   ```sh\n   agoryx say \"@all\"\n```\n@codex check",
    "- a\n  ```\n  code\n\n@codex after",
    "1. Run it:\n    - first this\n    ```sh\n    agoryx say \"@all done\"\n\n    agoryx read new\n    ```\n\n@codex",
    "1.  Step\nlazy\n    ```\n    @claude\n\n    x\n    ```\n@codex",
    "- Run `npm test` and `npm run lint\n- @codex check `foo` too",
    "# Title `x\n@codex body` y",
    "| cmd | note |\n|---|---|\n| `ls | grep @codex` | x |",
    "Use \\`@codex\\` literally",
    "> run `agoryx say\n\"@all done\"` to finish",
    "Example:\n\n    @codex do it\n\n@claude",
    "Run `x, @codex\n> quoted\nso `y` it is",
    // More than four spaces after a marker: the item's text is indented code.
    "-     a @codex\n  b",
    // An item's text may start a table, whose cells end its spans; a cell past the header's is not shown.
    "- | cmd | owner |\n  |---|---|\n  | `@claude | b` | @codex |",
    "| a |\n|---|\n| x | @codex |",
    "a | b\n--|--\nx | y | @codex\n@claude | `q|`",
    // Right under indented code a list starts from 1 only, so `2.` is a paragraph and its fence is not in an item.
    "---\n    @codex x\n2. two\n   ```\n  b` @claude",
    // An item with nothing on its line ends at a blank line.
    "-\n\n    @codex",
    "-\n  @codex",
    // An item's text starts a table only when it is text, not a quote, a heading or another marker.
    "- >`\n  -|\n@claude`",
    "- # x\n  -|\n  `a\n  @codex`",
    "- 2.\n  -|\n\ta|@claude",
    // A delimiter row needs a pipe or a colon, and is not an item's marker.
    "x|`\n- |-\n-||@codex",
    "a | b\n- | -\nc | d @codex",
    "|h\n-:\n|`a\n@codex`",
    // Indented code holds a list from 2 off across blank lines, not past the quote or item the line closed.
    "    code\n\n2. ```\n   @codex",
    ">\n    code\n2. ```\n   @codex",
    "10.   a\n\n    x\n2. ```\n   @codex",
    // Quotes nest with up to four columns between their marks; four columns in, a > is the paragraph's text.
    ">  > x `a\n> > y\n@codex` b",
    "> x `a\n>  > y\n@codex` b",
    "> - x `a\n>   > y\n@codex` b",
    ">`\n    >\n@claude`",
    "> a `\n    >\n@claude`",
    // An empty item a blank line ended no longer holds the indented code under it; quote marks count columns, tabs to
    // their stop; a fence opened two quotes in closes when the line leaves its quote.
    "-\n\n    a\n\n2. b\n\n    @codex",
    ">\t\t>x\n\t@codex",
    ">\t\t>`\n@codex`",
    ">  >~~~\n>`\n@codex`",
    ">  >```\n>x\n    @codex",
    // The item a blank line ended is left on the next line, quoted or not; a quote in an item counts its tabs
    // from the item's column; a fence in a quote closes only at its own nesting.
    "-\n\n>\n\n    a\n\n2. b\n\n    @codex",
    "-\n\n> q\n\n    a\n2. ```\n   @codex",
    "1. >   \t>`@codex\n   > > `",
    "1. >   \t>`\n   >>`\n@codex`",
    ">```\n>>```\n>`\n    @codex",
    ">```\n> > ```\n> `\n@codex`",
  ]) assert.deepEqual(tinted(text), parseMentions(text, handles).sort(), JSON.stringify(text));
  // The live stream is split into blocks as marked splits it, which would lose the line that says which lines
  // are quoted in these, so they are parsed whole there too.
  for (const text of ["> - point one\n> - point two @codex\nAgreed with both.", "> > @codex wrote\n> @claude replied\nI side with codex", "> 1. step @claude\n> 2. step\nI'd skip 2, @codex"]) {
    assert.notDeepEqual(parseMarkdownIntoBlocks(text).join(""), text);
    assert.deepEqual(streamed(text), [text]);
    assert.deepEqual(tinted(text, streamed), parseMentions(text, handles).sort(), JSON.stringify(text));
  }
  // Where a break written as &NewLine; hides which source line a handle is on, the page leans to plain text:
  // it may miss a handle that wakes, never tint one that does not.
  const doubtful = "> hi &NewLine;@codex\nand @claude";
  assert.deepEqual(parseMentions(doubtful, handles), ["claude"]);
  assert.deepEqual(tinted(doubtful), []);
  assert.deepEqual(tinted("> what you said\n@codex can you check?"), ["codex"]);
});

test("a message link is #m and digits; #methods, #main and #metrics are ordinary anchors", () => {
  assert.equal(messageRefId("#m12"), "m12");
  for (const href of ["#methods", "#main", "#metrics", "#m12a", "#m", "m12", undefined]) assert.equal(messageRefId(href), null, String(href));
});
