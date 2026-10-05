import { useSyncExternalStore } from "react";
import type { WorkflowRole } from "../../../internal/agora/workflow-types.js";
import { ApiError, local, Unauthorized } from "./api.js";
import type { RoomAgent } from "./types.js";
import type { ProtocolMode, WorkMode } from "./workflow.js";

export interface WorkflowDraft {
  task: string;
  criteria: string;
  selected?: string[];
  roles: Record<string, WorkflowRole>;
  seconds: number;
  chars: number;
  rounds: number;
  contextPaths: string[];
  messageIds?: string[];
  resultIds?: string[];
  origin?: { key: string; revision: number; roomId: string };
}

export interface CreationDraft {
  revision: number;
  brief: string;
  seats: RoomAgent[] | null;
  project: boolean;
  /** Logical membership; independent of the folder used to execute Work. */
  projectKey?: string | null;
  folder: string | null;
  worktree: boolean;
  base: string | null;
  budget: number | null;
  protocols: Partial<Record<ProtocolMode, WorkflowDraft>>;
  prepared?: { roomId: string; mode: WorkMode; revision: number };
  preparing?: { mode: WorkMode; at: number };
}

export interface CreationProjectProof {
  folder: string;
  git: { head: string | null; branches: string[] } | null;
}

/** The selected worktree is a requirement, never a best-effort request. */
export function creationProjectInput(
  draft: Pick<CreationDraft, "project" | "projectKey" | "folder" | "worktree" | "base">,
  proof?: CreationProjectProof | null,
  mode?: WorkMode,
): { mode: "chat" | "work"; projectKey?: string | null; dir?: string; worktree?: true; base?: string } {
  const membership = draft.projectKey !== undefined ? { projectKey: draft.projectKey } : {};
  if (mode === "chat" || (mode !== "work" && !draft.project)) return { mode: "chat", ...membership };
  const input = {
    mode: "work" as const,
    ...membership,
    ...(draft.folder ? { dir: draft.folder } : {}),
  };
  if (!draft.worktree) return input;
  if (!draft.folder)
    throw new Error(
      "A worktree needs an existing Git project. Choose a project folder or explicitly create a new project folder without a worktree.",
    );
  if (proof?.folder !== draft.folder)
    throw new Error(
      "The requested worktree is not confirmed yet. Wait for the project check or retry it.",
    );
  if (!proof.git?.head)
    throw new Error(
      "This folder has no confirmed Git commit for the requested worktree. Choose another project or explicitly use the project folder directly.",
    );
  if (draft.base && !proof.git.branches.includes(draft.base))
    throw new Error(
      `The selected worktree base “${draft.base}” is unavailable. Choose a listed branch or use the current commit.`,
    );
  return {
    ...input,
    worktree: true,
    ...(draft.base ? { base: draft.base } : {}),
  };
}

