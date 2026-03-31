import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoApprove } from "../../internal/engine/auto-approve.js";
import type { RiskLevel } from "../../internal/engine/risk-classifier.js";

const ALL_LEVELS: RiskLevel[] = ["low", "medium", "high"];

describe("shouldAutoApprove", () => {
  it('policy "none" — nothing auto-approved', () => {
    for (const level of ALL_LEVELS) {
      assert.equal(shouldAutoApprove(level, "none"), false, `expected ${level} to be rejected`);
    }
  });

  it('policy "low" — only LOW auto-approved', () => {
    assert.equal(shouldAutoApprove("low", "low"), true);
    assert.equal(shouldAutoApprove("medium", "low"), false);
    assert.equal(shouldAutoApprove("high", "low"), false);
  });

  it('policy "medium" — LOW and MEDIUM auto-approved', () => {
    assert.equal(shouldAutoApprove("low", "medium"), true);
    assert.equal(shouldAutoApprove("medium", "medium"), true);
    assert.equal(shouldAutoApprove("high", "medium"), false);
  });

  it('policy "all" — everything auto-approved', () => {
    for (const level of ALL_LEVELS) {
      assert.equal(shouldAutoApprove(level, "all"), true, `expected ${level} to be approved`);
    }
  });
});
