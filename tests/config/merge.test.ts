import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, getAdapterConfig, DEFAULT_CONFIG } from "../../internal/config/index.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("partial agent config merges with defaults per-agent", () => {
  // Create a temp agoryx.json with only mode overridden for claude
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        claude: { mode: "cli" },
      },
    }),
  );

  const config = loadConfig(configPath);
  const claude = config.agents.claude;

  // The overridden field should apply
  assert.equal(claude.mode, "cli");

  // Default fields must be preserved, not undefined
  assert.equal(claude.adapter, "claude");
  assert.equal(typeof claude.timeoutMs, "number");
  assert.equal(typeof claude.maxTokens, "number");
  assert.ok(claude.timeoutMs > 0, "timeoutMs should be positive");
  assert.ok(claude.maxTokens > 0, "maxTokens should be positive");

  // Codex should remain untouched from defaults
  const codex = config.agents.codex;
  assert.deepEqual(codex, DEFAULT_CONFIG.agents.codex);

  rmSync(dir, { recursive: true });
});

test("partial agent config preserves adapter field", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        claude: { mode: "cli" },
      },
    }),
  );

  const config = loadConfig(configPath);
  const adapterCfg = getAdapterConfig(config, "claude");

  // mode should be overridden
  assert.equal(adapterCfg.mode, "cli");

  // timeoutMs and maxTokens must not be undefined
  assert.equal(adapterCfg.timeoutMs, DEFAULT_CONFIG.agents.claude.timeoutMs);
  assert.equal(adapterCfg.maxTokens, DEFAULT_CONFIG.agents.claude.maxTokens);

  rmSync(dir, { recursive: true });
});

test("new agent in config file gets validated defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        gemini: { adapter: "gemini", mode: "stub" },
      },
    }),
  );

  const config = loadConfig(configPath);
  const gemini = config.agents.gemini;

  // New agent should have required fields filled with sensible defaults
  assert.equal(gemini.adapter, "gemini");
  assert.equal(gemini.mode, "stub");
  assert.equal(typeof gemini.timeoutMs, "number");
  assert.equal(typeof gemini.maxTokens, "number");
  assert.ok(gemini.timeoutMs > 0, "timeoutMs should be positive");
  assert.ok(gemini.maxTokens > 0, "maxTokens should be positive");

  rmSync(dir, { recursive: true });
});
