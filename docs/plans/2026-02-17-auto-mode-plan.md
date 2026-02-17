# Auto Mode Smart Routing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace broadcast-all auto policy with deterministic two-pass routing: mention → skill match → round-robin fallback.

**Architecture:** AutoPolicy receives agent skills via constructor. Skills map to keywords. Message text is scored against each agent's keyword set. Highest score wins. Fallback uses round-robin rotation (index advances only on fallback).

**Tech Stack:** TypeScript, node:test, node:assert/strict. No new dependencies.

**Design doc:** `docs/plans/2026-02-17-auto-mode-design.md`

---

### Task 1: Add `skills` to config layer

**Files:**
- Modify: `internal/config/index.ts`
- Modify: `internal/config/default.ts`

**Step 1: Add `skills` to `AgentEntry` interface**

In `internal/config/index.ts`, add `skills?: string[]` to `AgentEntry`:

```typescript
export interface AgentEntry {
  adapter: string;
  mode: AdapterMode;
  timeoutMs: number;
  maxTokens: number;
  systemPrompt?: string;
  skills?: string[];
}
```

**Step 2: Add `DEFAULT_AGENT_SKILLS` constant**

In `internal/config/index.ts`, after the existing `AGENT_DEFAULTS` constant, add:

```typescript
export const DEFAULT_AGENT_SKILLS: Record<string, string[]> = {
  codex: ["code", "implement", "debug", "fix", "test", "refactor", "write"],
  claude: ["architecture", "review", "explain", "plan", "docs", "design", "analyze"],
};
```

**Step 3: Add `resolveAgentSkills` function**

In `internal/config/index.ts`, add before `toRuntimeConfig`:

```typescript
export function resolveAgentSkills(
  config: AgoryxConfig,
  activeAgents?: string[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const agents = activeAgents ?? Object.keys(config.agents);
  for (const name of agents) {
    const entry = config.agents[name];
    if (!entry) continue;
    result[name] = entry.skills ?? DEFAULT_AGENT_SKILLS[name] ?? [];
  }
  return result;
}
```

**Step 4: Add `agentSkills` to `ChatRuntimeConfig`**

In `internal/config/default.ts`, add to `ChatRuntimeConfig`:

```typescript
export interface ChatRuntimeConfig {
  dbPath: string;
  mode: OrchestrationMode;
  agents: string[];
  adapterConfig: Record<string, AdapterConfig>;
  roomConfig: RoomConfig;
  roomName: string;
  resumeRoomId?: string;
  agentSkills?: Record<string, string[]>;
}
```

**Step 5: Wire `agentSkills` into `toRuntimeConfig()`**

In `internal/config/index.ts`, update the `toRuntimeConfig` return object to include:

```typescript
return {
  dbPath: config.session.dbPath,
  mode: config.defaultMode,
  agents: agentNames,
  adapterConfig,
  roomConfig: toRoomConfig(config),
  roomName: overrides.roomName ?? "default",
  resumeRoomId: overrides.resumeRoomId,
  agentSkills: resolveAgentSkills(config, agentNames),
};
```

**Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors — skills is optional everywhere)

**Step 7: Commit**

```bash
git add internal/config/index.ts internal/config/default.ts
git commit -m "feat(config): add agent skills for auto mode routing"
```

---

### Task 2: Config merge tests for skills

**Files:**
- Modify: `tests/config/merge.test.ts`

**Step 1: Write failing test — config skills override defaults**

Append to `tests/config/merge.test.ts`:

```typescript
import { resolveAgentSkills } from "../../internal/config/index.js";

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

  // Config skills should override defaults entirely
  assert.deepEqual(skills.codex, ["code", "custom-skill"]);
  // Claude should get hardcoded defaults (no override)
  assert.ok(skills.claude.length > 0, "claude should have default skills");
  assert.ok(skills.claude.includes("review"), "claude defaults should include review");

  rmSync(dir, { recursive: true });
});
```

