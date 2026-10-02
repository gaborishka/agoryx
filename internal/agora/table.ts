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
  shifts: [],
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
  "review",
  "done",
  "withdraw",
  "decide",
  "reopen",
  "concede",
  "edit",
  "delete",
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

/** Any item on the table with this id. */
const refOnTable = (table: TableState, ref: string): boolean =>
  [table.questions, table.options, table.notes, table.facts, table.settled, table.next, table.decisions, table.shifts].some((list) =>
    list.some((entry) => entry.id === ref),
  );

/** The next id with this letter: past every id given out before, so a deleted item's id is never reused. */
const nextId = (table: TableState, letter: string, list: { id: string }[]): string => {
  const highest = Math.max(table.issued?.[letter] ?? 0, 0, ...list.map((entry) => Number(entry.id.slice(1)) || 0));
  return `${letter}${highest + 1}`;
};

type Editable = { by: string; text?: string; title?: string; withdrawn?: boolean; done?: boolean };

/** The list an id belongs to, by its letter, and the entry in it. */
const lookup = (table: TableState, ref: string): { list: Editable[] & { id: string }[]; entry: Editable & { id: string } } | null => {
  const lists: Record<string, Array<Editable & { id: string }>> = {
    Q: table.questions,
    P: table.options,
    N: table.notes,
    F: table.facts,
    S: table.settled,
    X: table.next,
    C: table.shifts,
  };
  const list = lists[ref[0]!];
  const entry = list?.find((item) => item.id === ref);
  return list && entry ? { list, entry } : null;
};

/** What `edit` may change on each kind of item. */
const EDITABLE: Record<string, string[]> = {
  Q: ["text", "many"],
  P: ["title", "body", "file", "q"],
  N: ["text", "source"],
  F: ["text"],
  S: ["text"],
  X: ["text"],
  C: ["text"],
};

