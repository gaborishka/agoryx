import test from "node:test";
import assert from "node:assert/strict";
import { parseTeamDebateControl } from "../../internal/engine/team-orchestrator.js";

test("parseTeamDebateControl: empty text returns no control", () => {
  const result = parseTeamDebateControl("");
  assert.equal(result.done, false);
  assert.equal(result.nextActor, null);
});

test("parseTeamDebateControl: whitespace-only text returns no control", () => {
  const result = parseTeamDebateControl("   \n  \n  ");
  assert.equal(result.done, false);
  assert.equal(result.nextActor, null);
});

test("parseTeamDebateControl: TEAM_DONE on last line", () => {
  const result = parseTeamDebateControl("I completed the task.\nTEAM_DONE");
  assert.equal(result.done, true);
  assert.equal(result.nextActor, null);
});

test("parseTeamDebateControl: TEAM_DONE case insensitive", () => {
  const result = parseTeamDebateControl("Done with work.\nteam_done");
  assert.equal(result.done, true);
});

test("parseTeamDebateControl: TEAM_DONE with trailing content", () => {
  const result = parseTeamDebateControl("Work is done.\nTEAM_DONE: task complete");
  assert.equal(result.done, true);
});

test("parseTeamDebateControl: TEAM_NEXT:codex on last line", () => {
  const result = parseTeamDebateControl("I reviewed the code.\nTEAM_NEXT:codex");
  assert.equal(result.done, false);
  assert.equal(result.nextActor, "codex");
});

test("parseTeamDebateControl: TEAM_NEXT with @ prefix", () => {
  const result = parseTeamDebateControl("Handing off.\nTEAM_NEXT:@claude");
  assert.equal(result.done, false);
  assert.equal(result.nextActor, "claude");
});

test("parseTeamDebateControl: TEAM_NEXT with spaces around colon", () => {
  const result = parseTeamDebateControl("Next step.\nTEAM_NEXT : codex");
  assert.equal(result.done, false);
  assert.equal(result.nextActor, "codex");
});

test("parseTeamDebateControl: TEAM_NEXT case insensitive", () => {
  const result = parseTeamDebateControl("Continuing.\nteam_next:Claude");
  assert.equal(result.done, false);
  assert.equal(result.nextActor, "claude");
});

test("parseTeamDebateControl: AGORYX_STOP on last line", () => {
  const result = parseTeamDebateControl("Something happened.\nAGORYX_STOP");
  assert.equal(result.done, true);
  assert.equal(result.nextActor, null);
});

test("parseTeamDebateControl: TEAM_STOP on last line", () => {
  const result = parseTeamDebateControl("Blocked.\nTEAM_STOP");
  assert.equal(result.done, true);
  assert.equal(result.nextActor, null);
});

test("parseTeamDebateControl: both TEAM_DONE and TEAM_NEXT — done wins", () => {
  const result = parseTeamDebateControl(
    "Almost there.\nTEAM_DONE\nTEAM_NEXT:codex",
  );
  assert.equal(result.done, true);
  assert.equal(result.nextActor, null);
});

test("parseTeamDebateControl: no control line in text", () => {
  const result = parseTeamDebateControl(
    "I implemented the feature and all tests pass.\nThe code looks good to me.",
  );
  assert.equal(result.done, false);
  assert.equal(result.nextActor, null);
});

test("parseTeamDebateControl: control mentioned mid-text is ignored (not in tail)", () => {
  const lines = [
    "When I see TEAM_DONE in the instructions, I should use it.",
    "Let me continue with the implementation.",
    "Line 3 of work.",
    "Line 4 of work.",
    "Line 5 of work.",
    "Line 6 of work.",
    "Line 7 of work.",
    "TEAM_NEXT:codex",
  ];
  const result = parseTeamDebateControl(lines.join("\n"));
  assert.equal(result.done, false);
  assert.equal(result.nextActor, "codex");
});

test("parseTeamDebateControl: TEAM_DONE mentioned only early in long text is ignored", () => {
  const lines = [
    "TEAM_DONE was discussed earlier but I'm not done yet.",
    "Here is more work line 2.",
    "Here is more work line 3.",
    "Here is more work line 4.",
    "Here is more work line 5.",
    "Here is more work line 6.",
    "Here is more work line 7.",
    "TEAM_NEXT:claude",
  ];
  const result = parseTeamDebateControl(lines.join("\n"));
  assert.equal(result.done, false);
  assert.equal(result.nextActor, "claude");
});

test("parseTeamDebateControl: TEAM_NEXT on second-to-last line", () => {
  const result = parseTeamDebateControl(
    "Work done.\nTEAM_NEXT:codex\n",
  );
  assert.equal(result.done, false);
  assert.equal(result.nextActor, "codex");
});

test("parseTeamDebateControl: stop word with surrounding whitespace", () => {
  const result = parseTeamDebateControl("Done.\n  TEAM_STOP  ");
  assert.equal(result.done, true);
});
