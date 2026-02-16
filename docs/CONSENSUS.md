# Agoryx — Consensus Document

*Established: February 16, 2026*
*Participants: Ivan (human moderator), Claude (Anthropic), Codex (OpenAI)*

This document records the decisions reached through multi-agent discussion during the initial design phase of Agoryx. It serves as the binding reference for MVP implementation.

---

## How This Document Was Created

This consensus was reached through exactly the kind of workflow Agoryx aims to enable: a human moderator facilitated discussion between two AI agents (Claude and Codex), manually relaying messages between separate interfaces. The friction of that process — the copy-pasting, the context re-explanation, the manual synchronization — is itself the proof that Agoryx needs to exist.

---

## Agreed Decisions

### 1. Product Direction

Agoryx is a **local-first, open-source** tool for multi-agent group chat. It starts as a personal tool solving the creator's workflow, with potential to serve a broader community. It is not a SaaS product, not a cloud proxy, and not a multi-tenant service — at least not in v0.1.

### 2. Core Strategy: CLI Wrapper

Instead of requiring users to provide API keys, Agoryx wraps existing authenticated CLI tools (Claude Code, Codex CLI). Users leverage their existing subscriptions. This was the key architectural insight that both agents converged on independently.

### 3. Architecture: Three Layers

The system is organized into three strict layers:

- **Transport Layer** — adapters that speak to external CLIs and normalize output into internal events.
- **Session Layer** — room state, message persistence, context building, and summarization checkpoints.
- **Orchestration Layer** — policies that decide which agent responds when.

These layers are independent. Changing an adapter does not affect the orchestrator. Adding a policy does not affect storage.

### 4. MVP v0.1 Scope

- Two agents: Codex and Claude.
- Single CLI process (no daemon).
- Three orchestration modes: manual, round-robin, auto.
- SQLite persistence.
- Graceful error handling per adapter.
- Session resume and export.

### 5. Orchestration as Configuration

All interaction modes (manual, round-robin, debate, team-roles, etc.) are policies of one orchestration engine, not separate systems. This was explicitly agreed as a design principle.

### 6. Error Isolation

A failing agent must not break the room. Errors are typed, contained to the affected adapter, and surfaced to the user with retry options. The room continues operating with remaining healthy agents.

### 7. Context Management

Each agent receives: its system prompt, pinned context, a summary of older conversation (if beyond threshold), and recent messages verbatim. Context is built per-request, respecting each adapter's token budget.

---

## Points Where Agents Diverged (Resolved)

| Topic | Codex Position | Claude Position | Resolution |
|-------|---------------|-----------------|------------|
| Daemon vs. CLI process | Proposed `agoryxd` daemon | Start simpler with CLI process | CLI first, daemon in v0.2+ |
| v0.1 modes | manual + @mention | manual + round-robin + auto | All three included |
| Tie-break on conflicts | Proposed moderation rules | Let the user decide | User as moderator for v0.1 |
| Project layout language | Go-style layout (`cmd/`, `internal/`) | Language TBD | Layout agreed, language TBD |

---

## Open Questions (Deferred)

These questions were identified but intentionally deferred beyond v0.1:

1. **Terms compliance** for scenarios beyond personal use.
2. **Agent-to-agent autonomous conversation** without human in the loop.
3. **Shared file/tool context** between agents.
4. **Multi-user rooms** (collaborative sessions with multiple humans).
5. **Implementation language** — Go, TypeScript, or Rust. To be decided based on adapter ecosystem needs.
6. **Budget/cost controls** — token limits, per-session spending caps.

---

## Next Steps

1. **Codex:** Create project scaffold — CLI entrypoint, internal types, stub adapters with event normalization.
2. **Claude:** Review Codex's scaffold, add contract tests, and validate adapter output against real CLI formats.
3. **Both:** Iterate on implementation with Ivan as moderator, using the manual relay workflow until Agoryx itself can replace it.

---

*This document is itself a product of the problem Agoryx solves. The next version of this consensus should be written inside Agoryx.*
