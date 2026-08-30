import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeTeamOutput } from "../../internal/rendering/sanitize.js";

test("sanitizeTeamOutput: strips system-reminder blocks", () => {
  const input = "Real content.\n<system-reminder>secret</system-reminder>\nMore content.";
  const result = sanitizeTeamOutput(input);
  assert.ok(!result.includes("system-reminder"));
  assert.ok(result.includes("Real content."));
  assert.ok(result.includes("More content."));
});

test("sanitizeTeamOutput: strips numbered dump lines", () => {
  const input = "Work done.\n42→some dumped line\nAll files updated.";
  const result = sanitizeTeamOutput(input);
  assert.ok(!result.includes("42→"));
  assert.ok(result.includes("All files updated."));
});

test("sanitizeTeamOutput: strips bridge log preamble", () => {
  const input = "Content.\nNow appending to the bridge log:\nFinal summary.";
  const result = sanitizeTeamOutput(input);
  assert.ok(!result.includes("appending to the bridge log"));
  assert.ok(result.includes("Final summary."));
});

test("sanitizeTeamOutput: strips Ukrainian process-chatter lines", () => {
  const input = "Зараз швидко перегляну README і далі перевіряю маршрути\nЗавдання виконано.";
  const result = sanitizeTeamOutput(input);
  assert.ok(!result.toLowerCase().includes("перегляну"));
  assert.ok(!result.toLowerCase().includes("перевіряю"));
  assert.ok(result.includes("Завдання виконано."));
});

test("sanitizeTeamOutput: returns empty string for empty input", () => {
  assert.equal(sanitizeTeamOutput(""), "");
});
