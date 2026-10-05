import test from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "../../ui/node_modules/mdast-util-from-markdown/index.js";
import { toHast } from "../../ui/node_modules/mdast-util-to-hast/index.js";
import { remarkLiteralHtml } from "../../ui/src/components/md/remark-literal-html.js";

test("workflow prose retains literal HTML tags and the explanation that follows them", () => {
  const text = "Перевірено **код**. Я вставив лише <script> артефакту в заглушку, а не весь файл.\n\n<style> is a literal reference, too.";
  const tree = fromMarkdown(text);
  remarkLiteralHtml()(tree);
  const rendered = toHast(tree)!;
  const values: string[] = [];
  const tags: string[] = [];
  const walk = (node: any) => {
    if (node.type === "text") values.push(node.value);
    if (node.tagName) tags.push(node.tagName);
    for (const child of node.children ?? []) walk(child);
  };
  walk(rendered);
  assert(values.join("").includes("<script> артефакту в заглушку, а не весь файл."));
  assert(values.join("").includes("<style> is a literal reference, too."));
  assert(tags.includes("strong"), "Markdown emphasis remains formatted");
  assert(!tags.includes("script") && !tags.includes("style"));
});

test("literal HTML mode preserves code fences and inline code exactly", () => {
  const tree = fromMarkdown('Inspect `<script>`.\n\n```html\n<button onclick="run()">Go</button>\n```');
  const original = structuredClone(tree);
  remarkLiteralHtml()(tree);
  assert.deepEqual(tree, original);
});