const short = (entry: Editable): string => {
  const flat = (entry.title ?? entry.text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
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
  const stepOf = (ref: string) => {
    const found = table.next.find((item) => item.id === ref);
    if (!found) {
      const fact = table.facts.some((item) => item.id === ref);
      throw new TableOpError(`no next step ${ref}${fact ? ` — ${ref} is a fact; to take it back: withdraw ${ref}` : ""}`);
    }
    return found;
  };

  switch (op) {
    case "ask":
      return {
        ...base,
        op,
        text: cleanText(input.text, "question text")!,
        ...(input.many === true ? { many: true } : {}),
        id: nextId(table, "Q", table.questions),
      };
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
        id: nextId(table, "P", table.options),
      };
    }
    case "object":
    case "support":
    case "evidence": {
      const target = normalizeRef(input.target);
      // A settled point or a fact is a claim too: one agent's "settled" can still be disputed by another.
      const point = table.settled.find((item) => item.id === target) ?? table.facts.find((item) => item.id === target);
      if (point) {
        if (point.withdrawn) throw new TableOpError(`${target} is withdrawn`);
        if (op === "object" && point.by === by) {
          throw new TableOpError(
            target.startsWith("F")
              ? `${target} is your own fact — withdraw ${target} if it turned out wrong`
              : `${target} is your own — concede "what you no longer hold" --on ${target} instead`,
          );
        }
      } else if (/^P\d+$/.test(target)) {
        option(target);
      } else if (/^X\d+$/.test(target)) {
        // A check of a step: an objection is a finding, support says it passed.
        const step = table.next.find((item) => item.id === target);
        if (!step) throw new TableOpError(`no step ${target} on the table`);
        if (op === "object" && step.review === by) throw new TableOpError(`${target} is your own step — fix it, then ask for its check again: review ${target}`);
      } else {
        throw new TableOpError(`no ${target} on the table to ${op === "evidence" ? "add evidence to" : op} — it takes an option (P1), a step (X1), a settled point (S1) or a fact (F1)`);
      }
      const source = cleanText(input.source, "source", false);
      return {
        ...base,
        op,
        target,
        text: cleanText(input.text, "text")!,
        ...(source ? { source } : {}),
        id: nextId(table, "N", table.notes),
      };
    }
    case "fact":
      return { ...base, op, text: cleanText(input.text, "fact")!, id: nextId(table, "F", table.facts) };
    case "settle": {
      let q: string | undefined;
      if (input.q !== undefined && input.q !== null && input.q !== "") {
        q = normalizeRef(input.q);
        const question = table.questions.find((item) => item.id === q);
        if (!question) throw new TableOpError(`no question ${q}`);
        if (question.status !== "open") throw new TableOpError(`${q} is already ${question.status}; reopen it first`);
      }
      return { ...base, op, text: cleanText(input.text, "text")!, ...(q ? { q } : {}), id: nextId(table, "S", table.settled) };
    }
    case "concede": {
      let target: string | undefined;
      if (input.target !== undefined && input.target !== null && input.target !== "") {
        target = normalizeRef(input.target);
        if (!refOnTable(table, target)) throw new TableOpError(`no ${target} on the table`);
      }
      return { ...base, op, text: cleanText(input.text, "text")!, ...(target ? { target } : {}), id: nextId(table, "C", table.shifts) };
    }
    case "next": {
      // The route a step carries out: an option still standing.
      let target: string | undefined;
      if (input.target !== undefined && input.target !== null && input.target !== "") {
        target = normalizeRef(input.target);
        if (!target.startsWith("P")) throw new TableOpError(`a step is on an option (a route, like P2), not ${target}`);
        if (option(target).status === "withdrawn") throw new TableOpError(`${target} was withdrawn`);
      }
      return { ...base, op, text: cleanText(input.text, "text")!, ...(target ? { target } : {}), id: nextId(table, "X", table.next) };
    }
    case "review": {
      const target = normalizeRef(input.target);
      const step = stepOf(target);
      if (step.done) throw new TableOpError(`${target} is done`);
      // Its builder asks for the check; one who checks it answers with what it found.
      if (step.review && step.review !== by && !isHuman) {
        throw new TableOpError(`${target} waits for the check ${step.review} asked for — checking it? object ${target} "what fails", or done ${target} once it passes`);
      }
      return { ...base, op, target };
    }
    case "done": {
      const target = normalizeRef(input.target);
      if (stepOf(target).done) throw new TableOpError(`${target} is already done`);
      return { ...base, op, target };
    }
    case "withdraw": {
      const target = normalizeRef(input.target);
      if (target.startsWith("F")) {
        const fact = table.facts.find((item) => item.id === target);
        if (!fact) throw new TableOpError(`no fact ${target} on the table`);
        if (!isHuman && fact.by !== by) throw new TableOpError(`${target} was noted by ${fact.by}; only they can withdraw it`);
        if (fact.withdrawn) throw new TableOpError(`${target} is already withdrawn`);
        return { ...base, op, target };
      }
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
        if (question && question.status !== "open") {
          throw new TableOpError(`${found.q} is already ${question.status} (${question.decision ?? question.answer}); reopen it first`);
        }
      }
      const note = cleanText(input.note, "note", false);
      return { ...base, op, target, ...(note ? { note } : {}), id: nextId(table, "D", table.decisions) };
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
    case "edit": {
      const target = normalizeRef(input.target);
      if (target.startsWith("D")) throw new TableOpError(`${target} is a decision; to undo it, reopen its option`);
      const found = lookup(table, target);
      if (!found) throw new TableOpError(`no ${target} on the table`);
      const { entry } = found;
      if (!isHuman && entry.by !== by) {
        throw new TableOpError(`${target} is ${entry.by}'s; only they can rewrite it — object to it, or propose your own`);
      }
      const letter = target[0]!;
      // Option titles come in as the positional text, like `propose "title"`.
      const fields: Record<string, unknown> = { ...input };
      if (letter === "P" && fields.text !== undefined && fields.title === undefined) {
        fields.title = fields.text;
        delete fields.text;
      }
      const given = ["text", "title", "body", "file", "q", "source", "many"].filter((key) => fields[key] !== undefined && fields[key] !== "");
      if (given.length === 0) throw new TableOpError(`nothing to change on ${target}`);
      const wrong = given.filter((key) => !EDITABLE[letter]!.includes(key));
      if (wrong.length) {
        throw new TableOpError(`${target} has no ${wrong.join(", ")} to change (it takes ${EDITABLE[letter]!.map((key) => (letter === "P" && key === "title" ? "a new title" : key === "many" ? "--many/--one" : key === "text" ? "new text" : `--${key}`)).join(", ")})`);
      }
      if (entry.withdrawn) throw new TableOpError(`${target} is withdrawn`);
      if (entry.done) throw new TableOpError(`${target} is done`);
      const edit: Record<string, unknown> = {};
      if (letter === "Q") {
        const question = table.questions.find((item) => item.id === target)!;
        if (question.status !== "open") throw new TableOpError(`${target} is already ${question.status}; reopen it first`);
        if (fields.text !== undefined) edit.text = cleanText(fields.text, "question text");
        if (fields.many !== undefined) {
          const many = fields.many === true;
          if (!many && table.options.some((option) => option.q === target && option.status === "chosen")) {
            throw new TableOpError(`${target} already has chosen options; reopen them before making it a one-answer question`);
          }
          edit.many = many;
        }
      } else if (letter === "P") {
        const option = table.options.find((item) => item.id === target)!;
        if (option.status !== "open") throw new TableOpError(`${target} is already ${option.status}; reopen it first`);
        if (fields.title !== undefined) {
          const title = cleanText(fields.title, "title")!.replace(/^P\d+\s*[:.—–-]\s*/i, "") || cleanText(fields.title, "title")!;
          edit.title = title.length > 160 ? `${title.slice(0, 160)}…` : title;
        }
        if (fields.body !== undefined) edit.body = cleanText(fields.body, "body", false, MAX_BODY) ?? "";
        if (fields.file !== undefined) edit.file = cleanText(fields.file, "file", false) ?? "";
        if (fields.q !== undefined) {
          const q = normalizeRef(fields.q);
          const question = table.questions.find((item) => item.id === q);
          if (!question) throw new TableOpError(`no question ${q}`);
          if (question.status !== "open") throw new TableOpError(`${q} is already ${question.status}; reopen it first`);
          edit.q = q;
        }
      } else {
        if (fields.text !== undefined) edit.text = cleanText(fields.text, "text");
        if (fields.source !== undefined) edit.source = cleanText(fields.source, "source", false) ?? "";
      }
      return { ...base, op, target, ...edit };
    }
    case "delete": {
      const target = normalizeRef(input.target);
      if (target.startsWith("D")) throw new TableOpError(`${target} is a decision; to undo it, reopen its option`);
      const found = lookup(table, target);
      if (!found) throw new TableOpError(`no ${target} on the table`);
      const { entry } = found;
      if (!isHuman && entry.by !== by) {
        throw new TableOpError(`${target} is ${entry.by}'s; only they can delete it — object to it instead`);
      }
      if (target.startsWith("P") && table.options.find((item) => item.id === target)!.status === "chosen") {
        throw new TableOpError(`${target} is chosen; reopen it first`);
      }
      if (target.startsWith("Q")) {
        const question = table.questions.find((item) => item.id === target)!;
        if (question.status === "decided" || table.options.some((option) => option.q === target && option.status === "chosen")) {
          throw new TableOpError(`${target} has a decision; reopen it first`);
        }
      }
      return { ...base, op, target, was: short(entry) };
    }
  }
};

