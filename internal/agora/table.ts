import type {
  TableItem,
  TableOp,
  TableOpName,
  TableState,
} from "./types.js";

export class TableOpError extends Error {}

export const emptyTable = (): TableState => ({
  questions: [],
  options: [],
  notes: [],
  facts: [],
  settled: [],
  next: [],
  decisions: [],
});

const TABLE_OPS: ReadonlySet<TableOpName> = new Set([
  "ask",
  "propose",
  "object",
  "support",
  "evidence",
  "fact",
  "settle",
  "next",
  "done",
  "withdraw",
  "decide",
  "reopen",
]);

const MAX_TEXT = 4000;
/** A proposal body can carry a diagram or a whole html page. */
const MAX_BODY = 24_000;

const cleanText = (value: unknown, field: string, required = true, max = MAX_TEXT): string | undefined => {
  if (value === undefined || value === null || value === "") {
    if (required) throw new TableOpError(`missing ${field}`);
    return undefined;
  }
  if (typeof value !== "string") throw new TableOpError(`${field} must be a string`);
  const text = value.trim();
  if (!text && required) throw new TableOpError(`missing ${field}`);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const normalizeRef = (value: unknown): string => {
  const ref = cleanText(value, "target")!.toUpperCase().replace(/^#/, "");
  if (!/^[A-Z]\d+$/.test(ref)) throw new TableOpError(`'${ref}' is not a table id (like P1, Q2, X3)`);
  return ref;
};

const latestOpenQuestion = (table: TableState): string | null => {
  for (let i = table.questions.length - 1; i >= 0; i -= 1) {
    if (table.questions[i]!.status === "open") return table.questions[i]!.id;
  }
  return null;
};

/**
 * Validate a table op against the current table and assign the id of the
 * entity it creates. Throws TableOpError with a message meant for whoever
 * issued the op (an agent reading CLI output, or the human in the UI).
 */
export const prepareTableOp = (
  table: TableState,
  raw: unknown,
  by: string,
  isHuman: boolean,
): TableOp => {
  if (!raw || typeof raw !== "object") throw new TableOpError("op must be an object");
  const input = raw as Record<string, unknown>;
  const op = input.op as TableOpName;
  if (!TABLE_OPS.has(op)) throw new TableOpError(`unknown table op '${String(input.op)}'`);
  const nonce = typeof input.nonce === "string" ? input.nonce.slice(0, 64) : undefined;
  const base = { by, ...(nonce ? { nonce } : {}) };

  const option = (ref: string) => {
    const found = table.options.find((o) => o.id === ref);
    if (!found) throw new TableOpError(`no option ${ref} on the table`);
    return found;
  };

  switch (op) {
    case "ask":
      return { ...base, op, text: cleanText(input.text, "question text")!, id: `Q${table.questions.length + 1}` };
    case "propose": {
      // Agents often guess the next id into the title ("P9: …"); the table assigns ids itself.
      const title = cleanText(input.title, "title")!.replace(/^P\d+\s*[:.—–-]\s*/i, "") || cleanText(input.title, "title")!;
      const body = cleanText(input.body, "body", false, MAX_BODY);
      const file = cleanText(input.file, "file", false);
      let q: string | undefined;
      if (input.q !== undefined && input.q !== null && input.q !== "") {
        q = normalizeRef(input.q);
        if (!table.questions.some((item) => item.id === q)) throw new TableOpError(`no question ${q}`);
      } else {
        q = latestOpenQuestion(table) ?? undefined;
      }
      return {
        ...base,
        op,
        title: title.length > 160 ? `${title.slice(0, 160)}…` : title,
        ...(body ? { body } : {}),
        ...(file ? { file } : {}),
        ...(q ? { q } : {}),
        id: `P${table.options.length + 1}`,
      };
    }
    case "object":
    case "support":
    case "evidence": {
      const target = normalizeRef(input.target);
      option(target);
      const source = cleanText(input.source, "source", false);
      return {
        ...base,
        op,
        target,
        text: cleanText(input.text, "text")!,
        ...(source ? { source } : {}),
        id: `N${table.notes.length + 1}`,
      };
    }
    case "fact":
      return { ...base, op, text: cleanText(input.text, "fact")!, id: `F${table.facts.length + 1}` };
    case "settle":
      return { ...base, op, text: cleanText(input.text, "text")!, id: `S${table.settled.length + 1}` };
    case "next":
      return { ...base, op, text: cleanText(input.text, "text")!, id: `X${table.next.length + 1}` };
    case "done": {
      const target = normalizeRef(input.target);
      if (!table.next.some((item) => item.id === target)) throw new TableOpError(`no next step ${target}`);
      return { ...base, op, target };
    }
    case "withdraw": {
      const target = normalizeRef(input.target);
      const found = option(target);
      if (!isHuman && found.by !== by) throw new TableOpError(`${target} was proposed by ${found.by}; only they can withdraw it`);
      if (found.status !== "open") throw new TableOpError(`${target} is already ${found.status}`);
      return { ...base, op, target };
    }
    case "decide": {
      const target = normalizeRef(input.target);
      const found = option(target);
      if (found.status === "withdrawn") throw new TableOpError(`${target} was withdrawn`);
      if (found.status === "chosen") throw new TableOpError(`${target} is already chosen`);
      if (found.q) {
        const question = table.questions.find((item) => item.id === found.q);
        if (question?.status === "decided") {
          throw new TableOpError(`${found.q} is already decided (${question.decision}); reopen it first`);
        }
      }
      const note = cleanText(input.note, "note", false);
      return { ...base, op, target, ...(note ? { note } : {}), id: `D${table.decisions.length + 1}` };
    }
    case "reopen": {
      const target = normalizeRef(input.target);
      if (target.startsWith("Q")) {
        const question = table.questions.find((item) => item.id === target);
        if (!question) throw new TableOpError(`no question ${target}`);
        if (question.status === "open") throw new TableOpError(`${target} is already open`);
      } else if (target.startsWith("P")) {
        const found = option(target);
        if (found.status === "open") throw new TableOpError(`${target} is already open`);
      } else {
        throw new TableOpError("only questions (Q) and options (P) can be reopened");
      }
      return { ...base, op, target };
    }
  }
};

/** Pure reducer: applies an already-prepared op. */
export const applyTableOp = (table: TableState, op: TableOp, seq: number): void => {
  const item = (text: string): TableItem => ({ id: op.id!, text, by: op.by, seq });
  switch (op.op) {
    case "ask":
      table.questions.push({ id: op.id!, text: op.text, by: op.by, seq, status: "open" });
      return;
    case "propose":
      table.options.push({
        id: op.id!,
        q: op.q ?? null,
        title: op.title,
        ...(op.body ? { body: op.body } : {}),
        ...(op.file ? { file: op.file } : {}),
        by: op.by,
        seq,
        status: "open",
      });
      return;
    case "object":
    case "support":
    case "evidence":
      table.notes.push({
        id: op.id!,
        kind: op.op,
        target: op.target,
        text: op.text,
        ...(op.source ? { source: op.source } : {}),
        by: op.by,
        seq,
      });
      return;
    case "fact":
      table.facts.push(item(op.text));
      return;
    case "settle":
      table.settled.push(item(op.text));
      return;
    case "next":
      table.next.push(item(op.text));
      return;
    case "done": {
      const step = table.next.find((entry) => entry.id === op.target);
      if (step) step.done = true;
      return;
    }
    case "withdraw": {
      const option = table.options.find((entry) => entry.id === op.target);
      if (option) option.status = "withdrawn";
      return;
    }
    case "decide": {
      const option = table.options.find((entry) => entry.id === op.target);
      if (!option) return;
      option.status = "chosen";
      table.decisions.push({
        id: op.id!,
        n: table.decisions.length + 1,
        option: option.id,
        q: option.q,
        by: op.by,
        ...(op.note ? { note: op.note } : {}),
        seq,
      });
      if (option.q) {
        const question = table.questions.find((entry) => entry.id === option.q);
        if (question) {
          question.status = "decided";
          question.decision = op.id!;
        }
      }
      return;
    }
    case "reopen": {
      if (op.target.startsWith("Q")) {
        const question = table.questions.find((entry) => entry.id === op.target);
        if (question) {
          question.status = "open";
          delete question.decision;
        }
        for (const option of table.options) {
          if (option.q === op.target && option.status === "chosen") option.status = "open";
        }
      } else {
        const option = table.options.find((entry) => entry.id === op.target);
        if (!option) return;
        const wasChosen = option.status === "chosen";
        option.status = "open";
        // Un-choosing the option that decided its question reopens the question, so it can be decided again.
        const question = wasChosen && option.q ? table.questions.find((entry) => entry.id === option.q) : undefined;
        const decision = question?.decision ? table.decisions.find((entry) => entry.id === question.decision) : undefined;
        if (question && decision?.option === option.id) {
          question.status = "open";
          delete question.decision;
        }
      }
      return;
    }
  }
};

const quote = (text: string, max = 140): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > max ? `${flat.slice(0, max)}…` : flat}"`;
};

