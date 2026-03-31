import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isFeatureEnabled,
  setFeatureOverride,
  clearFeatureOverride,
  clearAllFeatureOverrides,
  listFeatureFlags,
} from "../../internal/config/features.js";
import type { FeatureFlag } from "../../internal/config/features.js";

afterEach(() => {
  clearAllFeatureOverrides();
  delete process.env.AGORYX_FF_HOOK_SYSTEM;
  delete process.env.AGORYX_FF_GEMINI_ADAPTER;
});

describe("feature flags defaults", () => {
  it("all defaults are false", () => {
    const flags = listFeatureFlags();
    for (const [name, value] of Object.entries(flags)) {
      assert.equal(value, false, `${name} should default to false`);
    }
  });
});

describe("setFeatureOverride", () => {
  it("makes flag return true", () => {
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), false);
    setFeatureOverride("HOOK_SYSTEM", true);
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), true);
  });

  it("can set flag to false explicitly", () => {
    setFeatureOverride("HOOK_SYSTEM", true);
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), true);
    setFeatureOverride("HOOK_SYSTEM", false);
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), false);
  });
});

describe("clearFeatureOverride", () => {
  it("restores default after clearing", () => {
    setFeatureOverride("GEMINI_ADAPTER", true);
    assert.equal(isFeatureEnabled("GEMINI_ADAPTER"), true);
    clearFeatureOverride("GEMINI_ADAPTER");
    assert.equal(isFeatureEnabled("GEMINI_ADAPTER"), false);
  });
});

describe("clearAllFeatureOverrides", () => {
  it("resets all overrides", () => {
    setFeatureOverride("GEMINI_ADAPTER", true);
    setFeatureOverride("HOOK_SYSTEM", true);
    setFeatureOverride("RISK_LEVELS", true);
    clearAllFeatureOverrides();
    assert.equal(isFeatureEnabled("GEMINI_ADAPTER"), false);
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), false);
    assert.equal(isFeatureEnabled("RISK_LEVELS"), false);
  });
});

describe("environment variable support", () => {
  it("AGORYX_FF_HOOK_SYSTEM=1 enables flag", () => {
    process.env.AGORYX_FF_HOOK_SYSTEM = "1";
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), true);
  });

  it("AGORYX_FF_HOOK_SYSTEM=true enables flag", () => {
    process.env.AGORYX_FF_HOOK_SYSTEM = "true";
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), true);
  });

  it("unknown env values return false", () => {
    const unknownValues = ["0", "false", "yes", "no", "on", "off", "enabled", ""];
    for (const val of unknownValues) {
      process.env.AGORYX_FF_HOOK_SYSTEM = val;
      assert.equal(
        isFeatureEnabled("HOOK_SYSTEM"),
        false,
        `env value "${val}" should resolve to false`,
      );
    }
  });
});

describe("override precedence over env var", () => {
  it("programmatic override takes precedence over env var", () => {
    process.env.AGORYX_FF_HOOK_SYSTEM = "1";
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), true);

    setFeatureOverride("HOOK_SYSTEM", false);
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), false);
  });

  it("clearing override falls back to env var", () => {
    process.env.AGORYX_FF_HOOK_SYSTEM = "1";
    setFeatureOverride("HOOK_SYSTEM", false);
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), false);

    clearFeatureOverride("HOOK_SYSTEM");
    assert.equal(isFeatureEnabled("HOOK_SYSTEM"), true);
  });
});

describe("listFeatureFlags", () => {
  it("returns all known flags", () => {
    const flags = listFeatureFlags();
    const expectedFlags: FeatureFlag[] = [
      "GEMINI_ADAPTER",
      "OLLAMA_ADAPTER",
      "MCP_INTEGRATION",
      "CONTEXT_CACHE",
      "MESSAGE_SNIPPING",
      "DREAM_CONSOLIDATION",
      "HOOK_SYSTEM",
      "RISK_LEVELS",
    ];
    for (const flag of expectedFlags) {
      assert.ok(flag in flags, `listFeatureFlags should include ${flag}`);
    }
    assert.equal(Object.keys(flags).length, expectedFlags.length);
  });

  it("reflects overrides and env vars in output", () => {
    setFeatureOverride("GEMINI_ADAPTER", true);
    process.env.AGORYX_FF_HOOK_SYSTEM = "1";

    const flags = listFeatureFlags();
    assert.equal(flags.GEMINI_ADAPTER, true);
    assert.equal(flags.HOOK_SYSTEM, true);
    assert.equal(flags.OLLAMA_ADAPTER, false);
  });
});
