import type { WorkflowCheck, WorkflowEntry, WorkflowRound, WorkflowRun } from "../../../internal/agora/workflow-types.js";
import { parseViz, vizBlocks, type VizClaim } from "../../../internal/agora/visuals.js";

/**
 * Digests: what a structured run says, at a glance. Every protocol already
 * returns typed JSON for its decisive phases (arguments with ids, concessions,
 * rankings, criterion checks); a digest folds those into the few things a
 * reader follows — who holds what, what moved, what is still disputed, and
 * what would decide it — so the long submissions become the evidence behind
 * a picture rather than the only way in. Only revealed rounds are read, so a
 * digest never shows sealed work.
 */

type Obj = Record<string, unknown>;
const parse = (text: string | undefined): Obj | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
  } catch {
    return null;
  }
};
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);
const unit = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined);
const revealed = (round: WorkflowRound | undefined): round is WorkflowRound => round?.status === "revealed";
const latest = (run: WorkflowRun, ...phases: string[]): WorkflowRound | undefined => [...run.rounds].reverse().find((r) => phases.includes(r.phase));
const entryOf = (round: WorkflowRound | undefined, participantId: string): WorkflowEntry | undefined =>
  revealed(round) ? round.entries.find((e) => e.participantId === participantId) : undefined;
const label = (run: WorkflowRun, id: string) => run.participants.find((p) => p.id === id)?.label ?? id;

/**
 * One line a reader can take in: the author's own headline when given, else
 * the first sentence, without markdown, cut at a word.
 */
export const headline = (text: string, max = 140): string => {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).replace(/[\s,;:]+$/, "")}…`;
};

/** The claims an author put up front in a ```viz claims block, if any: their own summary of a free-text answer. */
export const leadClaims = (text: string | undefined): VizClaim[] | null => {
  if (!text) return null;
  for (const body of vizBlocks(text)) {
    const result = parseViz(body);
    if (result.ok && result.spec.kind === "claims") return result.spec.claims;
  }
  return null;
};

// ── debate ───────────────────────────────────────────────────────────────

export interface DebateArgument {
  id: string;
  headline: string;
  text: string;
  /** Opening or a new argument introduced after the steelman gate. */
  stage: "opening" | "new";
  /** The opponent's concession tied to this argument. */
  conceded?: { by: string; reason: string };
}

export interface DebateSide {
  participantId: string;
  label: string;
  role: "pro" | "con";
  position: string;
  /** The position as restated with the new arguments, when it moved. */
  positionNow?: string;
  arguments: DebateArgument[];
  /** The author's stated confidence in the assigned case, phase by phase. */
  confidence: { phase: "openings" | "new_arguments" | "rebuttal"; value: number }[];
  /** Whether this side accepted the opponent's restatement of it, per attempt. */
  acceptance: boolean[];
  /** What this side asked to correct when it last rejected its restatement. */
  corrections?: string;
  concessionsMade: number;
  /** The rebuttal, as one line. */
  rebuttal?: string;
  remainingDisagreement?: string;
  decisiveTest?: string;
}

export interface DebateJudge {
  label: string;
  leaning?: { side: "pro" | "con" | "undecided"; confidence?: number };
  counts: Record<WorkflowCheck["status"], number>;
  summary: string;
}

export interface DebateDigest {
  sides: DebateSide[];
  /** Whether both authors accepted their restatement — the gate to rebuttals. */
  gate: "open" | "passed" | "failed";
  judges: DebateJudge[];
  /** Checks as the run reported them (judges merged conservatively). */
  checks: WorkflowCheck[];
}

const args = (value: unknown, stage: DebateArgument["stage"]): DebateArgument[] =>
  Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const a = item && typeof item === "object" ? (item as Obj) : null;
        const id = str(a?.id);
        const text = str(a?.text);
        if (!a || !id || !text) return [];
        return [{ id, headline: str(a.headline) ? headline(str(a.headline), 160) : headline(text), text, stage }];
      })
    : [];