/** One-line human description of an op, used in deltas and system lines. */
export const describeTableOp = (op: TableOp, table?: TableState): string => {
  const titleOf = (ref: string) => {
    const option = table?.options.find((entry) => entry.id === ref);
    return option ? ` ${quote(option.title, 60)}` : "";
  };
  switch (op.op) {
    case "ask":
      return `asked ${op.id} ${quote(op.text)}`;
    case "propose":
      return `proposed ${op.id} ${quote(op.title, 80)}${op.q ? ` for ${op.q}` : ""}${op.file ? ` (preview: ${op.file})` : ""}`;
    case "object":
      return `objected to ${op.target}${titleOf(op.target)}: ${quote(op.text)}`;
    case "support":
      return `supported ${op.target}${titleOf(op.target)}: ${quote(op.text)}`;
    case "evidence":
      return `added evidence to ${op.target}: ${quote(op.text)}${op.source ? ` [${op.source}]` : ""}`;
    case "fact":
      return `noted fact ${op.id}: ${quote(op.text)}`;
    case "settle":
      return `marked settled: ${quote(op.text)}`;
    case "next":
      return `added next step ${op.id}: ${quote(op.text)}`;
    case "done":
      return `marked ${op.target} done`;
    case "withdraw":
      return `withdrew ${op.target}${titleOf(op.target)}`;
    case "decide":
      return `decided ${op.target}${titleOf(op.target)} (${op.id})${op.note ? `: ${quote(op.note)}` : ""}`;
    case "reopen":
      return `reopened ${op.target}`;
  }
};

