import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkflowArtifacts,
  resolveArtifactReference,
  safeArtifactPath,
  visualArtifact,
} from "../../ui/src/lib/workflow-artifacts.js";

test("executor named exports recover exact UTF-8 contents and filenames from untyped variable fences", () => {
  const html = "<!doctype html>\n<h1>Привіт</h1>\n";
  const notes =
    "Examples include ```html and ```` inside text.\nKeep this last newline.\n";
  const text = `Finished.\n\nArtifact: pages/index.html\n\`\`\`\n${html}\n\`\`\`\n\nArtifact: docs/notes.md\n\`\`\`\`\`\n${notes}\n\`\`\`\`\``;
  const files = parseWorkflowArtifacts(text);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0], {
    path: "pages/index.html",
    downloadName: "index.html",
    language: "html",
    text: html,
  });
  assert.deepEqual(files[1], {
    path: "docs/notes.md",
    downloadName: "notes.md",
    language: "markdown",
    text: notes,
  });
});

test("ordinary typed fences and CRLF parse without stealing artifact headers inside code", () => {
  const text =
    "```html\r\n<h1>A</h1>\r\n```\r\n\n```typescript\nconst caption = `Artifact: fake.html`;\n```\n\n~~~svg\n<svg></svg>\n~~~";
  const files = parseWorkflowArtifacts(text);
  assert.deepEqual(
    files.map((file) => file.language),
    ["html", "typescript", "svg"],
  );
  assert.equal(files[0]!.text, "<h1>A</h1>");
  assert.equal(files[1]!.text, "const caption = `Artifact: fake.html`;");
  assert.equal(files[1]!.downloadName, "artifact-2.ts");
});

test("unsafe named exports are never downloadable and cannot become preview dependencies", () => {
  for (const path of [
    "../../escape.html",
    "/private/file.html",
    "C:\\private\\file.html",
    "https://example.com/file.html",
    "folder/../escape.html",
    "bad\u0000.html",
  ]) {
    assert.equal(safeArtifactPath(path), null);
    assert.deepEqual(
      parseWorkflowArtifacts(`Artifact: ${path}\n\`\`\`html\nsecret\n\`\`\``),
      [],
    );
  }
  assert.equal(
    parseWorkflowArtifacts("Artifact: subdir/CON.txt\n```\na\n```")[0]!
      .downloadName,
    "artifact-CON.txt",
  );
  assert.equal(
    parseWorkflowArtifacts("Artifact: subdir/a:b.html\n```\na\n```")[0]!
      .downloadName,
    "a_b.html",
  );
});

test("only closed code blocks are artifacts, preserving embedded shorter fences", () => {
  assert.deepEqual(parseWorkflowArtifacts("```html\nunfinished"), []);
  assert.deepEqual(
    parseWorkflowArtifacts("```\nuntyped ordinary prose\n```"),
    [],
  );
  const file = parseWorkflowArtifacts("````html\n<div>\n```\n</div>\n````")[0]!;
  assert.equal(file.text, "<div>\n```\n</div>");
  assert.equal(file.language, "html");
});

test("bundle references resolve nested local files but never escape or request external URLs", () => {
  assert.equal(
    resolveArtifactReference("pages/index.html", "../styles/app.css?v=1#x"),
    "styles/app.css",
  );
  assert.equal(
    resolveArtifactReference("pages/index.html", "/assets/logo.svg"),
    "assets/logo.svg",
  );
  assert.equal(
    resolveArtifactReference("pages/index.html", "../assets/hello%20world.svg"),
    "assets/hello world.svg",
  );
  for (const reference of [
    "../../outside.css",
    "https://example.com/a.js",
    "//example.com/a.js",
    "data:text/html,test",
    "#local",
    "%2f%2fexample.com/a.js",
    "..%5csecret.css",
  ])
    assert.equal(resolveArtifactReference("pages/index.html", reference), null);
});

test("visual selection prefers named index HTML over earlier snippets and ignores code-only bundles", () => {
  const files = parseWorkflowArtifacts(
    "```svg\n<svg/>\n```\nArtifact: index.html\n```\n<main>App</main>\n```",
  );
  assert.equal(visualArtifact(files)?.path, "index.html");
  assert.equal(
    visualArtifact(parseWorkflowArtifacts("```python\nprint(1)\n```")),
    undefined,
  );
});

test("named exports form the download bundle without echoed source or verification snippets", () => {
  const files = parseWorkflowArtifacts([
    "```html\n<h1>Echoed draft</h1>\n```",
    '```json\n{"checks":["passed"]}\n```',
    "Artifact: index.html\n```\n<h1>Named draft</h1>\n```",
    "Artifact: index.html\n```\n<h1>Final file</h1>\n\n```",
  ].join("\n\n"));
  assert.deepEqual(files.map(({path,text}) => ({path,text})), [
    {path: "index.html", text: "<h1>Final file</h1>\n"},
  ]);
});

test("a named multi-file preview inlines only returned CSS, JavaScript, and SVG dependencies", async () => {
  const { bundleArtifactHtml } = await import(
    "../../ui/src/lib/workflow-artifacts.js"
  );
  const source = [
    [
      "pages/index.html",
      '<link rel="stylesheet" href="../styles/app.css"><script src="../app.js"></script><img src="../logo.svg"><script src="https://example.com/tracker.js"></script>',
    ],
    [
      "styles/app.css",
      'body { background-image: url("../logo.svg"); color: blue }',
    ],
    [
      "app.js",
      'document.body.dataset.ready = "yes"; const closing = "</script>";',
    ],
    [
      "logo.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
    ],
  ]
    .map(([path, text]) => `Artifact: ${path}\n\`\`\`\n${text}\n\`\`\``)
    .join("\n\n");
  const files = parseWorkflowArtifacts(source);
  const html = bundleArtifactHtml(files, visualArtifact(files)!);
  assert.ok(html.includes("<style>body {"));
  assert.ok(html.includes('document.body.dataset.ready = "yes"'));
  assert.ok(html.includes('const closing = "<\\/script>"'));
  assert.equal(html.match(/data:image\/svg\+xml/g)?.length, 2);
  assert.ok(
    html.includes('src="https://example.com/tracker.js"'),
    "external reference stays subject to CSP, never fetched by the bundler",
  );
});

test("preview wrapper escapes generated markup behind independent sandbox and navigation policy", async () => {
  const { artifactPreviewDocument } = await import(
    "../../ui/src/lib/workflow-artifacts.js"
  );
  const files = parseWorkflowArtifacts(
    '```html\n<h1 title="\'&quot;">Test</h1><script>window.location="https://example.com"</script>\n```',
  );
  const doc = artifactPreviewDocument(files, files[0]!);
  assert.ok(doc.includes("frame-src about:"));
  assert.ok(doc.includes('sandbox="allow-scripts"'));
  assert.ok(doc.includes("frame-src &#39;none&#39;"));
  assert.ok(doc.includes("&amp;quot;"));
  assert.ok(
    doc.includes(
      "&lt;script&gt;window.location=&quot;https://example.com&quot;&lt;/script&gt;",
    ),
  );
  assert.equal((doc.match(/<iframe/g) ?? []).length, 1);
  assert.equal(
    (doc.match(/<script/g) ?? []).length,
    0,
    "untrusted scripts never appear in trusted outer markup",
  );
});

test("named executor files preserve a trailing carriage return exactly", () => {
  const original = "text ending with CR\r";
  const file = parseWorkflowArtifacts(
    `Artifact: notes.txt\n\`\`\`\n${original}\n\`\`\``,
  )[0]!;
  assert.equal(file.text, original);
});
