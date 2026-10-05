import { useEffect, useRef, useState } from "react";
import { api, roomPath, Unauthorized } from "./api";
import type { TranscriptTool, TurnState } from "./types";

interface ActivityReply { turn: string; sessionId: string | null; entries: TranscriptTool[]; start: number; size: number }
interface ActivityView { entries: TranscriptTool[]; start: number; loading: boolean; sessionId?: string | null; error?: string }
const empty: ActivityView = { entries: [], start: 0, loading: true };
const merge = (old: TranscriptTool[], next: TranscriptTool[]) => [...new Map([...old, ...next].map((e) => [e.id, e])).values()];

/** Only while a reader opens details; running tools refresh until the turn ends. */
export function useTurnActivity(roomId: string | undefined, turn: TurnState | undefined, enabled: boolean) {
  const [view, setView] = useState<ActivityView>(empty);
  const [revision, setRevision] = useState(0);
  const identity = `${roomId}:${turn?.id}`;
  const live = useRef(identity);
  live.current = identity;
  const previous = useRef(identity);
  useEffect(() => {
    if (!enabled || !roomId || !turn) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (previous.current !== identity) { previous.current = identity; setView(empty); }
    const tick = async () => {
      try {
        const reply = await api<ActivityReply>("GET", `${roomPath(roomId, "/turn-activity")}?turn=${encodeURIComponent(turn.id)}`);
        if (!alive) return;
        setView((v) => ({ entries: v.sessionId === reply.sessionId ? merge(v.entries, reply.entries) : reply.entries,
          start: v.sessionId === reply.sessionId ? Math.min(v.start, reply.start) : reply.start, sessionId: reply.sessionId, loading: false }));
      } catch (error) {
        if (!alive || error instanceof Unauthorized) return;
        setView((v) => ({ ...v, loading: false, error: error instanceof Error ? error.message : String(error) }));
      }
      if (alive && turn.status === "running") timer = setTimeout(tick, document.visibilityState === "hidden" ? 10000 : 2000);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [roomId, turn?.id, turn?.status, turn?.sessionId, enabled, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const older = async () => {
    if (!roomId || !turn || !view.start || view.loading) return;
    setView((v) => ({ ...v, loading: true }));
    try {
      const reply = await api<ActivityReply>("GET", `${roomPath(roomId, "/turn-activity")}?turn=${encodeURIComponent(turn.id)}&end=${view.start}`);
      if (live.current === identity) setView((v) => ({ entries: v.sessionId === reply.sessionId ? merge(v.entries, reply.entries) : reply.entries, start: reply.start, sessionId: reply.sessionId, loading: false }));
    } catch (error) {
      if (live.current === identity && !(error instanceof Unauthorized)) setView((v) => ({ ...v, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };
  return { view: previous.current === identity ? view : empty, older, retry: () => setRevision((n) => n + 1) };
}
