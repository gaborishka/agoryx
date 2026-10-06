import { useEffect } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { api, local, Unauthorized } from "./api";
import { browserBridge } from "./desktop";
import { errText } from "./load";
import type { ReleaseInfo, UpdateStatus } from "../../../internal/agora/updates.js";

export type { ReleaseInfo, UpdateStatus };

/**
 * Whether a newer Agoryx is out, as the daemon knows it (GET /api/update, internal/agora/updates.ts). The daemon
 * asks GitHub at most every few hours; the page asks the daemon when it opens and every hour after. "Not now" on
 * the banner hides that version only: the next release shows again. The app's "Check for Updates…" menu item
 * sends `agoryx:check-updates` (desktop/src/main.ts).
 */

const POLL_MS = 60 * 60 * 1000;
const DISMISSED = "update.dismissed";

interface UpdateStore {
  status: UpdateStatus | null;
  /** The human's "Check for updates" is under way (not the hourly poll). */
  checking: boolean;
  /** The version whose banner the human closed. */
  dismissed: string | null;
  /** Ask the daemon (and, with `now`, GitHub) again. A failed `now` rejects; a failed poll keeps the last status. */
  refresh: (now?: boolean) => Promise<UpdateStatus | null>;
  dismiss: (version: string) => void;
}

let polling: Promise<UpdateStatus | null> | null = null;

export const useUpdates = create<UpdateStore>((set, get) => ({
  status: null,
  checking: false,
  dismissed: local.get(DISMISSED),
  async refresh(now = false) {
    if (!now) {
      polling ??= api<UpdateStatus>("GET", "/api/update")
        .then((status) => {
          set({ status });
          return status;
        })
        .catch(() => get().status)
        .finally(() => {
          polling = null;
        });
      return polling;
    }
    if (get().checking) return get().status;
    set({ checking: true });
    try {
      const status = await api<UpdateStatus>("POST", "/api/update");
      set({ status });
      return status;
    } catch (error) {
      if (error instanceof Unauthorized) return get().status;
      throw error;
    } finally {
      set({ checking: false });
    }
  },
  dismiss(version) {
    local.set(DISMISSED, version);
    set({ dismissed: version });
  },
}));

/** "Check for updates": ask GitHub now and say what came of it. */
export const checkForUpdates = () =>
  useUpdates
    .getState()
    .refresh(true)
    .then((status) => {
      if (!status || status.disabled) return;
      if (status.error) toast.error(`Could not check for updates: ${status.error}`);
      else if (status.available && status.latest) toast.success(`Agoryx ${status.latest.version} is available`);
      else toast.success("Agoryx is up to date");
    })
    .catch((error) => toast.error(`Could not check for updates: ${errText(error)}`));

/** The release the banner offers: newer than this install and not dismissed. */
export const offeredUpdate = (s: Pick<UpdateStore, "status" | "dismissed">) =>
  s.status?.available && s.status.latest && s.status.latest.version !== s.dismissed ? s.status.latest : null;

/** Where "Download" goes: the DMG in the macOS app; elsewhere (a phone, a browser on a source install) the release page. */
export const downloadLink = (release: ReleaseInfo): { href: string; label: string } =>
  release.download && browserBridge() ? { href: release.download, label: "Download update" } : { href: release.url, label: "Get the update" };

/** Keep the status fresh while the app's shell is open, and answer the app's "Check for Updates…". */
export const useUpdatePolling = () => {
  useEffect(() => {
    void useUpdates.getState().refresh();
    const timer = setInterval(() => void useUpdates.getState().refresh(), POLL_MS);
    const onAsk = () => void checkForUpdates();
    window.addEventListener("agoryx:check-updates", onAsk);
    return () => {
      clearInterval(timer);
      window.removeEventListener("agoryx:check-updates", onAsk);
    };
  }, []);
};
