import type { TableDecision, TableState } from "./types.js";

/** Current choices, indexed once; reopening or moving a proposal preserves only historical decisions. */
export const currentDecisionIds = (table: TableState): Set<string> => {
  const options = new Map(table.options.map(option => [option.id, option]));
  const questions = new Map(table.questions.map(question => [question.id, question]));
  const latest = new Map<string, TableDecision>();
  for (const decision of table.decisions) {
    const previous = latest.get(decision.option);
    if (!previous || previous.seq < decision.seq) latest.set(decision.option, decision);
  }
  const current = new Set<string>();
  for (const decision of latest.values()) {
    const option = options.get(decision.option);
    if (!option || option.status !== "chosen" || option.q !== decision.q) continue;
    const question = decision.q ? questions.get(decision.q) : undefined;
    if (!decision.q || (question && (question.many || (question.status === "decided" && question.decision === decision.id)))) current.add(decision.id);
  }
  return current;
};
