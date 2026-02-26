# Team Mode: Plan-then-Execute with Parallel Execution

**Date:** 2026-02-25
**Status:** Approved
**Scope:** v0.3

## Problem

Team mode currently runs agents sequentially via a debate loop. This causes three issues:

1. **No coordination** — agents start working without agreeing on task division, leading to duplicated or conflicting effort.
2. **Sequential only** — agents take turns, doubling wall-clock time for tasks that could run in parallel.
3. **No guaranteed file output** — agents may describe work in chat without creating physical files.

## Design

Replace the sequential debate loop with a three-phase flow: **Plan → Execute → Merge**.

### Phase 1: Planning (Negotiation, 2 rounds)

When a team run starts, agents negotiate a plan before doing any real work.

**Round 1 — Propose:** The first agent receives the user's goal and produces a structured plan containing:
- Task breakdown per agent
- File ownership per agent (which files each agent will create/modify)
- Expected deliverables (file paths or "chat-only")

**Round 2 — Amend/Accept:** The second agent reviews the plan. They can accept as-is or propose amendments (reassign tasks, adjust file ownership, add deliverables). The result of round 2 is the **final plan**.

The plan uses a structured format parsed from agent output:

```
PLAN:
- agent: codex
  task: "Implement API endpoints for user auth"
  files: ["internal/api/auth.ts", "internal/api/middleware.ts"]
  deliverables: ["internal/api/auth.ts", "internal/api/middleware.ts"]
- agent: claude
  task: "Write documentation and test specs"
  files: ["docs/auth.md", "tests/auth.test.ts"]
  deliverables: ["docs/auth.md", "tests/auth.test.ts"]
```

The finalized plan is displayed to the user in chat before execution proceeds.

### Phase 2: Parallel Execution

Once the plan is finalized:

- Each agent is dispatched **simultaneously** in their own git worktree (existing infrastructure).
- Each agent receives: the agreed plan + their assigned task + the user's original goal.
- Agents work independently, creating files in their worktrees.
- Turn locks remain per-adapter, so parallel dispatch across different adapters is safe.

### Phase 3: Merge

After all agents complete:

1. Auto-merge agent branches into the session branch using `git merge`.
2. On success — report results to the user, list created deliverables.
3. On conflict — show conflicts to the user, ask them to resolve.

## Code Changes

| Component | Change |
|-----------|--------|
| `TeamOrchestrator` | Replace sequential `runLoop` with 3-phase flow: plan → execute → merge |
| `team-orchestrator.ts` | New `runPlanningPhase()` — negotiation rounds (sequential, 2 rounds) |
| `team-orchestrator.ts` | New `runParallelExecution()` — dispatch all agents concurrently |
| `team-orchestrator.ts` | New `runMergePhase()` — git auto-merge of worktree branches |
| `TeamPolicy` | Support planning-mode actor selection (round-robin for 2 rounds) |
| `dispatch-engine.ts` | Allow concurrent dispatches across adapters (relax per-room lock) |
| Control protocol | New `PLAN:` block format for structured plan output |
| `TEAM_NEXT` / `TEAM_DONE` | Removed from execution phase — agents run in parallel, no handoffs |

## What Stays the Same

- Worktree creation and cleanup
- Adapter modes (agentic / cli / stub)
- Chat UI and message rendering
- Storage and session management
- Single-agent and solo modes

## Decisions

- **Coordination model:** Plan-then-execute (not leader-workers, not human-in-the-loop)
- **Planning negotiation:** 2 rounds max (propose → amend/accept)
- **Execution:** Always parallel after planning
- **Merge strategy:** Auto-merge via git; conflicts shown to user
- **File output:** Plan-driven deliverables — the plan specifies expected files; agents follow the plan
