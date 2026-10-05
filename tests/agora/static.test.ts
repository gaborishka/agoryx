import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { cacheControl, pickEncoding, staticBody } from "../../internal/agora/static.js";

test("text goes brotli, else gzip, when the browser takes it; small files and images go as they are", () => {
  assert.equal(pickEncoding("/a/index-1.js", 5000, "gzip, deflate, br, zstd"), "br");
  assert.equal(pickEncoding("/a/index-1.js", 5000, "gzip, deflate"), "gzip");
  assert.equal(pickEncoding("/a/index-1.js", 5000, "br;q=0, gzip"), "gzip");
  assert.equal(pickEncoding("/a/index-1.js", 5000, "identity"), null);
  assert.equal(pickEncoding("/a/index-1.js", 5000, undefined), null);
  assert.equal(pickEncoding("/a/index-1.js", 200, "br"), null);
  assert.equal(pickEncoding("/a/logo.png", 50_000, "br"), null);
  assert.equal(pickEncoding("/a/x.woff2", 50_000, "gzip"), null);
});

test("hashed assets are kept for good; the page, the worker and the manifest are asked again", () => {
  assert.equal(cacheControl("assets/index-zCAqgtzC.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControl("index.html"), "no-store");
  assert.equal(cacheControl("sw.js"), "no-cache");
  assert.equal(cacheControl("manifest.webmanifest"), "no-cache");
});

test("a file is compressed once per version, and a changed file is compressed again", () => {
  const dir = mkdtempSync(join(tmpdir(), "agora-static-"));
  try {
    const file = join(dir, "app.js");
    writeFileSync(file, "const a = 1;\n".repeat(500));
    const br = staticBody(file, "br");
    assert.equal(brotliDecompressSync(br).toString(), "const a = 1;\n".repeat(500));
    assert.ok(br.length < 500);
    assert.equal(staticBody(file, "br"), br, "the same buffer: compressed once");
    assert.equal(gunzipSync(staticBody(file, "gzip")).toString(), "const a = 1;\n".repeat(500));
    writeFileSync(file, "const b = 2;\n".repeat(600));
    assert.equal(brotliDecompressSync(staticBody(file, "br")).toString(), "const b = 2;\n".repeat(600));
    assert.equal(staticBody(file, null).toString(), "const b = 2;\n".repeat(600));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
