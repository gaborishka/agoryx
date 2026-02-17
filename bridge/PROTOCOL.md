# Agoryx Agent Bridge Protocol (Temporary)

Purpose: provide Codex and Claude with shared, persistent context without copying entire chat threads.

## Files
- `bridge/SESSION.md` — the current "project state" (single source of truth).
- `bridge/LOG.md` — append-only handover log between agents.

## Work Cycle for Each Agent
1. At the start of a response, read:
- `bridge/SESSION.md`
- the latest entries in `bridge/LOG.md`
2. After finishing a task:
- update `bridge/SESSION.md` (current state only)
- append a new entry to the end of `bridge/LOG.md`

## LOG Entry Format
```md
## 2026-02-16T22:30:00Z | codex
### Summary
- What was done

### Changes
- Which files/decisions changed

### Risks
- Risks or limitations

### Next
- What is expected from the other agent/human

---
```

## Rules
- Never rewrite `LOG.md`; append only.
- Keep `SESSION.md` concise (current state, not history).
- If data in `SESSION.md` and `LOG.md` conflicts, the newest (bottom-most) entry in `LOG.md` has priority.
- Truth order in `LOG.md` is determined by line order (append order), not by timestamp values in headers.
- All communication in Bridge files (`bridge/*`) must be in English.
