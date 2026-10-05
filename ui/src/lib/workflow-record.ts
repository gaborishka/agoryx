import type { WorkflowRun } from "../../../internal/agora/workflow-types.js";

const titles: Record<WorkflowRun["mode"], string> = {
  verification: "Verification",
  council: "Council",
  tournament: "Tournament",
  debate: "Debate",
};

const selectionRecord = (run: WorkflowRun): string[] => {
  if (!run.selection) return [];
  const prototypes = run.rounds.find(
    (round) => round.phase === "prototypes" && round.status === "revealed",
  );
  const labels = run.selection.entryIds.map(
    (id) => prototypes?.entries.find((entry) => entry.id === id)?.label ?? id,
  );
  return [
    `## Human selection\n${labels.join(" + ")}`,
    ...(run.selection.instruction ? [run.selection.instruction] : []),
  ];
};

const finalReport = (run: WorkflowRun): string[] => run.report ? [
  `## Final report\n${run.report.summary}`,
  ...run.report.checks.map(
    (check) => `- **${check.status} — ${check.criterion}**: ${check.evidence}`,
  ),
  `### Unknowns\n${run.report.unknowns.map((unknown) => `- ${unknown}`).join("\n") || "None reported by the reviewer."}`,
] : [];

/** The human's portable record retains decisions and input provenance, never sealed submissions. */
export function workflowRecord(run: WorkflowRun): string {
  return [
    `# ${titles[run.mode]}`,
    `Session: ${run.id}\nStatus: ${run.status}\nCreated: ${run.createdAt}`,
    `## Original brief\n${run.task}`,
    `## Criteria\n${run.criteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    `## Participants\n${run.participants.map((participant) => `- ${participant.label}: ${participant.role ?? "member"}; ${participant.kind} / ${participant.model ?? "default model"}${participant.effort ? `; effort ${participant.effort}` : ""}`).join("\n")}`,
    `## Shared budget\n${run.budget.timeoutMs} ms and ${run.budget.maxOutputChars} returned characters per submission; ${run.budget.maxRounds} repair attempts.`,
    ...(run.context?.length ? [
      "## Frozen input materials",
      ...run.context.map(({ path, text }) => {
        // Input can itself contain Markdown code fences.
        let fenceLength = 3;
        for (const [match] of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match.length + 1);
        const fence = "`".repeat(fenceLength);
        return `### ${path}\n${fence}\n${text}\n${fence}`;
      }),
    ] : []),
    ...run.rounds.filter((round) => round.status === "revealed").map(
      (round) => `## ${round.phase.replaceAll("_", " ")} · ${round.id}\n${round.entries.map((entry) => `### ${entry.label}\n${entry.text ?? ""}`).join("\n\n")}`,
    ),
    ...selectionRecord(run),
    ...finalReport(run),
    ...(run.override ? [`## Human decision\n${run.override}`] : []),
  ].join("\n\n");
}

/** Decisions, checks and unresolved findings survive even when the narrative needs an excerpt. */
export function workflowDiscussion(run: WorkflowRun): string {
  const last = [...run.rounds].reverse().find((round) => round.status === "revealed");
  const artifact = run.mode === "verification" ? [...run.rounds].reverse().find(
    (round) => round.status === "revealed" && ["creation", "repair"].includes(round.phase),
  ) : undefined;
  const artifactText = artifact ? `## Latest artifact\n${artifact.entries.filter((entry) => entry.status === "complete").map((entry) => `${entry.label}:\n${entry.text ?? ""}`).join("\n\n")}` : "";
  const narrative = (run.report ? [`## Final report\n${run.report.summary}`] : last === artifact ? [] : last?.entries.map(
    (entry) => `${entry.label}:\n${entry.text ?? ""}`,
  ) ?? []).join("\n\n");
  // Neither a large artifact nor a long report may crowd the other out of the handoff.
  const budget = 20_000;
  const excerpt = (text: string, limit: number) => `${text.slice(0, limit)}${text.length > limit ? "\n\n[Excerpt; full result remains in the session record.]" : ""}`;
  const result = [
    excerpt(narrative, budget - Math.min(artifactText.length, budget / 2)),
    excerpt(artifactText, budget - Math.min(narrative.length, budget / 2)),
  ].filter(Boolean).join("\n\n");
  return [
    `Let’s discuss the ${titles[run.mode].toLowerCase()} result.`,
    ...(run.override ? [`## Human decision\n${run.override}`] : []),
    ...selectionRecord(run),
    `## Original brief\n${run.task}`,
    `## Criteria\n${run.criteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    ...(run.report ? [
      `## Checks\n${run.report.checks.map((check) => `- **${check.status} — ${check.criterion}**: ${check.evidence}`).join("\n") || "No structured criterion checks in this mode."}`,
      `## Unknowns and unresolved disagreements\n${run.report.unknowns.map((unknown) => `- ${unknown}`).join("\n") || "None reported by the reviewer."}`,
    ] : []),
    result,
  ].join("\n\n");
}