const countChecks = (checks: WorkflowCheck[]) => {
  const counts = { passed: 0, failed: 0, unknown: 0 };
  for (const c of checks) counts[c.status] += 1;
  return counts;
};
const checksOf = (value: unknown): WorkflowCheck[] =>
  Array.isArray(value)
    ? value.filter((c): c is WorkflowCheck => !!c && typeof c === "object" && typeof c.criterion === "string" && ["passed", "failed", "unknown"].includes(c.status) && typeof c.evidence === "string")
    : [];

export const debateDigest = (run: WorkflowRun): DebateDigest | null => {
  if (run.mode !== "debate") return null;
  const openings = latest(run, "openings");
  if (!revealed(openings)) return null;
  const fresh = latest(run, "new_arguments");
  const rebuttals = latest(run, "rebuttal");
  const advocates = run.participants.filter((p): p is typeof p & { role: "pro" | "con" } => p.role === "pro" || p.role === "con").sort((a, b) => (a.role === b.role ? 0 : a.role === "pro" ? -1 : 1));
  const acceptanceRounds = run.rounds.filter((r) => r.phase === "acceptance" && revealed(r));
  const sides: DebateSide[] = advocates.map((p) => {
    const opening = parse(entryOf(openings, p.id)?.text);
    const later = parse(entryOf(fresh, p.id)?.text);
    const rebuttal = parse(entryOf(rebuttals, p.id)?.text);
    const confidence: DebateSide["confidence"] = [];
    const push = (phase: DebateSide["confidence"][number]["phase"], data: Obj | null) => {
      const value = unit(data?.confidence);
      if (value !== undefined) confidence.push({ phase, value });
    };
    push("openings", opening);
    push("new_arguments", later);
    push("rebuttal", rebuttal);
    const position = str(opening?.position);
    const lastAcceptance = parse(entryOf(acceptanceRounds.at(-1), p.id)?.text);
    const corrections = lastAcceptance?.accepted === false ? str(lastAcceptance.corrections) : "";
    const positionNow = str(later?.position);
    return {
      participantId: p.id,
      label: p.label,
      role: p.role,
      position,
      ...(positionNow && positionNow !== position ? { positionNow } : {}),
      arguments: [...args(opening?.arguments, "opening"), ...args(later?.arguments, "new")],
      confidence,
      acceptance: acceptanceRounds.map((r) => parse(entryOf(r, p.id)?.text)?.accepted).filter((a): a is boolean => typeof a === "boolean"),
      ...(corrections ? { corrections } : {}),
      concessionsMade: Array.isArray(rebuttal?.concessions) ? rebuttal.concessions.length : 0,
      ...(str(rebuttal?.rebuttal) ? { rebuttal: headline(str(rebuttal?.rebuttal), 220) } : {}),
      ...(str(rebuttal?.remainingDisagreement) ? { remainingDisagreement: str(rebuttal?.remainingDisagreement) } : {}),
      ...(str(rebuttal?.decisiveTest) ? { decisiveTest: str(rebuttal?.decisiveTest) } : {}),
    };
  });
  // A concession names an opponent's argument id; mark that argument on the opponent's side.
  for (const side of sides) {
    const rebuttal = parse(entryOf(rebuttals, side.participantId)?.text);
    if (!Array.isArray(rebuttal?.concessions)) continue;
    for (const item of rebuttal.concessions as unknown[]) {
      const c = item && typeof item === "object" ? (item as Obj) : null;
      const target = sides.flatMap((s) => (s === side ? [] : s.arguments)).find((a) => a.id === str(c?.argumentId));
      if (target) target.conceded = { by: side.label, reason: str(c?.reason) };
    }
  }
  const last = acceptanceRounds.at(-1);
  const verdict = latest(run, "verdict");
  // Rebuttals follow only an accepted gate, and the verdict follows the rebuttals; a verdict round with no new
  // arguments before it, or a rejection after the last permitted repair, means the gate failed — even before the
  // run marks it at the end of the verdict.
  const exhausted = acceptanceRounds.length > run.budget.maxRounds && sides.some((s) => s.acceptance.at(-1) === false);
  const gate: DebateDigest["gate"] =
    run.phase === "disagreement" || (verdict && !fresh) || exhausted ? "failed" : revealed(fresh) || revealed(rebuttals) ? "passed" : last && sides.every((s) => s.acceptance.at(-1) === true) ? "passed" : "open";
  const judges: DebateJudge[] = revealed(verdict)
    ? verdict.entries.flatMap((entry) => {
        const data = parse(entry.text);
        if (!data) return [];
        const lean = data.leaning && typeof data.leaning === "object" ? (data.leaning as Obj) : null;
        // With the gate failed there is no argumentative winner to lean towards: a leaning the judge gave anyway is left out.
        const side = gate === "failed" ? "" : str(lean?.side);
        const leanConfidence = unit(lean?.confidence);
        return [
          {
            label: label(run, entry.participantId),
            ...(side === "pro" || side === "con" || side === "undecided" ? { leaning: { side, ...(leanConfidence !== undefined ? { confidence: leanConfidence } : {}) } } : {}),
            counts: countChecks(checksOf(data.checks)),
            summary: headline(str(data.summary), 220),
          } as DebateJudge,
        ];
      })
    : [];
  return { sides, gate, judges, checks: run.report?.checks ?? [] };
};