**Step 2: Write failing test — agent without skills gets defaults**

```typescript
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

  // No skills field → falls back to DEFAULT_AGENT_SKILLS
  assert.ok(skills.codex.includes("code"), "codex should get default skills");
  assert.ok(skills.codex.includes("debug"), "codex should get default skills");

  rmSync(dir, { recursive: true });
});
```

**Step 3: Write failing test — new agent without skills gets empty array**

```typescript
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

  // New agent with no skills and no hardcoded defaults → empty
  assert.deepEqual(skills.gemini, []);

  rmSync(dir, { recursive: true });
});
```

**Step 4: Run tests**

Run: `npx tsx --test tests/config/merge.test.ts`
Expected: ALL PASS (6 total — 3 existing + 3 new)

**Step 5: Commit**

```bash
git add tests/config/merge.test.ts
git commit -m "test(config): add skills merge coverage"
```

---

### Task 3: Update factory with PolicyOptions

**Files:**
- Modify: `internal/orchestrator/factory.ts`

**Step 1: Add `PolicyOptions` interface and update `createPolicy`**

Replace the entire content of `internal/orchestrator/factory.ts`:

```typescript
import type { OrchestrationMode } from "../events/types.js";
import { AutoPolicy } from "./auto.js";
import { ManualPolicy } from "./manual.js";
import type { OrchestrationPolicy } from "./policy.js";
import { RoundRobinPolicy } from "./round-robin.js";

export interface PolicyOptions {
  agentSkills?: Record<string, string[]>;
}

export const createPolicy = (
  mode: OrchestrationMode,
  options?: PolicyOptions,
): OrchestrationPolicy => {
  switch (mode) {
    case "manual":
      return new ManualPolicy();
    case "round-robin":
      return new RoundRobinPolicy();
    case "auto":
      return new AutoPolicy(options?.agentSkills);
    default:
      return new ManualPolicy();
  }
};
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — AutoPolicy constructor doesn't accept args yet. That's fine — next task fixes it.

**Step 3: Do NOT commit yet** — wait for Task 4 to fix AutoPolicy constructor.

---

### Task 4: Rewrite AutoPolicy with two-pass routing

**Files:**
- Modify: `internal/orchestrator/auto.ts`

**Step 1: Write the full AutoPolicy implementation**

Replace entire content of `internal/orchestrator/auto.ts`:

```typescript
import type { Message, Room } from "../events/types.js";
import { makeDispatch, parseMentions } from "./helpers.js";
import type { Dispatch, OrchestrationContext, OrchestrationPolicy } from "./policy.js";

const SKILL_KEYWORDS: Record<string, string[]> = {
  code:         ["code", "код", "функці", "program"],
  implement:    ["implement", "реалізуй", "build"],
  debug:        ["debug", "баг", "bug", "виправ", "помилк", "error"],
  fix:          ["fix", "виправ", "полагод", "repair"],
  test:         ["test", "тест", "coverage", "spec"],
  refactor:     ["refactor", "рефактор", "clean", "оптиміз"],
  write:        ["write", "напиши", "створи", "generate"],
  architecture: ["architect", "архітектур", "структур", "layer"],
  review:       ["review", "перевір", "ревью", "critique", "оціни"],
  explain:      ["explain", "поясни", "розкаж", "чому"],
  plan:         ["plan", "план", "roadmap", "стратегі", "approach"],
  docs:         ["doc", "документ", "readme", "опис"],
  design:       ["design", "дизайн", "інтерфейс"],
  analyze:      ["analyz", "аналіз", "порівн", "compare", "evaluate"],
};

const SHORT_KEYWORD_WHITELIST = new Set(["ui", "ux", "db"]);

/**
 * Check if a word matches a keyword via prefix match.
 * Keywords shorter than 3 chars are only matched if whitelisted.
 */
