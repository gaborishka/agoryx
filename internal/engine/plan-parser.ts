import type { TeamPlan, TeamPlanAssignment } from "../events/types.js";

const PLAN_BLOCK_PATTERN = /PLAN:\s*\n([\s\S]*?)(?:PLAN_END|$)/i;
const PLAN_ACCEPT_PATTERN = /^\s*PLAN_ACCEPT\s*$/im;
const ASSIGNMENT_PATTERN = /^-\s*agent:\s*(\S+)\s*\n\s*task:\s*(.+)\s*\n\s*files:\s*(.+)/gim;

export const parseTeamPlan = (
  text: string,
  availableAgents: string[],
): TeamPlan | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (PLAN_ACCEPT_PATTERN.test(trimmed)) {
    return { assignments: [], accepted: true, raw: trimmed };
  }

  const blockMatch = PLAN_BLOCK_PATTERN.exec(trimmed);
  if (!blockMatch?.[1]) return null;

  const block = blockMatch[1];
  const agentSet = new Set(availableAgents.map((a) => a.toLowerCase()));
  const assignments: TeamPlanAssignment[] = [];

  ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT_PATTERN.exec(block)) !== null) {
    const agent = match[1]!.toLowerCase();
    if (!agentSet.has(agent)) continue;

    const task = match[2]!.trim();
    const filesRaw = match[3]!.trim();
    const files = parseFilesList(filesRaw);

    assignments.push({ agent, task, files });
  }

  if (assignments.length === 0) {
    return null;
  }

  return { assignments, accepted: false, raw: trimmed };
};

const parseFilesList = (raw: string): string[] => {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((f: string) => f.trim());
    } catch {
      // Fall through to comma-separated
    }
  }
  return raw.split(",").map((f) => f.trim()).filter(Boolean);
};