type Storage = {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
};
const parse = (value: string | null): Record<string, unknown> | null => {
  try {
    const object: unknown = JSON.parse(value ?? "null");
    return object && typeof object === "object" && !Array.isArray(object)
      ? (object as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};
const seatsFrom = (value: unknown): RoomAgent[] | null => {
  if (!Array.isArray(value)) return null;
  const seats = value.filter((a): a is RoomAgent =>
    Boolean(
      a &&
      typeof a.id === "string" &&
      typeof a.label === "string" &&
      (a.kind === "claude" || a.kind === "codex"),
    ),
  );
  return seats.slice(0, 8);
};
export const firstPair = (roster: RoomAgent[]): RoomAgent[] => {
  const pair = [
    roster.find((a) => a.kind === "claude"),
    roster.find((a) => a.kind === "codex"),
  ].filter((a): a is RoomAgent => Boolean(a));
  return pair.length === 2 ? pair : roster.slice(0, 2);
};
export const emptyWorkflowDraft = (): WorkflowDraft => ({
  task: "",
  criteria: "",
  roles: {},
  seconds: 180,
  chars: 16000,
  rounds: 2,
  contextPaths: [],
});
export const creationDraftKey = (dir?: string) =>
  `creation.draft.${encodeURIComponent(dir ?? "standalone")}`;

/** Drafts survive method changes; a known created room is reused until explicitly released. */
export class CreationDrafts {
  private drafts = new Map<string, CreationDraft>();
  private workflows = new Map<string, WorkflowDraft>();
  private listeners = new Set<() => void>();
  private pending = new Map<
    string,
    Promise<{ roomId: string; mode: WorkMode; revision: number }>
  >();
  constructor(private storage: Storage) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    this.listeners.forEach((listener) => listener());
  }
  read(key: string, dir?: string): CreationDraft {
    const known = this.drafts.get(key);
    if (known) return known;
    const saved = parse(this.storage.get(key));
    let rememberedSeats: unknown = null;
    try {
      rememberedSeats = JSON.parse(this.storage.get("start.seats") ?? "null");
    } catch {
      /* broken preference uses roster defaults */
    }
    const legacyBudget = Number(this.storage.get("budget"));
    const draft: CreationDraft = {
      revision: typeof saved?.revision === "number" ? saved.revision : 0,
      brief:
        typeof saved?.brief === "string"
          ? saved.brief
          : (this.storage.get("draft.new") ??
            ["verification", "council", "tournament", "debate"]
              .map((mode) => this.storage.get(`workflow.draft.new.${mode}`))
              .find(Boolean) ??
            ""),
      seats: seatsFrom(saved?.seats) ?? seatsFrom(rememberedSeats),
      projectKey: typeof saved?.projectKey === "string" ? saved.projectKey : saved?.projectKey === null ? null : (dir ?? (saved?.project === true && typeof saved.folder === "string" ? saved.folder : null)),
      project:
        typeof saved?.project === "boolean" ? saved.project : Boolean(dir),
      folder:
        typeof saved?.folder === "string"
          ? saved.folder
          : (dir ?? this.storage.get("folder")),
      worktree:
        typeof saved?.worktree === "boolean"
          ? saved.worktree
          : this.storage.get("worktree") === "1",
      base: typeof saved?.base === "string" ? saved.base : null,
      budget:
        typeof saved?.budget === "number"
          ? saved.budget
          : saved?.budget === null
            ? null
            : legacyBudget >= 1 && legacyBudget <= 100
              ? legacyBudget
              : null,
      protocols:
        saved?.protocols && typeof saved.protocols === "object"
          ? (saved.protocols as CreationDraft["protocols"])
          : {},
      ...(saved?.prepared &&
      typeof (saved.prepared as { roomId?: unknown }).roomId === "string"
        ? { prepared: saved.prepared as CreationDraft["prepared"] }
        : {}),
      ...(saved?.preparing &&
      typeof (saved.preparing as { at?: unknown }).at === "number"
        ? { preparing: saved.preparing as CreationDraft["preparing"] }
        : {}),
    };
    this.drafts.set(key, draft);
    return draft;
  }
  private write(key: string, draft: CreationDraft) {
    this.drafts.set(key, draft);
    this.storage.set(key, JSON.stringify(draft));
    this.emit();
    return draft;
  }
  update(key: string, patch: Partial<CreationDraft>) {
    const current = this.read(key);
    return this.write(key, {
      ...current,
      ...patch,
      revision: current.revision + 1,
    });
  }
  setSeats(key: string, seats: RoomAgent[]) {
    this.storage.set("start.seats", JSON.stringify(seats));
    this.update(key, { seats });
  }
  seedSeats(key: string, roster: RoomAgent[]) {
    const current = this.read(key);
    if (current.seats === null)
      this.write(key, { ...current, seats: firstPair(roster) });
  }
  workflow(key: string, mode: ProtocolMode, roomId?: string): WorkflowDraft {
    if (!roomId) {
      const draft = this.read(key);
      const saved = draft.protocols[mode];
      if (saved) return saved;
      const next = {
        ...emptyWorkflowDraft(),
        criteria: this.storage.get(`workflow.draft.new.${mode}.criteria`) ?? "",
      };
      this.drafts.set(key, {
        ...draft,
        protocols: { ...draft.protocols, [mode]: next },
      });
      return next;
    }
    const id = `workflow.setup.${roomId}.${mode}`;
    const known = this.workflows.get(id);
    if (known) return known;
    const saved = parse(this.storage.get(id));
    const next = {
      ...emptyWorkflowDraft(),
      task: this.storage.get(`workflow.draft.${roomId}.${mode}`) ?? "",
      criteria:
        this.storage.get(`workflow.draft.${roomId}.${mode}.criteria`) ?? "",
      ...saved,
    } as WorkflowDraft;
    this.workflows.set(id, next);
    return next;
  }
  updateWorkflow(
    key: string,
    mode: ProtocolMode,
    patch: Partial<WorkflowDraft>,
    roomId?: string,
  ) {
    const next = { ...this.workflow(key, mode, roomId), ...patch };
    if (!roomId) {
      const current = this.read(key);
      this.update(key, { protocols: { ...current.protocols, [mode]: next } });
    } else {
      const id = `workflow.setup.${roomId}.${mode}`;
      this.workflows.set(id, next);
      this.storage.set(id, JSON.stringify(next));
      this.emit();
    }
    return next;
  }
  adopt(
    key: string,
    mode: ProtocolMode,
    roomId: string,
    source: CreationDraft,
  ) {
    return this.updateWorkflow(
      key,
      mode,
      {
        ...emptyWorkflowDraft(),
        ...source.protocols[mode],
        task: source.brief,
        selected: source.seats?.map((seat) => seat.id),
        origin: { key, revision: source.revision, roomId },
      },
      roomId,
    );
  }
  prepare(key: string, mode: WorkMode, create: () => Promise<string>) {
    const current = this.read(key);
    if (current.prepared) return Promise.resolve(current.prepared);
    const active = this.pending.get(key);
    if (active) return active;
    if (current.preparing)
      return Promise.reject(
        new Error(
          "A previous creation has no confirmed result. Check the chat list before starting another chat.",
        ),
      );
    this.write(key, { ...current, preparing: { mode, at: Date.now() } });
    const pending = Promise.resolve()
      .then(create)
      .then((roomId) => {
        const prepared = { roomId, mode, revision: current.revision };
        this.write(key, { ...this.read(key), prepared, preparing: undefined });
        return prepared;
      })
      .catch((error: unknown) => {
        // A known HTTP rejection did not create a room. An interrupted response may have:
        // retain its recovery marker across reload, rather than blindly POSTing again.
        if (
          (error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500) ||
          error instanceof Unauthorized
        )
          this.write(key, { ...this.read(key), preparing: undefined });
        throw error;
      })
      .finally(() => {
        this.pending.delete(key);
        this.write(key, { ...this.read(key) });
      });
    this.pending.set(key, pending);
    return pending;
  }
  prepareWorkflow(
    key: string,
    mode: ProtocolMode,
    source: CreationDraft,
    create: () => Promise<string>,
  ) {
    return this.prepare(key, mode, async () => {
      const roomId = await create();
      // Publish recovery only after its complete setup is durable. A reload that
      // sees prepared.roomId must never find an empty session form.
      this.adopt(key, mode, roomId, source);
      return roomId;
    });
  }
  isPreparing(key: string) {
    return this.pending.has(key);
  }
  release(key: string) {
    this.write(key, {
      ...this.read(key),
      prepared: undefined,
      preparing: undefined,
    });
  }
  finish(key: string, revision: number, roomId: string) {
    const current = this.read(key);
    if (current.prepared?.roomId !== roomId) return;
    const clear = current.revision === revision;
    this.write(key, {
      ...current,
      ...(clear ? { brief: "", protocols: {} } : {}),
      prepared: undefined,
      preparing: undefined,
    });
    if (clear) this.storage.set("draft.new", null);
  }
}

export const creationDrafts = new CreationDrafts(local);
export function useCreationDraft(key: string, dir?: string) {
  return useSyncExternalStore(creationDrafts.subscribe, () =>
    creationDrafts.read(key, dir),
  );
}
export function useWorkflowDraft(
  key: string,
  mode: ProtocolMode,
  roomId?: string,
) {
  return useSyncExternalStore(creationDrafts.subscribe, () =>
    creationDrafts.workflow(key, mode, roomId),
  );
}
