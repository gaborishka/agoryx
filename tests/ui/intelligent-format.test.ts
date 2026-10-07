import assert from "node:assert/strict";
import { test } from "node:test";
import { compareIntelligentValues, formatIntelligentValue } from "../../ui/src/lib/intelligent-format.js";

test("small, fractional and large inputs preserve their meaningful digits", () => {
  for (const value of [0.04, 0.01, 0.00123, 1234.56789, 1000000000000.125]) {
    assert.equal(formatIntelligentValue(value), value.toLocaleString(undefined, { maximumSignificantDigits: 21 }));
  }
  assert.notEqual(formatIntelligentValue(1e-25), "0");
  assert.notEqual(formatIntelligentValue(0.04, 1), "0");
  assert.equal(formatIntelligentValue(-0), "0");
});

test("display distinguishes unavailable, false and empty authored text", () => {
  assert.equal(formatIntelligentValue(null), "Unavailable");
  assert.equal(formatIntelligentValue(Infinity), "Unavailable");
  assert.equal(formatIntelligentValue(false), "No");
  assert.equal(formatIntelligentValue(""), "");
});

test("table sorting is numeric and unavailable cells stay last both ways", () => {
  assert.deepEqual([10, null, 2, 0, -3].sort((a, b) => compareIntelligentValues(a, b, "asc")), [-3, 0, 2, 10, null]);
  assert.deepEqual([10, null, 2, 0, -3].sort((a, b) => compareIntelligentValues(a, b, "desc")), [10, 2, 0, -3, null]);
  assert(compareIntelligentValues("item 2", "item 10", "asc") < 0);
});