/**
 * Pure reducer: applies an already-prepared op. `room`: who did it and how many agents the room had then, which
 * decide whether a step marked done was checked.
 */
export const applyTableOp = (table: TableState, op: TableOp, seq: number, room: { alone?: boolean; human?: boolean } = {}): void => {
  const item = (text: string): TableItem => ({ id: op.id!, text, by: op.by, seq });
  if (op.id) {
    const letter = op.id[0]!;
    table.issued = { ...table.issued, [letter]: Math.max(table.issued?.[letter] ?? 0, Number(op.id.slice(1)) || 0) };
  }
  switch (op.op) {
    case "ask":
      table.questions.push({ id: op.id!, text: op.text, by: op.by, seq, status: "open", ...(op.many ? { many: true } : {}) });
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
    case "settle": {
      table.settled.push({ ...item(op.text), ...(op.q ? { q: op.q } : {}) });
      const question = op.q ? table.questions.find((entry) => entry.id === op.q) : undefined;
      // On a question whose options don't exclude each other, a settled point is the room's recommendation:
      // the options stay open for the human to choose.
      if (question && question.status === "open" && !question.many) {
        question.status = "answered";
        question.answer = op.id!;
      }
      return;
    }
    case "concede":
      table.shifts.push({ ...item(op.text), ...(op.target ? { target: op.target } : {}) });
      return;
    case "next":
      table.next.push({ ...item(op.text), ...(op.target ? { target: op.target } : {}) });
      return;
    case "review": {
      const step = table.next.find((entry) => entry.id === op.target);
      if (step) {
        step.review = op.by;
        step.reviewSeq = seq;
      }
      return;
    }
    case "done": {
      const step = table.next.find((entry) => entry.id === op.target);
      if (step) {
        step.done = true;
        step.doneBy = op.by;
        // Checked: someone other than the one who asked for its check passed it (marked it done, or supported it since
        // it was asked for and has not objected since), or the human did. With no check asked for, nobody can tell a
        // check from its builder closing it. Alone, an agent's own check is the check.
        const passed = (who: string) => who !== step.review;
        const mine = table.notes.filter((note) => note.target === step.id && note.seq > (step.reviewSeq ?? 0));
        const support = mine.filter((note) => note.kind === "support" && passed(note.by) && !mine.some((later) => later.kind === "object" && later.by === note.by && later.seq > note.seq)).at(-1);
        if (room.human || (step.review && passed(op.by))) {
          step.checked = true;
          step.checkedBy = op.by;
        } else if (step.review && support) {
          step.checked = true;
          step.checkedBy = support.by;
        } else if (room.alone) step.checked = true;
      }
      return;
    }
    case "withdraw": {
      const fact = table.facts.find((entry) => entry.id === op.target);
      if (fact) fact.withdrawn = true;
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
        // A `many` question stays open while any of its options is still open.
        const rest = question?.many && table.options.some((entry) => entry.q === question.id && entry.status === "open");
        if (question && !rest) {
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
          delete question.answer;
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
        if (question && (question.many ? question.status === "decided" : decision?.option === option.id)) {
          question.status = "open";
          delete question.decision;
        }
      }
      return;
    }
    case "edit": {
      const found = lookup(table, op.target);
      if (!found) return;
      const entry = found.entry as Editable & Record<string, unknown>;
      for (const key of ["text", "title", "body", "file", "q", "source"] as const) {
        const value = op[key];
        if (value === undefined) continue;
        if (value === "") delete entry[key];
        else entry[key] = value;
      }
      if (op.many !== undefined) {
        if (op.many) entry.many = true;
        else delete entry.many;
      }
      return;
    }
    case "delete": {
      const found = lookup(table, op.target);
      if (!found) return;
      found.list.splice(found.list.indexOf(found.entry), 1);
      // What hangs on it goes with it; options of a deleted question stay, as proposals of their own.
      table.notes = table.notes.filter((note) => note.target !== op.target);
      for (const option of table.options) if (option.q === op.target) option.q = null;
      for (const point of table.settled) if (point.q === op.target) delete point.q;
      for (const step of table.next) if (step.target === op.target) delete step.target;
      for (const question of table.questions) {
        if (question.answer === op.target) {
          question.status = "open";
          delete question.answer;
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

/**
 * One-line human description of an op, used in deltas and system lines. `wholeDissent` keeps an
 * objection's or a concession's reason unshortened (a turn prompt): a clipped objection can read as a
 * quibble, and a clipped concession as more than was given up.
 */
export const describeTableOp = (op: TableOp, table?: TableState, options: { wholeDissent?: boolean } = {}): string => {
  const dissent = (text: string) => (options.wholeDissent ? quote(text, Infinity) : quote(text));
  const titleOf = (ref: string) => {
    const option = table?.options.find((entry) => entry.id === ref);
    if (option) return ` ${quote(option.title, 60)}`;
    const point = table?.settled.find((entry) => entry.id === ref) ?? table?.facts.find((entry) => entry.id === ref) ?? table?.next.find((entry) => entry.id === ref);
    return point ? ` ${quote(point.text, 60)}` : "";
  };
  switch (op.op) {
    case "ask":
      return `asked ${op.id} ${quote(op.text)}`;
    case "propose":
      return `proposed ${op.id} ${quote(op.title, 80)}${op.q ? ` for ${op.q}` : ""}${op.file ? ` (preview: ${op.file})` : ""}`;
    case "object":
      return `objected to ${op.target}${titleOf(op.target)}: ${dissent(op.text)}`;
    case "support":
      return `supported ${op.target}${titleOf(op.target)}: ${quote(op.text)}`;
    case "evidence":
      return `added evidence to ${op.target}${titleOf(op.target)}: ${quote(op.text)}${op.source ? ` [${op.source}]` : ""}`;
    case "fact":
      return `noted fact ${op.id}: ${quote(op.text)}`;
    case "settle":
      if (op.q && table?.questions.find((entry) => entry.id === op.q)?.many) return `recommended for ${op.q} (${op.id}): ${quote(op.text)}`;
      return op.q ? `answered ${op.q} (${op.id}): ${quote(op.text)}` : `marked settled: ${quote(op.text)}`;
    case "concede":
      return `conceded${op.target ? ` on ${op.target}` : ""} (${op.id}): ${dissent(op.text)}`;
    case "next":
      return `added next step ${op.id}${op.target ? ` on ${op.target}` : ""}: ${quote(op.text)}`;
    case "review":
      return `asked for a check of ${op.target}${titleOf(op.target)}`;
    case "done":
      return `marked ${op.target} done`;
    case "withdraw": {
      const fact = table?.facts.find((entry) => entry.id === op.target);
      return `withdrew ${op.target}${fact ? ` ${quote(fact.text, 60)}` : titleOf(op.target)}`;
    }
    case "decide":
      return `decided ${op.target}${titleOf(op.target)} (${op.id})${op.note ? `: ${quote(op.note)}` : ""}`;
    case "reopen":
      return `reopened ${op.target}`;
    case "edit": {
      const what = [
        op.title !== undefined || op.text !== undefined ? quote(op.title ?? op.text ?? "", 80) : "",
        op.body !== undefined ? "(new body)" : "",
        op.file !== undefined ? (op.file ? `(preview: ${op.file})` : "(no preview)") : "",
        op.q !== undefined ? `(moved to ${op.q})` : "",
        op.source !== undefined ? `[${op.source}]` : "",
        op.many !== undefined ? (op.many ? "(any number of options can be chosen)" : "(one option is chosen)") : "",
      ].filter(Boolean);
      return `rewrote ${op.target}${what.length ? ` ${what.join(" ")}` : ""}`;
    }
    case "delete":
      return `deleted ${op.target}${op.was ? ` ${quote(op.was, 80)}` : ""}`;
  }
};

/** Markdown snapshot of the table, written to <workspace>/.agoryx/rooms/<room>/TABLE.md for agents. */
export const renderTableMarkdown = (table: TableState, roomName: string): string => {
  const lines: string[] = [`# Table — ${roomName}`, ""];
  const isEmpty =
    table.questions.length === 0 &&
    table.options.length === 0 &&
    table.facts.length === 0 &&
    table.settled.length === 0 &&
    table.shifts.length === 0 &&
    table.next.length === 0;
  if (isEmpty) {
    lines.push("The table is empty. `agoryx table ask \"...\"` opens a question.");
    return `${lines.join("\n")}\n`;
  }

  const renderNotes = (ref: string) => {
    for (const note of table.notes.filter((entry) => entry.target === ref)) {
      const sign = note.kind === "object" ? "✗ objection" : note.kind === "support" ? "✓ support" : "◆ evidence";
      lines.push(`  - ${sign} (${note.by}): ${note.text}${note.source ? ` [${note.source}]` : ""}`);
    }
  };
  const renderOption = (optionId: string) => {
    const option = table.options.find((entry) => entry.id === optionId)!;
    const mark = option.status === "chosen" ? " ✓ CHOSEN" : option.status === "withdrawn" ? " (withdrawn)" : "";
    lines.push(`- **${option.id}** ${option.title} — by ${option.by}${mark}`);
    if (option.body) lines.push(`  ${option.body.replace(/\n/g, "\n  ")}`);
    if (option.file) lines.push(`  preview: ${option.file}`);
    renderNotes(option.id);
  };

  for (const question of table.questions) {
    const status =
      question.status === "decided"
        ? `decided → ${question.decision}`
        : question.status === "answered"
          ? `answered → ${question.answer}`
          : "open";
    const kind = question.many ? " · any number can be chosen" : "";
    lines.push(`## ${question.id} · ${question.text}`, `_asked by ${question.by}${kind} · ${status}_`, "");
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
  const section = (title: string, items: TableItem[], disputes = false) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    for (const entry of items) {
      const many = entry.q ? table.questions.find((question) => question.id === entry.q)?.many : false;
      const about = entry.q ? ` [${many ? "recommends for" : "answers"} ${entry.q}]` : entry.target ? ` [on ${entry.target}]` : "";
      const struck = entry.done || entry.withdrawn ? "~~" : "";
      const disputed = disputes ? disputeOf(table, entry) : [];
      const stage = entry.id.startsWith("X") ? stepStage(table, entry) : "";
      lines.push(`- ${struck}${entry.id}: ${entry.text}${struck}${about} (${entry.by}${entry.doneBy && entry.doneBy !== entry.by ? `; done by ${entry.doneBy}` : ""}${entry.withdrawn ? "; withdrawn" : ""})${stage ? ` — ${stage}` : ""}${disputed.length ? ` — contested by ${disputed.join(", ")}` : ""}`);
      renderNotes(entry.id);
    }
    lines.push("");
  };
  section("Facts", table.facts, true);
  section("Settled", table.settled, true);
  section("Changed minds", table.shifts);
  section("Next", table.next);
  return `${lines.join("\n")}\n`;
};

/** Objections to a step: what its checks found. */
export const findingsOf = (table: Pick<TableState, "notes">, step: string): number =>
  table.notes.filter((note) => note.target === step && note.kind === "object").length;

/**
 * Who built a step, by the step's own record: the agent that asked for its check; with none asked for, the agent
 * that marked it done. Undefined when no agent did either (it is open, or the human closed it): putting a step on
 * the table is planning, often for another agent.
 */
export const stepBuilder = (step: Pick<TableItem, "review" | "doneBy">, human?: string): string | undefined => {
  const agent = (who: string | undefined) => (who && who !== human ? who : undefined);
  return agent(step.review) ?? agent(step.doneBy);
};

/** A done step someone checked (see `checked`): not one its builder closed with no check asked for. */
export const stepChecked = (step: Pick<TableItem, "done" | "checked">): boolean => Boolean(step.done && step.checked);

/** Where a step stands, in words, once it is past being built: on its check (with what it found), checked, committed. */
const stepStage = (table: TableState, step: TableItem): string => {
  const found = findingsOf(table, step.id);
  const findings = found ? `, ${found} finding${found > 1 ? "s" : ""}` : "";
  const checked = stepChecked(step);
  if (step.commit) return `committed ${step.commit.sha.slice(0, 7)}${step.done && !checked ? " without a check" : ""}${findings}`;
  if (step.done) return checked ? `checked${findings}` : `done without a check${findings}`;
  if (step.review) return `waiting for its check${findings}`;
  return found ? `${found} finding${found > 1 ? "s" : ""}` : "";
};

/**
 * Who still disputes a settled point or a fact: everyone who objected to it and has not conceded on it
 * since. Empty once its author concedes on it after the objections — then it is given up, not contested.
 */
export const disputeOf = (table: Pick<TableState, "notes" | "shifts">, item: Pick<TableItem, "id" | "by" | "withdrawn">): string[] => {
  if (item.withdrawn) return [];
  const conceded = (who: string, after: number) => (table.shifts ?? []).some((shift) => shift.by === who && shift.target === item.id && shift.seq > after);
  const objections = table.notes.filter((note) => note.target === item.id && note.kind === "object");
  if (!objections.length || conceded(item.by, Math.max(...objections.map((note) => note.seq)))) return [];
  const last = new Map<string, number>();
  for (const note of objections) last.set(note.by, Math.max(last.get(note.by) ?? 0, note.seq));
  return [...last].filter(([who, seq]) => !conceded(who, seq)).map(([who]) => who);
};

/** Options still waiting for a decision: open, and not under a question that is already closed. */
const liveOptionsOf = (table: TableState) => {
  const closed = new Set(table.questions.filter((question) => question.status !== "open").map((question) => question.id));
  return table.options.filter((option) => option.status === "open" && !(option.q && closed.has(option.q)));
};

/** What the table still holds open: questions without an answer, undecided options, steps not done, disputed points. */
export const openOnTable = (table: TableState): { questions: number; options: number; steps: number; disputes: number } => ({
  questions: table.questions.filter((question) => question.status === "open").length,
  options: liveOptionsOf(table).length,
  steps: table.next.filter((step) => !step.done).length,
  disputes: [...table.settled, ...table.facts].filter((item) => disputeOf(table, item).length > 0).length,
});

/**
 * The table's current state for the end of a delta: what is still open, where
 * each live option stands, what is settled and what someone still has to do.
 * The state, not the moves — the moves are in the transcript above it.
 */
export const summarizeTable = (table: TableState): string | null => {
  const openQuestions = table.questions.filter((question) => question.status === "open");
  const liveOptions = liveOptionsOf(table);
  const pending = table.next.filter((step) => !step.done);
  const empty = [openQuestions, liveOptions, pending, table.decisions, table.facts, table.settled, table.shifts].every(
    (list) => list.length === 0,
  );
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
    const chosen = question.many ? table.options.filter((option) => option.q === question.id && option.status === "chosen").map((option) => option.id) : [];
    lines.push(
      `  ${question.id} open${question.many ? " (any number can be chosen)" : ""} ${quote(question.text, 100)}${options.length ? "" : " — no options yet"}${chosen.length ? ` — chosen so far: ${chosen.join(", ")}` : ""}`,
    );
    for (const option of options) lines.push(`    ${standing(option)}`);
  }
  for (const option of liveOptions.filter((entry) => !entry.q || !openQuestions.some((question) => question.id === entry.q))) {
    lines.push(`  ${standing(option)}`);
  }
  for (const decision of table.decisions.slice(-3)) {
    const option = table.options.find((entry) => entry.id === decision.option);
    lines.push(`  decided: ${decision.option}${option ? ` ${quote(option.title, 70)}` : ""}${decision.q ? ` for ${decision.q}` : ""}`);
  }
  // A point someone objected to is not common ground: it stays in view, with who disputes it, however old it is.
  const contested = (item: TableItem) => {
    const by = disputeOf(table, item);
    return by.length ? ` — contested by ${by.join(", ")}` : "";
  };
  const recentOrDisputed = (items: TableItem[], keep: number) =>
    items.filter((item, index) => index >= items.length - keep || disputeOf(table, item).length > 0);
  const facts = table.facts.filter((item) => !item.withdrawn);
  if (facts.length > 0) {
    lines.push(`  facts: ${recentOrDisputed(facts, 4).map((item) => `${item.id} ${quote(item.text, 70)}${contested(item)}`).join("; ")}`);
  }
  if (table.settled.length > 0) {
    const settled = recentOrDisputed(table.settled, 4).map(
      (item) =>
        `${item.id}${item.q ? ` (${table.questions.find((question) => question.id === item.q)?.many ? "recommends for" : "answers"} ${item.q})` : ""} ${quote(item.text, 70)}${contested(item)}`,
    );
    lines.push(`  settled: ${settled.join("; ")}`);
  }
  if (table.shifts.length > 0) {
    const shifts = table.shifts.slice(-3).map((item) => `${item.id} ${item.by}${item.target ? ` on ${item.target}` : ""} ${quote(item.text, 70)}`);
    lines.push(`  changed minds: ${shifts.join("; ")}`);
  }
  if (pending.length > 0) {
    lines.push(`  to do: ${pending.map((step) => {
      const stage = stepStage(table, step);
      return `${step.id}${step.target ? ` on ${step.target}` : ""} ${quote(step.text, 70)}${stage ? ` (${stage})` : ""}`;
    }).join("; ")}`);
  }
  return lines.join("\n");
};