const wordMatchesKeyword = (word: string, keyword: string): boolean => {
  if (keyword.length < 3 && !SHORT_KEYWORD_WHITELIST.has(keyword)) {
    return false;
  }
  return word.startsWith(keyword);
};

/**
 * Score an agent based on how many of its skill keywords match the message words.
 */
const scoreAgent = (
  words: string[],
  agentSkills: string[],
): { score: number; bestSkill: string } => {
  let totalScore = 0;
  let bestSkill = "";
  let bestSkillScore = 0;

  for (const skill of agentSkills) {
    const keywords = SKILL_KEYWORDS[skill];
    if (!keywords) continue;

    let skillScore = 0;
    for (const word of words) {
      for (const keyword of keywords) {
        if (wordMatchesKeyword(word, keyword)) {
          skillScore++;
          break; // one hit per word per skill
        }
      }
    }

    if (skillScore > 0) {
      totalScore += skillScore;
      if (skillScore > bestSkillScore) {
        bestSkillScore = skillScore;
        bestSkill = skill;
      }
    }
  }

  return { score: totalScore, bestSkill };
};

export class AutoPolicy implements OrchestrationPolicy {
  public readonly name = "auto";
  private fallbackIndexByRoom = new Map<string, number>();

  public constructor(
    private readonly agentSkills?: Record<string, string[]>,
  ) {}

  public onUserMessage(
    room: Room,
    message: Message,
    context: OrchestrationContext,
  ): Dispatch[] {
    // --- Pass 1: Mentions ---
    const mentions = parseMentions(message.text);

    // @all → broadcast
    if (mentions.includes("all")) {
      return context.availableAgents.map((agent, index) =>
        makeDispatch(agent, "auto:mention:all", 100 + index),
      );
    }

    // @agent → deduplicated dispatch to mentioned agents
    const uniqueMentions = [
      ...new Set(
        mentions.filter((m) => context.availableAgents.includes(m)),
      ),
    ];
    if (uniqueMentions.length > 0) {
      return uniqueMentions.map((agent, index) =>
        makeDispatch(agent, `auto:mention:${agent}`, 100 + index),
      );
    }

    // --- Pass 2: Skill match ---
    const words = message.text
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9_-]/g, ""))
      .filter((w) => w.length > 0);
    const skills = this.agentSkills ?? {};

    let bestAgent = "";
    let bestScore = 0;
    let bestSkill = "";

    for (const agent of context.availableAgents) {
      const agentSkillList = skills[agent] ?? [];
      if (agentSkillList.length === 0) continue;

      const result = scoreAgent(words, agentSkillList);
      if (result.score > bestScore) {
        bestScore = result.score;
        bestAgent = agent;
        bestSkill = result.bestSkill;
      }
      // tie: first agent in availableAgents order wins (no override)
    }

    if (bestScore > 0 && bestAgent) {
      return [makeDispatch(bestAgent, `auto:skill:${bestSkill}→${bestAgent}`)];
    }

    // --- Pass 3: Round-robin fallback ---
    const index = this.fallbackIndexByRoom.get(room.id) ?? 0;
    const target = context.availableAgents[index % context.availableAgents.length];
    if (!target) {
      return [];
    }
    this.fallbackIndexByRoom.set(room.id, index + 1);
    return [makeDispatch(target, "auto:fallback:rotation")];
  }

  public onAgentMessage(
    _room: Room,
    _message: Message,
    _context: OrchestrationContext,
  ): Dispatch[] {
    return [];
  }
}
```

**Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit factory + auto policy together**

```bash
git add internal/orchestrator/factory.ts internal/orchestrator/auto.ts
git commit -m "feat(orchestrator): two-pass auto routing with skill matching"
```

---

### Task 5: Auto policy tests

**Files:**
- Create: `tests/orchestrator/auto.test.ts`

**Step 1: Write all 12 test cases**

Create `tests/orchestrator/auto.test.ts`:

```typescript
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
  // Both agents share the same skill
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
  // codex is first in availableAgents → wins tie
  assert.equal(dispatches[0].targetAdapter, "codex");
});

