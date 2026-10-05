import { create } from "zustand";
import type { WorkflowIndexEntry } from "@agora/workflow-index";
import { api } from "./api";
let pending: Promise<void> | null = null;
export const useWorkflowIndex = create<{
  entries: WorkflowIndexEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}>((set) => ({
  entries: [],
  loading: true,
  error: null,
  refresh() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const data = await api<{
          workflows: WorkflowIndexEntry[];
          unavailable: string[];
        }>("GET", "/api/workflows");
        set({
          entries: data.workflows,
          loading: false,
          error: data.unavailable.length
            ? "Some session records need recovery."
            : null,
        });
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  },
}));
