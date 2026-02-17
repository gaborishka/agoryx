# Auto Mode — Smart Routing Design

## Problem

Current auto policy broadcasts every user message to all agents. This wastes tokens and produces redundant responses. We need a deterministic routing algorithm that picks the single best agent per message.

## Approach: Two-Pass Routing

Three-tier priority with no ambiguity:

```
1. MENTION PASS (explicit user intent)
   a. @all → broadcast to ALL agents → return
   b. @agent mentions → deduplicate → dispatch to mentioned agents → return

2. SKILL MATCH PASS (keyword heuristics)
   - Normalize message: lowercase, trim, split into words
   - For each agent: count keyword hits from their skills
   - Agent with most hits wins (tie: first in config order)
   - Minimum 1 hit required to trigger

3. FALLBACK (round-robin rotation)
   - Same rotation logic as RoundRobinPolicy
   - Index increments ONLY on fallback (not on mention/skill match)
```

## Agent Skills

Each agent declares skills — tags describing what it's good at. Skills are mapped to keywords for matching.

### Config schema change

```typescript
// AgentEntry gains optional skills field
export interface AgentEntry {
  adapter: string;
  mode: AdapterMode;
  timeoutMs: number;
  maxTokens: number;
  systemPrompt?: string;
  skills?: string[];          // NEW — routing tags for auto mode
}
```

### Hardcoded defaults (out-of-box experience)

```typescript
const DEFAULT_AGENT_SKILLS: Record<string, string[]> = {
  codex: ["code", "implement", "debug", "fix", "test", "refactor", "write"],
  claude: ["architecture", "review", "explain", "plan", "docs", "design", "analyze"],
};
```

User can override via `agoryx.json`:
```json
{
  "agents": {
    "codex": { "skills": ["code", "debug", "test"] },
    "claude": { "skills": ["review", "explain", "plan", "custom-skill"] }
  }
}
```

### Keyword dictionary

Maps skill tags to searchable keywords (including Ukrainian):

```typescript
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
```

### Matching rules

- Message is lowercased, trimmed, split into words
- Each word is checked against keyword dictionary via **prefix match** (substring from start)
- Keywords shorter than 3 characters are ignored unless in explicit whitelist: `["ui", "ux", "db"]`
- Score = number of keyword hits across all agent's skills
- Tie-breaking: first agent in config order wins (deterministic)

## Files Changed

| File | Change | Owner |
|------|--------|-------|
| `internal/orchestrator/auto.ts` | Full rewrite — two-pass algorithm | Claude |
| `internal/orchestrator/factory.ts` | `createPolicy(mode, options?)` — pass agentSkills | Claude |
| `internal/config/index.ts` | `skills?: string[]` in AgentEntry, DEFAULT_AGENT_SKILLS, propagate to runtime config | Claude |
| `internal/config/default.ts` | Add `agentSkills` to `ChatRuntimeConfig` | Claude |
| `internal/engine/chat.ts` | Pass `agentSkills` from config when creating policy | Claude (minimal, 1-2 lines) |
| `tests/orchestrator/auto.test.ts` | NEW — all routing scenarios | Claude |
| `tests/config/merge.test.ts` | Add skills merge tests | Claude |

## Engine integration (minimal touch)

```typescript
// factory.ts
export interface PolicyOptions {
  agentSkills?: Record<string, string[]>;
}

export const createPolicy = (
  mode: OrchestrationMode,
  options?: PolicyOptions,
): OrchestrationPolicy => {
  switch (mode) {
    case "auto":
      return new AutoPolicy(options?.agentSkills);
    // ... others unchanged
  }
};
```

```typescript
// engine/chat.ts — in init() and setMode()
const policy = createPolicy(mode, {
  agentSkills: this.config.agentSkills,
});
```

```typescript
// config/default.ts — ChatRuntimeConfig gains:
agentSkills?: Record<string, string[]>;
```

```typescript
// config/index.ts — toRuntimeConfig() adds:
agentSkills: resolveAgentSkills(config),
```

## Dispatch reasons (for debugging/logging)

- `auto:broadcast` — @all triggered
- `auto:mention:codex` — explicit @mention
- `auto:skill:code→codex` — skill match with winning skill
- `auto:fallback:rotation` — no match, round-robin

## Test plan

### auto.test.ts (NEW)
1. @all broadcasts to all agents
2. @codex dispatches to codex only
3. @codex @claude dispatches to both (ordered)
4. @codex @codex deduplicates to single dispatch
5. "напиши функцію" matches code skill → codex
6. "поясни архітектуру" matches explain+architecture → claude
7. Message with no keyword match → round-robin fallback
8. Round-robin index advances only on fallback
9. Tie-breaking: first agent in config order wins
10. Short keywords (<3 chars) ignored unless whitelisted
11. Custom skills from config override defaults
12. Unknown agent in @mention is ignored

### merge.test.ts (EXTEND)
13. Skills merge: config skills override defaults
14. Skills merge: agent without skills gets defaults
15. Skills merge: new agent without skills gets empty array

## Out of scope

- Agent-to-agent chaining (v0.2+)
- LLM-based intent classification (too expensive for routing)
- Message history analysis for routing (future enhancement)
- onAgentMessage returns empty (no autonomous chaining)
