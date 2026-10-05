import test from "node:test";
import assert from "node:assert/strict";
import { AutoPolicy } from "../../internal/orchestrator/auto.js";
import type { Message, Room } from "../../internal/events/types.js";
import type { OrchestrationContext } from "../../internal/orchestrator/policy.js";

const makeRoom = (id = "room_1"): Room => ({
  id,
  name: "test-room",
  participants: ["user", "agent.codex", "agent.claude"],
  config: {
    mode: "auto",
    checkpointThreshold: 50,
    maxHistoryMessages: 100,
    maxContextTokens: 30_000,
  },
  createdAt: new Date().toISOString(),
});

const makeMessage = (text: string): Message => ({
  id: "msg_1",
  roomId: "room_1",
  author: "user",
  role: "user",
  text,
  format: "plain",
  metadata: {},
  createdAt: new Date().toISOString(),
});

const defaultContext: OrchestrationContext = {
  availableAgents: ["codex", "claude"],
};

const defaultSkills: Record<string, string[]> = {
  codex: ["code", "implement", "debug", "fix", "test", "refactor", "write"],
  claude: ["architecture", "review", "explain", "plan", "docs", "design", "analyze"],
};

// --- Pass 1: Mentions ---

test("@all broadcasts to all agents", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("@all what do you think?"),
    defaultContext,
  );

  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].targetAdapter, "codex");
  assert.equal(dispatches[1].targetAdapter, "claude");
  assert.ok(dispatches[0].reason.includes("mention:all"));
});

test("@codex dispatches to codex only", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("@codex write a function"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].targetAdapter, "codex");
  assert.ok(dispatches[0].reason.includes("mention"));
});

test("@codex @claude dispatches to both in order", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("@codex @claude what do you think?"),
    defaultContext,
  );

  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].targetAdapter, "codex");
  assert.equal(dispatches[1].targetAdapter, "claude");
});

test("@codex @codex deduplicates to single dispatch", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("@codex @codex help me"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].targetAdapter, "codex");
});

test("unknown @mention is ignored", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("@unknown hello"),
    defaultContext,
  );

  // Falls through to skill match or fallback
  assert.ok(dispatches.length >= 1);
  assert.ok(
    dispatches[0].targetAdapter === "codex" || dispatches[0].targetAdapter === "claude",
  );
});

// --- Pass 2: Skill matching ---

test("code-related message routes to codex", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("напиши функцію сортування"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].targetAdapter, "codex");
  assert.ok(dispatches[0].reason.includes("skill"));
});

test("explain/architecture message routes to claude", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("поясни архітектуру системи"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].targetAdapter, "claude");
  assert.ok(dispatches[0].reason.includes("skill"));
});

test("tie-breaking: first agent in config order wins", () => {
  const tiedSkills = {
    codex: ["review"],
    claude: ["review"],
  };
  const policy = new AutoPolicy(tiedSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("review this code"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].targetAdapter, "codex");
});

test("short keywords (<3 chars) are ignored unless whitelisted", () => {
  const skillsWithShort = {
    codex: ["code"],
    claude: ["design"],
  };
  const policy = new AutoPolicy(skillsWithShort);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("ab cd ef"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.ok(dispatches[0].reason.includes("fallback"));
});

test("custom skills from config override defaults", () => {
  const customSkills = {
    codex: ["review"],
    claude: ["code"],
  };
  const policy = new AutoPolicy(customSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("review this please"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].targetAdapter, "codex");
});

// --- Pass 3: Fallback ---

test("no keyword match falls back to round-robin", () => {
  const policy = new AutoPolicy(defaultSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("привіт, як справи?"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.ok(dispatches[0].reason.includes("fallback"));
});

test("round-robin index advances only on fallback", () => {
  const policy = new AutoPolicy(defaultSkills);
  const room = makeRoom();

  // First: skill match (should NOT advance rotation)
  const d1 = policy.onUserMessage(room, makeMessage("напиши код"), defaultContext);
  assert.equal(d1[0].targetAdapter, "codex");
  assert.ok(d1[0].reason.includes("skill"));

  // Second: fallback → should start at index 0 (codex), not 1
  const d2 = policy.onUserMessage(room, makeMessage("привіт"), defaultContext);
  assert.equal(d2[0].targetAdapter, "codex");
  assert.ok(d2[0].reason.includes("fallback"));

  // Third: another fallback → now index 1 (claude)
  const d3 = policy.onUserMessage(room, makeMessage("ок"), defaultContext);
  assert.equal(d3[0].targetAdapter, "claude");
  assert.ok(d3[0].reason.includes("fallback"));
});

test("rotation is per-room (independent indices)", () => {
  const policy = new AutoPolicy(defaultSkills);
  const roomA = makeRoom("room_a");
  const roomB = makeRoom("room_b");

  // Room A: first fallback → codex (index 0)
  const a1 = policy.onUserMessage(roomA, makeMessage("привіт"), defaultContext);
  assert.equal(a1[0].targetAdapter, "codex");

  // Room B: first fallback → also codex (index 0, independent)
  const b1 = policy.onUserMessage(roomB, makeMessage("привіт"), defaultContext);
  assert.equal(b1[0].targetAdapter, "codex");

  // Room A: second fallback → claude (index 1)
  const a2 = policy.onUserMessage(roomA, makeMessage("ок"), defaultContext);
  assert.equal(a2[0].targetAdapter, "claude");

  // Room B: second fallback → also claude (index 1, still independent)
  const b2 = policy.onUserMessage(roomB, makeMessage("ок"), defaultContext);
  assert.equal(b2[0].targetAdapter, "claude");
});