// ── council & tournament: rankings ───────────────────────────────────────

export interface Standing {
  /** The answer's anonymous alias: the board presents council answers and prototypes by alias, never by author. */
  alias: string;
  /** Borda points: each ranking gives n-1 to its first answer, 0 to its last. */
  points: number;
  /** Highest points possible from the rankings that included this answer. */
  possible: number;
  /** How many reviewers put it first. */
  firsts: number;
  headline: string;
  claims: VizClaim[] | null;
}

const standings = (authored: WorkflowRound | undefined, reviews: WorkflowRound | undefined): Standing[] => {
  if (!revealed(authored) || !authored.aliases) return [];
  const rows = new Map<string, Standing>();
  for (const entry of authored.entries) {
    const alias = authored.aliases[entry.id];
    if (!alias) continue;
    rows.set(alias, { alias, points: 0, possible: 0, firsts: 0, headline: headline(entry.text ?? ""), claims: leadClaims(entry.text) });
  }
  if (revealed(reviews)) {
    for (const entry of reviews.entries) {
      const ranking = strings(parse(entry.text)?.ranking).filter((alias) => rows.has(alias));
      ranking.forEach((alias, i) => {
        const row = rows.get(alias)!;
        row.points += ranking.length - 1 - i;
        row.possible += ranking.length - 1;
        if (i === 0) row.firsts += 1;
      });
    }
  }
  return [...rows.values()].sort((a, b) => b.points - a.points || a.alias.localeCompare(b.alias));
};

export const councilStandings = (run: WorkflowRun): Standing[] => (run.mode === "council" ? standings(latest(run, "answers"), latest(run, "peer_review")) : []);
export const tournamentStandings = (run: WorkflowRun): Standing[] => (run.mode === "tournament" ? standings(latest(run, "prototypes"), latest(run, "evaluation")) : []);

// ── verification: criteria across review rounds ──────────────────────────

export interface CriteriaGrid {
  criteria: string[];
  /** One column per review submission, in order: attempt and reviewer. */
  columns: { round: string; label: string; attempt: number; statuses: (WorkflowCheck["status"] | null)[] }[];
}

export const criteriaGrid = (run: WorkflowRun): CriteriaGrid | null => {
  if (run.mode !== "verification" && run.mode !== "debate") return null;
  const phases = run.mode === "verification" ? ["review", "recheck"] : ["verdict"];
  const rounds = run.rounds.filter((r) => phases.includes(r.phase) && revealed(r));
  if (!rounds.length) return null;
  const columns = rounds.flatMap((round, attempt) =>
    round.entries.map((entry) => {
      const checks = checksOf(parse(entry.text)?.checks);
      return { round: round.id, label: label(run, entry.participantId), attempt: attempt + 1, statuses: run.criteria.map((c) => checks.find((k) => k.criterion === c)?.status ?? null) };
    }),
  );
  return { criteria: run.criteria, columns };
};
