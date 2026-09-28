import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { embed, linkedMedia, mediaRefs } from "../../internal/agora/media.js";
import { localPath, remarkAgora } from "../../ui/src/components/md/remark-agora.js";
import { workspaceRel } from "../../ui/src/lib/format.js";

// Cases found by Claude and Codex reviewing this code in a room, and by two subagents on the same task.

test("an example inside code does not let the room serve a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-media-"));
  try {
    const file = join(dir, "private.csv");
    writeFileSync(file, "private");
    assert.equal(linkedMedia(["```md\n" + embed(file) + "\n```"], file), null);
    assert.equal(linkedMedia([`see \`${embed(file)}\``], file), null);
    assert.equal(linkedMedia([`see ${embed(file)}`], file), realpathSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("links count as markdown reads them: references, <spaces>, titles, parentheses", () => {
  assert.deepEqual(mediaRefs("![chart][plot]\n\n[plot]: /tmp/chart.png"), ["/tmp/chart.png"]);
  assert.deepEqual(mediaRefs("![chart](</tmp/my chart.png>)"), ["/tmp/my chart.png"]);
  assert.deepEqual(mediaRefs("![a](/tmp/a.png 'chart') ![b](/tmp/b.png (chart)) ![c](/tmp/c.png \"chart\")"), ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
  assert.deepEqual(mediaRefs("[page 2](/tmp/report.pdf#page=2) ![](file:///tmp/x%20y.png?v=1)"), ["/tmp/report.pdf", "/tmp/x y.png"]);
  assert.deepEqual(mediaRefs("![](~/pic.png) ![](//host/x.png) ![](https://x/y.png)"), [join(homedir(), "pic.png")]);
  assert.deepEqual(mediaRefs("<img src=\"/tmp/tag.png\" width=300>\n\n<video src='/tmp/v.mp4'></video> `<img src=\"/tmp/no.png\">`"), ["/tmp/tag.png", "/tmp/v.mp4"]);
  for (const name of ["/tmp/chart (1).png", "/tmp/a#b?c.png", "/tmp/100%20 sure.png", "/tmp/ніч.png"]) {
    assert.deepEqual(mediaRefs(embed(name)), [name], name);
  }
});

test("a path the daemon already decoded is not decoded again", () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-media-"));
  try {
    const file = join(dir, "chart%20final.png");
    writeFileSync(file, "PNG");
    // The UI percent-encodes the path; serveRaw decodes it once before asking.
    assert.equal(linkedMedia([embed(file)], decodeURIComponent(encodeURIComponent(file))), realpathSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the UI sends ~/ and outside paths to the outside route, and drops a #fragment", () => {
  const image = { type: "image", url: "~/chart.png" };
  remarkAgora()({ type: "root", children: [image] });
  assert.equal(localPath(image.url), "~/chart.png");
  assert.equal(workspaceRel("~/chart.png", "/project"), null);
  assert.equal(localPath("/@ws//tmp/report.pdf#page=2"), "/tmp/report.pdf");
  assert.equal(localPath("/@ws//tmp/a%23b.png"), "/tmp/a#b.png");
  // Decoded once already: a literal %25 in a workspace name stays.
  assert.equal(workspaceRel("plots/100%25.png", "/project"), "plots/100%25.png");
  assert.equal(workspaceRel("/project/out/a.png", "/project"), "out/a.png");
});
