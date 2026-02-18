# Agoryx — Vision

## Name

Agoryx derives from the Greek word **ἀγορά** (agorá) — the open public square in ancient Greek city-states where citizens gathered to discuss, debate, and decide. In the agora, diverse voices met on equal ground to reason through problems together. Agoryx carries this idea into the age of AI: a shared space where humans and multiple AI agents engage in real dialogue — not isolated question-answer exchanges, but genuine collaborative reasoning.

## Mission

Agoryx is a local-first, open-source group chat for humans and multiple LLM agents. It removes manual copy-paste between vendor apps and provides one shared conversation where agents can respond to the user and to each other, preserving full context for every participant.

## The Problem

Today, anyone working with multiple LLMs faces the same friction. Each model lives in its own isolated interface — ChatGPT, Claude, Gemini — and there is no way for them to talk to each other. The user becomes a manual router: copying text between apps, re-explaining context, keeping track of who said what. This is exhausting and it scales poorly.

Comparison modes exist (chatbot arenas, side-by-side tools), but they only address the shallow case of comparing answers to the same prompt. They miss the deeper opportunity: real multi-agent dialogue where models build on, critique, and complement each other's reasoning over the course of a conversation.

The best solutions to hard problems often emerge not from asking one expert, but from structured discussion among several. Agoryx brings this pattern to AI.

## Product Thesis

Start with a personal tool that solves the creator's daily workflow. Build on top of existing authenticated CLIs (Claude Code, Codex CLI) rather than raw provider APIs, so users can leverage their existing subscriptions without managing separate API keys. Treat orchestration modes (manual, round-robin, auto, team) as policies of one engine, not separate applications. Keep identity, auth tokens, and conversation data local by default.

## Core Principles

**Local-first.** Run on the user's machine. Store data locally. No cloud dependency for core functionality.

**Interop-first.** Integrate with tools users already have installed and authenticated (Codex CLI, Claude Code, Gemini CLI, and others over time).

**Contract-first.** Define one internal event/message format. Adapters translate provider-specific formats in and out. The core never sees raw provider output.

**Failure isolation.** One failing agent must not break the room. If Claude times out, the conversation continues with Codex. If Codex hits a rate limit, the user sees a clear error and can retry or continue without it.

**Human control.** The user decides who answers and when. Agents do not speak unless invited (in manual mode) or unless the active orchestration policy dispatches them.

## Initial Users

Power users who already work with 2+ LLM tools daily. Engineers, researchers, and knowledge workers who need role-based discussion, critique loops, or diverse perspectives on complex problems.

## Use Cases

**Collaborative reasoning.** Ask a hard question and let two models approach it from different angles. One might catch what the other misses.

**Code review.** One agent writes code, another reviews it. The user moderates.

**Research.** Different models have different training data and different "blind spots." A group conversation surfaces a more complete picture.

**Debate and fact-checking.** Models challenge each other's claims, reducing the risk of confident hallucination that occurs when working with a single model.

**Project work.** Multiple agents with defined roles (architect, implementer, critic) collaborate on a shared task under human direction.

## MVP v0.1 Scope

Two agents: `codex` and `claude`. One shared room/session with persistent history. Three orchestration modes: `manual` (only the tagged agent responds), `round-robin` (agents answer in sequence), and `auto` (a simple heuristic dispatches based on message content). One CLI entrypoint: `agoryx chat --agents codex,claude --mode manual`. Structured, normalized events for transport, UI, and logs. Basic session persistence and recovery after restart. Graceful per-agent error handling (timeout, crash, rate limit, auth failure).

## Out of Scope for v0.1

Hosted multi-tenant proxy service. Plugin marketplace. Complex policy graph editor. Enterprise governance and org-level controls. Web UI (deferred to v0.2).

## Success Criteria

A user can run one command and start a two-agent room in under two minutes. No manual copy-paste is needed for a normal two-agent workflow. If one adapter fails, the room remains usable with the other adapter. Session replay reconstructs the conversation accurately. The user can switch orchestration modes mid-session.

## Distribution Model

Open source (MIT or Apache-2.0), local-first. CLI is the primary interface. Web UI and API layer come in subsequent versions, built on the same core.

## Risks and Mitigations

CLI output formats may change as providers evolve their tools. Mitigation: keep adapters isolated, versioned, and covered by contract tests so breakage is detected early and contained.

Provider terms may limit some redistribution or commercial patterns. Mitigation: stay firmly in the "personal local tool" space for v0.1 and keep SaaS assumptions out of architecture decisions.

Long conversations can exceed practical context limits. Mitigation: implement summarization checkpoints and pinned context blocks from v0.1.

"Group hallucination" — agents reinforcing each other's errors. Mitigation: always keep the human in the loop as moderator; add explicit "challenge" and "fact-check" prompts in debate mode.

## Roadmap

**v0.1** ✓ — CLI-first two-agent local room (Codex + Claude). Manual, round-robin, and auto modes. SQLite persistence. Context management (pins, checkpoints, structured summaries). Session export (Markdown, JSON). Retry flow. Persistent adapter sessions.

**v0.2** ✓ — Autonomous team mode with round-robin debate loop, proposal-gated completion, background team runs, and resumable state. Agentic adapter transport (workspace-aware cwd). Live status output (generating/done, session binding). Team output sanitization and noise filtering.

**v0.3** — Local web UI. Additional adapters (Gemini CLI, local models via Ollama). MCP integration. Shared tool/file context between agents.

**v1.0** — Stable API, community adapters, configurable policy engine, optional daemon mode.
