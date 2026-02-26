import test from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  getAdapterConfig,
  DEFAULT_CONFIG,
  resolveAgentSkills,
  toRuntimeConfig,
} from "../../internal/config/index.js";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

test("skills merge: config skills override defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        codex: { skills: ["code", "custom-skill"] },
      },
    }),
  );

  const config = loadConfig(configPath);
  const skills = resolveAgentSkills(config);

  assert.deepEqual(skills.codex, ["code", "custom-skill"]);
  assert.ok(skills.claude.length > 0, "claude should have default skills");
  assert.ok(skills.claude.includes("review"), "claude defaults should include review");

  rmSync(dir, { recursive: true });
});

test("skills merge: agent without skills gets defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        codex: { mode: "cli" },
      },
    }),
  );

  const config = loadConfig(configPath);
  const skills = resolveAgentSkills(config);

  assert.ok(skills.codex.includes("code"), "codex should get default skills");
  assert.ok(skills.codex.includes("debug"), "codex should get default skills");

  rmSync(dir, { recursive: true });
});

test("skills merge: new agent without skills gets empty array", () => {
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
  const skills = resolveAgentSkills(config);

  assert.deepEqual(skills.gemini, []);

  rmSync(dir, { recursive: true });
});

test("skills merge: mixed-case and whitespace skills are normalized", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: {
        codex: { skills: ["Review", " Code ", "DEBUG"] },
      },
    }),
  );

  const config = loadConfig(configPath);
  const skills = resolveAgentSkills(config);

  assert.deepEqual(skills.codex, ["review", "code", "debug"]);

  rmSync(dir, { recursive: true });
});

test("workspace config merges partial overrides with defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspace: {
        enabled: false,
        diffLines: 10,
      },
    }),
  );

  const config = loadConfig(configPath);
  assert.equal(config.workspace.enabled, false);
  assert.equal(config.workspace.diffLines, 10);
  // Defaults preserved for unset fields
  assert.equal(config.workspace.statusLines, DEFAULT_CONFIG.workspace.statusLines);
  assert.equal(config.workspace.treeLines, DEFAULT_CONFIG.workspace.treeLines);
  assert.equal(config.workspace.pinnedDocCharsPerFile, DEFAULT_CONFIG.workspace.pinnedDocCharsPerFile);

  rmSync(dir, { recursive: true });
});

test("workspace config propagates to ChatRuntimeConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      workspace: {
        treeLines: 50,
      },
    }),
  );

  const config = loadConfig(configPath);
  const runtime = toRuntimeConfig(config);
  assert.ok(runtime.workspace, "runtime config should have workspace section");
  assert.equal(runtime.workspace.treeLines, 50);
  assert.equal(runtime.workspace.enabled, true); // default

  rmSync(dir, { recursive: true });
});

test("team config merge applies overrides and keeps trigger defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      team: {
        profile: "strict",
        maxSteps: 5,
        strict: {
          maxSteps: 3,
        },
        trigger: {
          autoOnMessage: false,
        },
      },
    }),
  );

  const config = loadConfig(configPath);
  assert.equal(config.team.maxSteps, 5);
  assert.equal(config.team.profile, "strict");
  assert.equal(config.team.strict.maxSteps, 3);
  assert.equal(config.team.trigger.autoOnMessage, false);
  assert.equal(config.team.trigger.commandStart, true);

  const runtime = toRuntimeConfig(config);
  assert.equal(runtime.team.maxSteps, 5);
  assert.equal(runtime.team.profile, "strict");
  assert.equal(runtime.team.strict.maxSteps, 3);
  assert.equal(runtime.team.trigger.commandStart, true);

  rmSync(dir, { recursive: true });
});

test("team checkCommands rejects unsafe commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-"));
  const configPath = join(dir, "agoryx.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      team: {
        checkCommands: [
          "npm run typecheck",
          "npm test && rm -rf /",
        ],
      },
    }),
  );

  assert.throws(() => {
    loadConfig(configPath);
  }, /Invalid team\.checkCommands entry/i);

  rmSync(dir, { recursive: true });
});

test("loadConfig auto-detects legacy ./agoryx.json in cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-legacy-cwd-"));
  const previousCwd = process.cwd();
  try {
    const legacyPath = join(dir, "agoryx.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        defaultMode: "auto",
      }),
    );
    process.chdir(dir);

    const config = loadConfig();
    assert.equal(config.defaultMode, "auto");
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig falls back to XDG config path when legacy file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "agoryx-test-xdg-config-"));
  const xdgConfigHome = join(dir, "xdg-config");
  const xdgConfigDir = join(xdgConfigHome, "agoryx");
  const xdgConfigPath = join(xdgConfigDir, "config.json");
  const cwd = join(dir, "workspace");
  const previousCwd = process.cwd();
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;

  try {
    mkdirSync(xdgConfigDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      xdgConfigPath,
      JSON.stringify({
        defaultMode: "round-robin",
      }),
    );

    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.chdir(cwd);

    const config = loadConfig();
    assert.equal(config.defaultMode, "round-robin");
  } finally {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
