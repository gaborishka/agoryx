import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/**
 * The pages' way to the app (a sandboxed preload, so CommonJS). The bundled start page gets `agoryxDesktop`;
 * the daemon's UI gets `agoryxBrowser`, the room's browser, and nothing else. The main process checks the
 * sender again: a window the UI opens gets the object too, and its calls are refused. The room's browser
 * itself has no preload.
 */
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("agoryxDesktop", {
    /** Calls back with the current state now and with every change; returns an unsubscribe. */
    onState(callback: (state: unknown) => void): () => void {
      const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on("agoryx:state", listener);
      void ipcRenderer.invoke("agoryx:state").then(callback);
      return () => {
        ipcRenderer.removeListener("agoryx:state", listener);
      };
    },
    retry: (): Promise<void> => ipcRenderer.invoke("agoryx:retry"),
    openAnyway: (): Promise<void> => ipcRenderer.invoke("agoryx:open"),
    openLog: (): Promise<void> => ipcRenderer.invoke("agoryx:log"),
    /** With `probe`, one real prompt to each signed-in agent. */
    runDoctor: (probe = false): Promise<unknown> => ipcRenderer.invoke("agoryx:doctor", probe === true),
  });
}

/** The room's browser (docs/archive/plans/2026-09-29-desktop-browser-pane.md, C3): only the daemon's page, not a raw preview. */
if (location.protocol === "http:" && !location.pathname.startsWith("/raw/")) {
  contextBridge.exposeInMainWorld("agoryxBrowser", {
    /** The room's pane at `rect` (CSS px of this page), or every pane hidden with null. */
    place: (room: string, rect: unknown): void => ipcRenderer.send("agoryx:browser:place", room, rect),
    states: (): Promise<unknown> => ipcRenderer.invoke("agoryx:browser:states"),
    go: (room: string, target: string): Promise<unknown> => ipcRenderer.invoke("agoryx:browser:go", room, target),
    outside: (room: string): Promise<void> => ipcRenderer.invoke("agoryx:browser:outside", room),
    /** Calls back with every pane's state now (a list) and with each change (one state); returns an unsubscribe. */
    onState(callback: (state: unknown) => void): () => void {
      const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on("agoryx:browser:state", listener);
      void ipcRenderer.invoke("agoryx:browser:states").then(callback, () => {});
      return () => {
        ipcRenderer.removeListener("agoryx:browser:state", listener);
      };
    },
  });
}
