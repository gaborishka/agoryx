import {
  CheckCheckIcon,
  FolderKanbanIcon,
  MessagesSquareIcon,
  ScaleIcon,
  ShieldCheckIcon,
  SwordsIcon,
  TrophyIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";

export type WorkMode =
  "chat" | "work" | "verification" | "council" | "tournament" | "debate";
export type ProtocolMode = Exclude<WorkMode, "chat" | "work">;

export const WORK_MODES: Record<
  WorkMode,
  {
    title: string;
    icon: LucideIcon;
    eyebrow: string;
    description: string;
    steps: string[];
    outcome: string;
    min: number;
  }
> = {
  chat: {
    title: "Chat",
    icon: MessagesSquareIcon,
    eyebrow: "Think together",
    description: "One shared conversation, with a table for decisions.",
    steps: [],
    outcome: "",
    min: 1,
  },
  work: {
    title: "Work",
    icon: FolderKanbanIcon,
    eyebrow: "Build together",
    description:
      "Agents work in a shared project, with files, changes and checkpoints.",
    steps: [],
    outcome: "",
    min: 1,
  },
  verification: {
    title: "Verification",
    icon: ShieldCheckIcon,
    eyebrow: "Make it. Question it. Make it better.",
    description:
      "An author creates the artifact. Independent reviewers test it against your original brief, then return it for repair and a second look.",
    steps: ["Create", "Review", "Revise", "Recheck", "Report"],
    outcome:
      "An artifact with an evidence trail: what was checked, how, and what remains unknown.",
    min: 2,
  },
  council: {
    title: "Council",
    icon: UsersRoundIcon,
    eyebrow: "Independent minds. A considered answer.",
    description:
      "Everyone answers privately, then reviews anonymous answers. A synthesis brings the strongest ideas together; a final check protects the disagreements.",
    steps: ["Answer privately", "Peer review", "Synthesize", "Check dissent"],
    outcome: "A shared answer that keeps meaningful disagreements visible.",
    min: 2,
  },
  tournament: {
    title: "Tournament",
    icon: TrophyIcon,
    eyebrow: "Explore more. Commit with confidence.",
    description:
      "Two makers build short prototypes with the same brief and budget. Independent judges compare them. You choose what deserves a full implementation.",
    steps: ["Prototype privately", "Compare", "Your choice", "Implement"],
    outcome:
      "Competing prototypes, a fair comparison, and a human decision before implementation.",
    min: 3,
  },
  debate: {
    title: "Debate",
    icon: SwordsIcon,
    eyebrow: "Find the disagreement that matters.",
    description:
      "Two advocates take opposing positions. Each must earn agreement on their restatement before rebutting. An independent judge maps what holds and what needs a test.",
    steps: [
      "Positions",
      "Restate",
      "Accept",
      "New arguments",
      "Rebut",
      "Verdict",
    ],
    outcome:
      "A reasoned verdict, unresolved differences, and a test that could settle them.",
    min: 3,
  },
};

export const PHASE_NAMES: Record<string, string> = {
  create: "Create",
  draft: "Create",
  review: "Review",
  revise: "Revise",
  revision: "Revise",
  recheck: "Recheck",
  report: "Verification report",
  answer: "Independent answers",
  answers: "Independent answers",
  peer_review: "Anonymous peer review",
  rank: "Anonymous peer review",
  synthesis: "Synthesis",
  dissent: "Dissent check",
  prototype: "Private prototypes",
  prototypes: "Private prototypes",
  compare: "Independent comparison",
  selection: "Your choice",
  implement: "Implementation",
  position: "Opening positions",
  positions: "Opening positions",
  steelman: "Restatements",
  acceptance: "Opponent acceptance",
  rebuttal: "Rebuttals",
  verdict: "Judge’s verdict",
};
export const phaseName = (phase: string) =>
  PHASE_NAMES[phase] ??
  phase.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());
export const OUTCOME_ICONS = {
  verification: CheckCheckIcon,
  council: UsersRoundIcon,
  tournament: TrophyIcon,
  debate: ScaleIcon,
};
export const isWorkMode = (value: unknown): value is WorkMode =>
  typeof value === "string" && Object.hasOwn(WORK_MODES, value);

export const isProtocolMode = (value: unknown): value is ProtocolMode =>
  isWorkMode(value) && value !== "chat" && value !== "work";

/** Rooms predating the explicit mode field are project-based Work rooms. */
export const nativeRoomMode = (
  room: { mode?: string } | null | undefined,
): "chat" | "work" => (room && room.mode !== "chat" ? "work" : "chat");

/** The visible mode reflects the newest activity, including a saved protocol result. */
export const conversationMode = (room: { mode?: string; activityMode?: WorkMode; workflow?: { mode: ProtocolMode } }): WorkMode =>
  room.activityMode ?? room.workflow?.mode ?? nativeRoomMode(room);
