import type { RoomState } from "./types.js";
import type { WorkflowRun } from "./workflow-types.js";

/** Human-selected conversation context is copied before the blind round. Never read private entries. */
export function conversationMaterials(
  state: RoomState,
  history: WorkflowRun[],
  messageIds: unknown,
  resultIds: unknown,
): Array<{ path: string; text: string }> {
  const ids = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.length > 20 ||
      value.some((id) => typeof id !== "string") ||
      new Set(value).size !== value.length
    )
      throw new Error("Choose at most 20 distinct conversation materials");
    return value;
  };
  const messages = ids(messageIds),
    results = ids(resultIds);
  if (messages.length + results.length > 20)
    throw new Error("Choose at most 20 conversation materials");
  const materials = messages.map((id) => {
    const message = state.messages.find(
      (m) => m.id === id && m.kind !== "pass" && m.kind !== "system",
    );
    if (!message)
      throw new Error(`Message ${id} is not available in this conversation`);
    return {
      path: `conversation/message-${id}.txt`,
      text: `${message.author} · ${message.ts}\n${message.text}`,
    };
  });
  for (const id of results) {
    const run = history.find((r) => r.id === id && r.roomId === state.id);
    if (!run || run.status === "running" || run.status === "waiting_user")
      throw new Error(
        "Only finished sessions in this conversation can be carried forward",
      );
    const revealed = run.rounds.filter((r) => r.status === "revealed");
    if (!revealed.length)
      throw new Error("This session has no revealed result to carry forward");
    materials.push({
      path: `conversation/result-${id}.md`,
      text: workflowHandoffText(run),
    });
  }
  if (materials.reduce((n, m) => n + Buffer.byteLength(m.text), 0) > 200_000)
    throw new Error(
      "Selected conversation materials exceed 200 KB; select fewer items",
    );
  return materials;
}

/** Human-readable transfer preview and frozen input use exactly the same text. */
export function workflowHandoffText(run: WorkflowRun): string {
  return [
    `# ${run.mode} result\nSession: ${run.id} · ${run.status}`,
    `## Original brief\n${run.task}`,
    `## Criteria\n${run.criteria.map((c) => `- ${c}`).join("\n")}`,
    ...(run.selection
      ? [
          `## Human selection\n${run.selection.entryIds.join(" + ")}\n${run.selection.instruction ?? ""}`,
        ]
      : []),
    ...(run.override ? [`## Human decision\n${run.override}`] : []),
    ...(run.report
      ? [
          `## Report\n${run.report.summary}`,
          `## Checks\n${run.report.checks.map((c) => `- ${c.status} — ${c.criterion}: ${c.evidence}`).join("\n")}`,
          `## Unknowns and disagreements\n${run.report.unknowns.map((u) => `- ${u}`).join("\n") || "None reported."}`,
        ]
      : []),
    ...run.rounds
      .filter((r) => r.status === "revealed")
      .slice(-2)
      .map(
        (r) =>
          `## ${r.phase.replaceAll("_", " ")}\n${r.entries
            .filter((e) => e.status === "complete")
            .map((e) => `### ${e.label}\n${e.text ?? ""}`)
            .join("\n\n")}`,
      ),
  ].join("\n\n");
}
