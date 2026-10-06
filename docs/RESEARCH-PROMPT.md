# Open product and engineering research

This is a research brief for the current Agoryx 0.1.1 baseline. It is not an implementation plan or a claim that the items below already exist.

## Start from the implemented product

Agoryx already has a local HTTP/SSE daemon, native Claude/Codex execution, a React UI, an Electron macOS shell, projects, explicit memory, a shared table and four structured protocols alongside Chat and Work.

Private phases use a tested macOS process boundary, provider gateways and atomic reveal. The shared browser integration is a scoped MCP surface; it is not a general hosted multi-user room service. Read the [architecture](ARCHITECTURE.md) and [workflow contracts](WORKFLOWS.md) before proposing replacements.

## Questions worth testing

1. **Outcome quality.** Under which tasks does Council, Verification, Tournament or Debate improve the result over one strong agent or ordinary shared Chat? Measure task success, time, provider usage, human corrections and lost disagreements.
2. **Mode discovery.** Can a new user choose a suitable mode from the composer without learning the implementation? Test transitions within a project and whether the table reduces transcript reading.
3. **Portable isolation.** Which Linux/Windows boundary can enforce the same file, process, network and lifecycle contract? A separate directory is not sufficient. Specify hostile tests and fail-closed behavior.
4. **Installation.** Can Node and native-CLI discovery be made simpler without breaking provider compatibility or bundling credentials? Evaluate Intel/universal desktop distribution separately from the existing arm64 build.
5. **Additional providers.** What minimum session, tool, identity, cancellation and output contracts are necessary for a new native agent?
6. **Interoperability.** Which room capabilities should be exposed through a broader protocol? Preserve actor authority, explicit recipients, history, changes and private-phase access restrictions.
7. **Multi-user work.** What new identity, permissions, audit and data-sharing rules would be required? A paired phone acting as the local human is not multi-user tenancy.

## Expected evidence

For each proposal, identify the user's problem, current behavior, a bounded experiment, success criteria, source evidence, risks and a switch condition. Keep implemented behavior, tested hypotheses and future ideas separate. Do not infer market size or provider compatibility from an architectural resemblance.

Earlier comparisons and plans are [archived](archive/README.md) and may describe old versions.
