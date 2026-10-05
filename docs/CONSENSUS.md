# Current product and engineering decisions

These decisions describe the Agoryx 0.1.0 release baseline. Earlier implementation plans are [archived](archive/README.md).

## Product

1. **The shared conversation is the product.** Humans and multiple native agents collaborate in one place. Agoryx adds shared context and useful working surfaces around their capabilities.
2. **Local-first and open source.** MIT license; room and project state are stored locally. Provider inference still uses the user's native provider account.
3. **Use existing native sign-ins.** Claude Code and Codex are supported. A core conversation does not require a separately supplied model API key.
4. **Six visible approaches.** Chat, Work, Verification, Council, Tournament and Debate are selected within a conversation, not separate global history silos.
5. **One conversation list.** Group by project when assigned, retain a small mode indicator, and offer one New conversation action.
6. **Independent project membership.** Every mode can belong to a project. The execution folder is a separate choice.
7. **Complementary surfaces.** Conversation holds dialogue, Table holds shared working state, and Sessions holds protocol runs and their results.
8. **Human decisions remain explicit.** Selecting a prototype, combining proposals and overriding a verdict are recorded actions. An agent recommendation is not approval.

## Collaboration

- Ordinary Chat and Work retain shared context and native sessions. No participant is permanently assigned author, reviewer or judge by model brand.
- Protocol roles apply to one session. Participant counts are not assumed to be two: workflow teams support up to eight, with mode-specific minimums and independent roles.
- Council begins with independent private answers. Two participants critique; three or more rank peers. A separate member checks the synthesis for lost disagreement.
- Verification returns findings to the author and records passed, failed and unknown criteria.
- Tournament separates authors from evaluators and waits for human selection before implementation.
- Debate requires accepted restatements before rebuttal. A separate judge preserves unresolved differences and possible deciding tests.
- Private phases are enforced by the operating system, not instructions alone. Results reveal atomically. Unsupported isolation fails closed.
- Moving into a private phase requires explicit selection of materials. No hidden copying of the entire native session.

## Implementation

- TypeScript on Node.js; React/Vite UI; Electron macOS shell.
- Rooms use append-only JSONL events and projections. Project memory is explicitly recorded and attributed.
- The old SQLite CLI remains a distinct compatibility runtime.
- The desktop distribution targets macOS Apple Silicon and uses the user's Node installation.
- Ordinary room work does not auto-commit. Private recovery snapshots do not move HEAD or staged changes.
- Workflow artifacts are inspected/downloaded rather than automatically applied to the user's project.
- Native CLI updates can change behavior. Keep provider handling isolated and test concrete failure cases.
- Preserve source language in quoted material; the current application UI is English.

## Not release promises

Cross-platform private execution, a universal desktop build, hosted multi-user tenancy and arbitrary third-party agent protocols are not claimed as shipped. Model agreement is not proof of truth. Future expansion must preserve the explicit access, actor and evidence boundaries above.
