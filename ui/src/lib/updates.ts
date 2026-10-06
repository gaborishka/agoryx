import { useEffect } from "react";
import { create } from "zustand";
import { api, local, Unauthorized } from "./api";
import type { UpdateStatus } from "../../../internal/agora/updates.js";

export type { UpdateStatus };

/**
 * Whether a newer Agoryx is out, as the daemon knows it (GET /api/update, internal/agora/updates.ts). The daemon
 * asks GitHub at most every few hours; the page asks the daemon when it opens and every hour after. "Not now" on
 * the banner hides that version only: the next release shows again.
 */

const POLL_MS = 60 * 60 * 1000;
const DISMISSED = "update.dismissed";

interface UpdateStore {
  status: UpdateStatus | null;
  checking: boolean;
  /** The version whose banner the human closed. */
  dismissed: string | null;
  /** Ask the daemon (and, with `now`, GitHub) again. */
  refresh: (now?: boolean) => Promise<UpdateStatus | null>;
  dismiss: (version: string) => void;
}

export const useUpdates = create<UpdateStore>((set, get) => ({
  status: null,
  checking: false,
  dismissed: local.get(DISMISSED),
  async refresh(now = false) {
    if (get().checking) return get().status;
    set({ checking: true });
    try {
      const status = await api<UpdateStatus>(now ? "POST" : "GET", "/api/update");
      set({ status });
      return status;
    } catch (error) {
      if (!(error instanceof Unauthorized) && now) throw error;
      return get().status;
    } finally {
      set({ checking: false });
    }
  },
  dismiss(version) {
    local.set(DISMISSED, version);
    set({ dismissed: version });
  },
}));

/** The release the banner offers: newer than this install and not dismissed. */
export const offeredUpdate = (s: Pick<UpdateStore, "status" | "dismissed">) =>
  s.status?.available && s.status.latest && s.status.latest.version !== s.dismissed ? s.status.latest : null;

/** Keep the status fresh while the app's shell is open. */
export const useUpdatePolling = () => {
  useEffect(() => {
    void useUpdates.getState().refresh();
    const timer = setInterval(() => void useUpdates.getState().refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, []);
};
