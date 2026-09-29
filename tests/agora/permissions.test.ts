import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeArgs, buildClaudeSettings } from "../../internal/agora/runners/claude.js";
import { buildCodexArgs } from "../../internal/agora/runners/codex.js";
import { DEFAULT_SETTINGS } from "../../internal/agora/types.js";

const base = { prompt: "hi", cwd: "/tmp/ws", sessionId: null, roomName: "R", settings: DEFAULT_SETTINGS, env: {}, signal: new AbortController().signal };
const SID = "00000000-0000-4000-8000-000000000000";

test("an agent in a room works as in the human's own terminal: no sandbox or permission mode of Agoryx's own", () => {
  const args = buildClaudeArgs(base, SID, true);
  assert.ok(!args.includes("--permission-mode"), "Claude takes the human's own permission mode");
  const settings = buildClaudeSettings(base);
  assert.equal(settings.sandbox, undefined);
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  // The room's own tools stay allowed by name.
  assert.ok(JSON.stringify(settings.permissions).includes("Bash(agoryx say *)"));

  for (const codex of [buildCodexArgs(base), buildCodexArgs({ ...base, sessionId: "s1" })]) {
    const line = codex.join(" ");
    assert.match(line, /sandbox_mode="workspace-write"|-s workspace-write/, "Codex keeps its own sandbox");
    assert.match(line, /approvals_reviewer="auto_review"/, "a request to leave it goes to Codex's own review");
    assert.match(line, /approval_policy="on-request"/);
    assert.doesNotMatch(line, /dangerously/);
  }
});

test("restrictions the human sets for the room still hold: network off or read-only", () => {
  const offline = { ...base, settings: { ...DEFAULT_SETTINGS, network: false } };
  assert.deepEqual(buildClaudeSettings(offline).sandbox, { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
  const offlineArgs = buildClaudeArgs(offline, SID, true);
  assert.equal(offlineArgs[offlineArgs.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.doesNotMatch(buildCodexArgs(offline).join(" "), /approvals_reviewer|network_access/);

  const readonly = { ...base, settings: { ...DEFAULT_SETTINGS, access: "readonly" as const } };
  const readonlyArgs = buildClaudeArgs(readonly, SID, true);
  assert.equal(readonlyArgs[readonlyArgs.indexOf("--permission-mode") + 1], "default");
  const readonlySettings = buildClaudeSettings(readonly) as { sandbox?: { enabled: boolean }; permissions: { deny?: string[] } };
  assert.equal(readonlySettings.sandbox?.enabled, true);
  assert.ok(readonlySettings.permissions.deny?.includes("Edit"));
  const codex = buildCodexArgs(readonly).join(" ");
  assert.match(codex, /-s read-only/);
  assert.doesNotMatch(codex, /approvals_reviewer/);
});
