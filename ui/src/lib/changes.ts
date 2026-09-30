import { useEffect, useState } from "react";
import { api, ApiError, roomPath, Unauthorized } from "./api";
import { errText } from "./load";
import type { FileChange, RoomState } from "./types";

export type Diff = { changes: FileChange[]; patch: string; truncated: boolean };
export type RoomBase = { kind: "worktree"; ref: string; sha: string } | { kind: "turn"; turnId: string; ts: string };
export type RoomDiff = Diff & { base: RoomBase };

/** A missing diff is "nothing to show", not an error. */
export const orNull = <T,>(promise: Promise<T>) => promise.catch((error) => (error instanceof ApiError && error.status === 404 ? null : Promise.reject(error)));

// The composer's +/− and the Зміни panel's "Уся кімната" show the same diff; one request serves both.
let last: { key: string; promise: Promise<RoomDiff | null> } | null = null;

const keyOf = (room: RoomState) => `${room.id}:${room.turns.filter((t) => t.status !== "running").length}:${room.commits.length}`;

/**
 * The room's whole change against where it began, asked again after each turn and checkpoint (agents change
 * the folder between). `data` is null when there is nothing to compare with yet, undefined while loading.
 */
export function useRoomDiff(room: RoomState | undefined) {
  const key = room ? keyOf(room) : null;
  const [state, setState] = useState<{ key: string | null; data?: RoomDiff | null; error?: string }>({ key: null });
  useEffect(() => {
    if (!key || !room) return;
    let live = true;
    if (last?.key !== key) last = { key, promise: orNull(api<RoomDiff>("GET", roomPath(room.id, "/room-diff"))) };
    const mine = last;
    mine.promise
      .then((data) => live && setState({ key, data }))
      .catch((error) => {
        if (last === mine) last = null;
        if (live && !(error instanceof Unauthorized)) setState({ key, error: errText(error) });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { key };
}
