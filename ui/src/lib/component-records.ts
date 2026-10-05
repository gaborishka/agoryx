import type { TableComponentKind, TableItem, TableNote, TableOption, TableState } from "../../../internal/agora/types.js";

export interface ComponentRecords {
  options: TableOption[];
  steps: TableItem[];
  notes: TableNote[];
  claims: TableItem[];
}

/** Native cards resolve actual records, including evidence explicitly named beside steps. */
export const componentRecords = (table: TableState, refs: readonly string[]): ComponentRecords => {
  const ids = new Set(refs);
  const questions = new Set(table.questions.filter(question => ids.has(question.id)).map(question => question.id));
  const steps = table.next.filter(step => ids.has(step.id) || Boolean(step.target && ids.has(step.target)));
  const targets = new Set([...ids, ...steps.map(step => step.id)]);
  return {
    options: table.options.filter(option => ids.has(option.id) || Boolean(option.q && questions.has(option.q))),
    steps,
    notes: table.notes.filter(note => ids.has(note.id) || targets.has(note.target)),
    claims: [...table.facts, ...table.settled].filter(claim => ids.has(claim.id)),
  };
};

/** Keep the first look short while counting every record available through expansion. */
export const componentWindow = (records: ComponentRecords, kind: TableComponentKind, expanded: boolean): ComponentRecords & { omitted: number } => {
  const limits: Partial<Record<keyof ComponentRecords, number>> = kind === "comparison" ? { options: 6 } : kind === "artifact" ? { options: 3 } : kind === "plan" || kind === "checks" ? { steps: 8, notes: 5, claims: 5 } : {};
  let omitted = 0;
  const take = <T>(key: keyof ComponentRecords, rows: T[]): T[] => {
    const limit = limits[key];
    if (limit === undefined) return [];
    const visible = expanded ? rows : rows.slice(0, limit);
    omitted += rows.length - visible.length;
    return visible;
  };
  const visible = { options: take("options", records.options), steps: take("steps", records.steps), notes: take("notes", records.notes), claims: take("claims", records.claims) };
  return { ...visible, omitted };
};

/** An open proposal under a closed question is no longer an available choice. */
export const optionStanding = (table: TableState, option: TableOption): { label: string; canChoose: boolean } => {
  if (option.status === "chosen") return { label: "Chosen", canChoose: false };
  if (option.status === "withdrawn") return { label: "Withdrawn", canChoose: false };
  const question = option.q ? table.questions.find(item => item.id === option.q) : undefined;
  if (question?.status === "decided") return { label: "Not chosen", canChoose: false };
  if (question?.status === "answered") return { label: "Question closed", canChoose: false };
  if (option.q && !question) return { label: "Question unavailable", canChoose: false };
  return { label: "Open option", canChoose: true };
};
