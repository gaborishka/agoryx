import { create } from "zustand";
import { ApiError, api, roomPath } from "./api";
import { errText } from "./load";

// The editor's saves, as T3 Code does them: a change is written half a second after the typing stops, one write
// at a time per file, each naming the version it edited. If the file changed on disk since (an agent wrote it),
// nothing is written and the file shows the conflict until the human picks: keep theirs or take the disk's.
// It lives outside React, so a save still lands after its tab is closed.

export type SaveStatus = "saved" | "dirty" | "saving" | "conflict" | "error";

export interface SaveState {
  status: SaveStatus;
  /** What is on disk now, on a conflict (null: the file is gone or too large to show). */
  disk?: { hash: string | null; text: string | null };
  error?: string;
}

export const useSaves = create<{ files: Record<string, SaveState> }>(() => ({ files: {} }));

const DELAY = 500;

class Saver {
  /** The hash of the version on disk this editor's text is based on (null: a file not written yet). */
  base: string | null;
  pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing = false;

  constructor(
    readonly room: string,
    readonly path: string,
    base: string | null,
  ) {
    this.base = base;
  }

  private get key() {
    return `${this.room}:${this.path}`;
  }

  private show(state: SaveState) {
    useSaves.setState((s) => ({ files: { ...s.files, [this.key]: state } }));
  }

  get state(): SaveState {
    return useSaves.getState().files[this.key] ?? { status: "saved" };
  }

  /** Clean: nothing typed that is not on disk. */
  get clean() {
    return this.pending === null && !this.writing && this.state.status !== "conflict";
  }

  change(text: string) {
    this.pending = text;
    if (this.state.status !== "conflict") this.show({ status: "dirty" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DELAY);
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.writing || this.pending === null || this.state.status === "conflict") return;
    const text = this.pending;
    this.pending = null;
    this.writing = true;
    this.show({ status: "saving" });
    try {
      const saved = await api<{ hash: string }>("POST", roomPath(this.room, "/file"), { path: this.path, text, base: this.base });
      this.base = saved.hash;
      this.writing = false;
      if (this.pending !== null) await this.flush();
      else this.show({ status: "saved" });
    } catch (error) {
      this.writing = false;
      // What was being written is still the human's latest unless they typed on.
      this.pending ??= text;
      if (error instanceof ApiError && error.status === 409) {
        const body = error.body as { hash?: string | null; text?: string | null };
        this.show({ status: "conflict", disk: { hash: body.hash ?? null, text: body.text ?? null } });
      } else {
        this.show({ status: "error", error: errText(error) });
      }
    }
  }

  /** Keep the editor's text: written over what is on disk now. */
  overwrite() {
    const disk = this.state.disk;
    this.base = disk?.hash ?? null;
    this.show({ status: "dirty" });
    void this.flush();
  }

  /** Take the disk's version: the editor's unsaved text is dropped. */
  discard(base: string | null) {
    clearTimeout(this.timer);
    this.pending = null;
    this.base = base;
    this.show({ status: "saved" });
  }
}

const savers = new Map<string, Saver>();

/** The one saver of a file in a room; `base` is the version the editor opened, used when there is none yet (the editor moves it on). */
export const saverFor = (room: string, path: string, base: string | null) => {
  const key = `${room}:${path}`;
  let saver = savers.get(key);
  if (!saver) {
    saver = new Saver(room, path, base);
    savers.set(key, saver);
  }
  return saver;
};

const SAVED: SaveState = { status: "saved" };

export const useSaveState = (room: string, path: string): SaveState => useSaves((s) => s.files[`${room}:${path}`] ?? SAVED);

/** Unsaved text anywhere: the page asks before it is left. */
export const unsaved = () => [...savers.values()].some((s) => !s.clean);