/** Markdown snapshot of the table, written to <workspace>/.agoryx/TABLE.md for agents. */
export const renderTableMarkdown = (table: TableState, roomName: string): string => {
  const lines: string[] = [`# Table — ${roomName}`, ""];
  const isEmpty =
    table.questions.length === 0 &&
    table.options.length === 0 &&
    table.facts.length === 0 &&
    table.settled.length === 0 &&
    table.next.length === 0;
  if (isEmpty) {
    lines.push("The table is empty. `agoryx table ask \"...\"` opens a question.");
    return `${lines.join("\n")}\n`;
  }

  const renderOption = (optionId: string) => {
    const option = table.options.find((entry) => entry.id === optionId)!;
    const mark = option.status === "chosen" ? " ✓ CHOSEN" : option.status === "withdrawn" ? " (withdrawn)" : "";
    lines.push(`- **${option.id}** ${option.title} — by ${option.by}${mark}`);
    if (option.body) lines.push(`  ${option.body.replace(/\n/g, "\n  ")}`);
    if (option.file) lines.push(`  preview: ${option.file}`);
    for (const note of table.notes.filter((entry) => entry.target === option.id)) {
      const sign = note.kind === "object" ? "✗ objection" : note.kind === "support" ? "✓ support" : "◆ evidence";
      lines.push(`  - ${sign} (${note.by}): ${note.text}${note.source ? ` [${note.source}]` : ""}`);
    }
  };

  for (const question of table.questions) {
    const status = question.status === "decided" ? `decided → ${question.decision}` : "open";
    lines.push(`## ${question.id} · ${question.text}`, `_asked by ${question.by} · ${status}_`, "");
    const options = table.options.filter((entry) => entry.q === question.id);
    if (options.length === 0) lines.push("- (no options yet)");
    for (const option of options) renderOption(option.id);
    lines.push("");
  }
  const loose = table.options.filter((entry) => !entry.q);
  if (loose.length > 0) {
    lines.push("## Other proposals", "");
    for (const option of loose) renderOption(option.id);
    lines.push("");
  }
  if (table.decisions.length > 0) {
    lines.push("## Decisions");
    for (const decision of table.decisions) {
      const option = table.options.find((entry) => entry.id === decision.option);
      lines.push(`- Decision №${decision.n} (${decision.id}): ${decision.option} ${option ? quote(option.title, 80) : ""} — by ${decision.by}${decision.note ? ` — ${decision.note}` : ""}`);
    }
    lines.push("");
  }
  const section = (title: string, items: TableItem[]) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    for (const entry of items) lines.push(`- ${entry.done ? "~~" : ""}${entry.id}: ${entry.text}${entry.done ? "~~" : ""} (${entry.by})`);
    lines.push("");
  };
  section("Facts", table.facts);
  section("Settled", table.settled);
  section("Next", table.next);
  return `${lines.join("\n")}\n`;
};

