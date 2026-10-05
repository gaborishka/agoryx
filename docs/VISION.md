# Vision

Agoryx gives a person and their AI agents one place to work together. The name comes from the Greek agorá: a place for discussion and decisions.

## The problem

Using several assistants often means moving messages and files between applications, repeatedly explaining context, and manually comparing outputs. Parallel answers alone do not produce a useful shared result. People need to understand what changed, what was checked, where agents disagree and what decision is theirs.

## The product

A conversation is the durable home for a task. It can begin as a question, become independent Council answers, continue as Work, and finish with Verification. Project context stays connected throughout.

The interface should make that sequence legible:

- A simple composer makes the mode and project clear.
- A unified sidebar helps find related work.
- The table presents current state and meaningful decisions.
- Dedicated protocol boards expose evidence, alternatives and disagreements.
- The conversation remains available whenever dialogue is the better tool.

## Principles

**Keep native capabilities.** Agents remain Claude Code or Codex sessions with their tools and models. Agoryx coordinates shared work around them.

**Make independence real.** An independent answer is meaningful only when the system prevents access to peer work until reveal.

**Preserve disagreement.** A short synthesis must not erase a minority argument, failed criterion or unknown.

**Attribute work.** People should see who proposed, checked, decided and changed something.

**Keep the human's decision visible.** Human intervention is available without turning every discussion into a rigid approval workflow.

**Prefer explicit memory.** A recorded decision or disagreement has an author and source; it is not silently promoted from transient output into fact.

**Stay local-first.** Keep coordination and durable state on the user's machine, with explicit remote-provider and phone-access boundaries.

## Who it serves today

The first release serves people who use native coding agents for software, research, writing, planning and prototypes. The workflows apply to artifacts beyond code, although tools and desktop distribution are currently centered on macOS and native developer CLIs.

## What success looks like

A user can start a task, choose a suitable approach, understand the result without reconstructing the entire transcript, and continue with another mode in the same project. Evidence should distinguish executed checks, inspection and unresolved uncertainty.

## Future work

Potential directions include additional providers, portable private-execution backends, easier installation and stronger evaluation of multi-agent outcomes. These are research directions, not dated commitments. Current capabilities and limitations are in the [README](../README.md) and [workflow guide](WORKFLOWS.md).
