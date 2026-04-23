# Research Prompt: Agoryx Architecture & Market Viability

Use this prompt for deep research on the Agoryx project direction.

---

## Context

I'm building **Agoryx** — a local-first collaboration platform where multiple LLM agents (Claude Code, Codex, Gemini CLI, etc.) and a human can work together in a shared "room." The key philosophy: **Agoryx is a platform, not an agent.** It doesn't replace Claude Code or Codex — it gives them a place and protocol to collaborate.

Currently (v0.3), Agoryx works by wrapping CLI agents (`claude -p`, `codex exec`) and assembling shared context from conversation history. But we're considering a fundamental architectural shift: instead of Agoryx controlling agents from the outside, agents would **connect to Agoryx themselves** — Agoryx becomes a service that agents interact with via a standardized protocol.

The leading candidate protocol is **MCP (Model Context Protocol)** — both Claude Code and Codex already support MCP servers. Agoryx would expose tools like `room_read_context`, `room_send_message`, `room_share_file`, and agents would call these tools as part of their normal workflow.

### What's already built (v0.3):
- CLI app wrapping Claude Code and Codex CLIs
- SQLite persistence (rooms, messages, checkpoints, pinned context, memory)
- Context builder with token budgeting, checkpoint summaries, workspace awareness
- 5 orchestration modes (manual, round-robin, auto, team, free)
- Project memory system (.agoryx/memory.md)
- Per-agent git worktrees for safe parallel work
- 398 tests, ~8,300 lines of TypeScript

### Target for v1:
- Agoryx as a local daemon/service
- Agents connect via MCP (or alternative protocol) instead of being wrapped
- Smart context delivery (summaries, not raw dumps) — core value proposition
- Any MCP-compatible agent can join a room
- Two modes: "native" (agents connect via MCP) and "direct" (legacy CLI wrapping)

---

## Research Questions

### 1. Protocol Selection: MCP vs Alternatives

**MCP (Model Context Protocol by Anthropic):**
- As of March 2026, what is the current state of MCP adoption? Which major agent frameworks and tools support it as clients?
- What are MCP's practical limitations for agent-to-agent coordination? (output size limits, lack of push notifications/subscriptions, stateless nature, identity/auth model)
- Can MCP tools carry enough context for meaningful coordination without exceeding token budgets?
- How do MCP's "resources" and "prompts" capabilities compare to "tools" for this use case?
- Is MCP designed for agent-to-service communication, or is it being stretched beyond its intent?

**Google A2A (Agent-to-Agent Protocol):**
- What is A2A's current status and adoption (March 2026)?
- How does A2A compare to MCP for the specific use case of agents sharing a workspace?
- Does A2A solve the "push notification" problem that MCP lacks?
- Can Claude Code or Codex act as A2A clients?

**Other alternatives:**
- OpenAI Agents SDK — does it offer any inter-agent communication primitives?
- Custom REST/WebSocket API — what would be gained vs MCP? Is the ecosystem cost worth it?
- Language Server Protocol (LSP) pattern — is there a parallel with IDE ↔ server communication?
- Simple Unix-level approaches (named pipes, Unix sockets) — too low-level or actually pragmatic?
- Could Agoryx support multiple protocols simultaneously (MCP + A2A + REST)?

**Key question:** For a project whose core value is "give existing agents a shared room with smart context," which protocol best enables this with the least friction for end users?

### 2. Competitive & Market Analysis

**Direct competitors (multi-agent coordination):**
- CrewAI, AutoGen (Microsoft), LangGraph, Agency Swarm, MetaGPT, ChatDev — what is their approach to multi-agent work? How do they differ from Agoryx's "platform" philosophy?
- Do any of these support plugging in external agents (Claude Code, Codex) rather than defining agents internally?
- What is the actual adoption and traction of these frameworks (GitHub stars, npm downloads, community size)?

**Adjacent products:**
- Claude Code's built-in multi-agent capabilities (sub-agents, worktrees) — does this reduce the need for Agoryx?
- Codex's collaboration features — any multi-agent support?
- Cursor, Windsurf, other AI IDEs — do they solve the multi-agent problem differently?
- Are there any MCP-based collaboration tools already?

**Key question:** Is "platform where existing powerful agents collaborate" a viable product category, or will agent vendors (Anthropic, OpenAI) solve multi-agent coordination themselves?

### 3. Technical Feasibility of MCP Approach

**Practical considerations:**
- Token cost of coordination: every `room_read_context` call consumes agent tokens. What is a realistic "coordination overhead" budget? (e.g., if an agent has 200k context, how much can Agoryx reasonably use?)
- MCP output size limits in Claude Code and Codex — what are the actual limits, and how to design within them?
- Identity problem: when two agents connect to the same MCP server, how does Agoryx distinguish them? Is there a standard MCP mechanism for client identity?
- Concurrency: if Claude and Codex both read/write the room simultaneously, what consistency guarantees are needed?
- Push vs Pull: MCP is request-response. How does Agent A know that Agent B just posted something? Polling? Notification hints in responses?

**Context delivery (Agoryx's core IP):**
- How should `room_get_context` work? Full history dump? Rolling summary? Event-since-cursor?
- What's the optimal format for LLM consumption? (markdown? structured JSON? conversation format?)
- Can Agoryx pre-compute context summaries to minimize response latency?

**Key question:** Can MCP deliver a good enough coordination experience, or will its limitations (stateless, pull-based, size-limited) make the UX too clunky?

### 4. Product-Market Fit

**Target users:**
- Who exactly needs multi-agent collaboration today? What's their current workaround?
- Are developers who use both Claude Code and Codex a real segment, or is it niche?
- What's the "hair on fire" problem that Agoryx solves? Is context re-entry painful enough to drive adoption?
- Would teams (multiple humans + multiple agents) be a stronger use case than solo developers?

**Adoption path:**
- MCP server approach: user adds one line to their claude code config → instant room access. Is this frictionless enough?
- What's the minimal viable room experience? (just reading each other's messages? shared files? task coordination?)
- How does this compare to just using a shared CLAUDE.md or AGENTS.md file?

**Key question:** Is the problem (multi-agent coordination) real and painful enough for people to adopt a new tool? Or will ad-hoc solutions (copy-paste, bridge files, manual context sharing) suffice?

### 5. Architecture Recommendations

Based on your research, recommend:
- Which protocol(s) should Agoryx adopt for v1?
- What should the minimal MCP server look like (tools, resources, prompts)?
- Should Agoryx keep the CLI-wrapper mode alongside MCP, or fully commit to one approach?
- What's the right order of implementation? (e.g., MCP server first → daemon → web UI)
- Are there architectural patterns from other domains (distributed systems, message queues, collaborative editors) that apply here?

---

## Expected Output

Please structure your response as:
1. **Executive Summary** — one paragraph with your overall assessment
2. **Protocol Analysis** — detailed comparison with recommendation
3. **Competitive Landscape** — who's doing what and where Agoryx fits
4. **Technical Feasibility** — honest assessment of MCP approach with mitigations
5. **Market Assessment** — who needs this and how big is the opportunity
6. **Recommended Architecture** — concrete next steps
7. **Risks & Mitigations** — what could go wrong and how to hedge

Be direct and honest. If the MCP approach has fundamental problems, say so. If the whole product category is questionable, say so. I need clear-eyed analysis, not encouragement.