/** What the table still holds open: questions without an answer, undecided options, steps not done. */
export const openOnTable = (table: TableState): { questions: number; options: number; steps: number } => ({
  questions: table.questions.filter((question) => question.status === "open").length,
  options: table.options.filter((option) => option.status === "open").length,
  steps: table.next.filter((step) => !step.done).length,
});

/**
 * The table's current state for the end of a delta: what is still open, where
 * each live option stands, what is settled and what someone still has to do.
 * The state, not the moves — the moves are in the transcript above it.
 */
export const summarizeTable = (table: TableState): string | null => {
  const openQuestions = table.questions.filter((question) => question.status === "open");
  const liveOptions = table.options.filter((option) => option.status === "open");
  const pending = table.next.filter((step) => !step.done);
  const empty = [openQuestions, liveOptions, pending, table.decisions, table.facts, table.settled].every((list) => list.length === 0);
  if (empty) return null;

  const standing = (option: TableState["options"][number]): string => {
    const notes = table.notes.filter((note) => note.target === option.id);
    const count = (kind: string) => notes.filter((note) => note.kind === kind).length;
    const bits = [option.by];
    if (count("support")) bits.push(`${count("support")} support`);
    if (count("object")) bits.push(`${count("object")} objection${count("object") > 1 ? "s" : ""}`);
    if (count("evidence")) bits.push(`${count("evidence")} evidence`);
    if (option.file) bits.push(`preview ${option.file}`);
    return `${option.id} ${quote(option.title, 70)} (${bits.join(", ")})`;
  };

  const lines: string[] = [];
  for (const question of openQuestions) {
    const options = liveOptions.filter((option) => option.q === question.id);
    lines.push(`  ${question.id} open ${quote(question.text, 100)}${options.length ? "" : " — no options yet"}`);
    for (const option of options) lines.push(`    ${standing(option)}`);
  }
  for (const option of liveOptions.filter((entry) => !entry.q || !openQuestions.some((question) => question.id === entry.q))) {
    lines.push(`  ${standing(option)}`);
  }
  for (const decision of table.decisions.slice(-3)) {
    const option = table.options.find((entry) => entry.id === decision.option);
    lines.push(`  decided: ${decision.option}${option ? ` ${quote(option.title, 70)}` : ""}${decision.q ? ` for ${decision.q}` : ""}`);
  }
  if (table.facts.length > 0) lines.push(`  facts: ${table.facts.slice(-4).map((item) => `${item.id} ${quote(item.text, 70)}`).join("; ")}`);
  if (table.settled.length > 0) lines.push(`  settled: ${table.settled.slice(-4).map((item) => `${item.id} ${quote(item.text, 70)}`).join("; ")}`);
  if (pending.length > 0) lines.push(`  to do: ${pending.map((step) => `${step.id} ${quote(step.text, 70)}`).join("; ")}`);
  return lines.join("\n");
};
