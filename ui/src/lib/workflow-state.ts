import { useEffect } from "react";
import { create } from "zustand";
import type { WorkflowAction, WorkflowRun } from "@agora/workflow-types";
import { api, roomPath } from "./api";
import { useStore } from "./store";

export interface WorkflowResponse {
  workflow: WorkflowRun | null;
  capabilities?: {
    isolation: {
      available: boolean;
      reason?: string;
      backend?: string;
      providers?: Record<
        "codex" | "claude",
        { available: boolean; reason?: string }
      >;
    };
  };
}
interface WorkflowState {
  roomId: string | null;
  generation: number;
  enterRoom: (roomId: string | null) => number;
  run: WorkflowRun | null;
  capabilities: WorkflowResponse["capabilities"];
  loading: boolean;
  error: string | null;
  busy: boolean;
  receive: (
    roomId: string,
    response: WorkflowResponse,
    generation?: number,
  ) => void;
  refresh: (roomId: string) => Promise<void>;
  act: (action: WorkflowAction) => Promise<void>;
  stop: () => Promise<void>;
}
let revision = 0;
const roomSummaryKeys = new Map<string, string>();
export const useWorkflow = create<WorkflowState>((set, get) => ({
  roomId: null,
  generation: 0,
  run: null,
  capabilities: undefined,
  loading: true,
  error: null,
  busy: false,
  enterRoom(roomId) {
    revision++;
    const generation = get().generation + 1;
    set({
      roomId,
      generation,
      run: null,
      capabilities: undefined,
      error: null,
      loading: Boolean(roomId),
      busy: false,
    });
    return generation;
  },
  receive(roomId, response, generation = get().generation) {
    if (get().roomId !== roomId || get().generation !== generation) return;
    const current = get().run;
    if (
      current?.id === response.workflow?.id &&
      current &&
      response.workflow &&
      current.updatedAt > response.workflow.updatedAt
    )
      return;
    revision++;
    const run = response.workflow;
    const key = run ? `${run.id}:${run.status}:${run.phase}` : "none";
    const previous = roomSummaryKeys.get(roomId);
    roomSummaryKeys.set(roomId, key);
    set({
      roomId,
      run: response.workflow,
      loading: false,
      error: null,
      ...(response.capabilities ? { capabilities: response.capabilities } : {}),
    });
    // Phase/status transitions affect room recency and the sidebar's Working section.
    // Submission progress alone does not need another request for every poll.
    if (previous !== key && (previous !== undefined || run))
      void useStore.getState().loadRooms();
  },
  async refresh(roomId) {
    if (get().roomId !== roomId || get().busy) return;
    const current = revision;
    const generation = get().generation;
    try {
      const response = await api<WorkflowResponse>(
        "GET",
        roomPath(roomId, "/workflow"),
      );
      if (get().roomId !== roomId || current !== revision) return;
      get().receive(roomId, response, generation);
    } catch (error) {
      if (get().roomId === roomId && current === revision)
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  },
  async act(action) {
    const { roomId, generation } = get();
    if (!roomId || get().busy) return;
    const inScope = () =>
      get().roomId === roomId && get().generation === generation;
    set({ busy: true, error: null });
    revision++;
    try {
      const response = await api<WorkflowResponse>(
        "POST",
        roomPath(roomId, "/workflow/action"),
        action,
      );
      if (inScope()) get().receive(roomId, response, generation);
    } catch (error) {
      if (inScope())
        set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (inScope()) set({ busy: false });
    }
  },
  async stop() {
    const { roomId, run, busy, generation } = get();
    if (!roomId || !run || busy) return;
    const inScope = () =>
      get().roomId === roomId && get().generation === generation;
    revision++;
    set({ busy: true, error: null });
    try {
      const response = await api<WorkflowResponse>(
        "POST",
        roomPath(roomId, "/workflow/stop"),
        { runId: run.id },
      );
      if (inScope()) get().receive(roomId, response, generation);
    } catch (error) {
      if (inScope())
        set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (inScope()) set({ busy: false });
    }
  },
}));

/** Also runs while viewing chat, so the room never suggests sending into an isolated phase. */
export function useWorkflowRoom(roomId: string | undefined) {
  useEffect(() => {
    const generation = useWorkflow.getState().enterRoom(roomId ?? null);
    if (!roomId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await useWorkflow.getState().refresh(roomId);
      if (alive)
        timer = setTimeout(
          poll,
          document.visibilityState === "visible" ? 1800 : 7000,
        );
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      if (useWorkflow.getState().generation === generation)
        useWorkflow.getState().enterRoom(null);
    };
  }, [roomId]);
}

export const activeWorkflow = (run: WorkflowRun | null) =>
  run?.status === "running" || run?.status === "waiting_user";