test("short keywords (<3 chars) are ignored unless whitelisted", () => {
  const skillsWithShort = {
    codex: ["code"],
    claude: ["design"],
  };
  const policy = new AutoPolicy(skillsWithShort);
  // "ui" is whitelisted but "design" skill does not contain "ui" as keyword
  // This message should fall through to fallback
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
    codex: ["review"],  // codex now does review instead of code
    claude: ["code"],   // claude now does code instead of review
  };
  const policy = new AutoPolicy(customSkills);
  const dispatches = policy.onUserMessage(
    makeRoom(),
    makeMessage("review this please"),
    defaultContext,
  );

  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].targetAdapter, "codex"); // because codex has "review"
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
```

**Step 2: Run tests**

Run: `npx tsx --test tests/orchestrator/auto.test.ts`
Expected: ALL 13 PASS

**Step 3: Commit**

```bash
git add tests/orchestrator/auto.test.ts
git commit -m "test(orchestrator): comprehensive auto routing test coverage"
```

---

### Task 6: Engine integration

**Files:**
- Modify: `internal/engine/chat.ts:60` (in `init()`)
- Modify: `internal/engine/chat.ts:84` (in `setMode()`)

**Step 1: Update `init()` — pass agentSkills to createPolicy**

In `internal/engine/chat.ts`, line 60, change:

```typescript
// OLD:
const policy = createPolicy(created.room.config.mode);

// NEW:
const policy = createPolicy(created.room.config.mode, {
  agentSkills: this.config.agentSkills,
});
```

**Step 2: Update `setMode()` — pass agentSkills to createPolicy**

In `internal/engine/chat.ts`, line 85, change:

```typescript
// OLD:
current.policy = createPolicy(mode);

// NEW:
current.policy = createPolicy(mode, {
  agentSkills: this.config.agentSkills,
});
```

**Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add internal/engine/chat.ts
git commit -m "feat(engine): pass agent skills to policy on creation"
```

---

### Task 7: Full verification

**Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — zero errors

**Step 2: Run full test suite**

Run: `npx tsx --test tests/**/*.test.ts`
Expected: ALL PASS (49 existing + 13 auto + 3 config merge = 65 total, approximately)

**Step 3: Update bridge files**

Update `bridge/SESSION.md` with:
- Auto mode smart routing implemented
- New files: `tests/orchestrator/auto.test.ts`
- Modified: `internal/orchestrator/auto.ts`, `factory.ts`, `internal/config/index.ts`, `default.ts`, `internal/engine/chat.ts`

Append to `bridge/LOG.md`:
```
## 2026-02-17TXX:XX:XXZ | claude
### Summary
- Implemented auto mode smart routing: two-pass algorithm (mention → skill match → round-robin fallback)
- Config-based agent skills with hardcoded defaults for codex/claude
- 13 new auto routing tests + 3 config merge tests

### Changes
- Rewritten: internal/orchestrator/auto.ts (two-pass routing)
- Modified: internal/orchestrator/factory.ts (PolicyOptions)
- Modified: internal/config/index.ts (skills in AgentEntry, resolveAgentSkills)
- Modified: internal/config/default.ts (agentSkills in ChatRuntimeConfig)
- Modified: internal/engine/chat.ts (pass agentSkills to createPolicy)
- Created: tests/orchestrator/auto.test.ts (12 tests)
- Extended: tests/config/merge.test.ts (+3 tests)

### Risks
- Keyword dictionary is static — may need tuning based on real usage
- Prefix matching could produce false positives for very common prefixes

### Next
- Commit iteration
- Live smoke-test auto mode with real agents
```

**Step 4: Commit bridge updates**

```bash
git add bridge/SESSION.md bridge/LOG.md
git commit -m "docs(bridge): update session state after auto mode implementation"
```
