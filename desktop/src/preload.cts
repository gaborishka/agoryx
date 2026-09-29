import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/**
 * The start page's way to the app (a sandboxed preload, so CommonJS). Exposed to the bundled start page
 * only: the daemon's UI and whatever a room opens in a window get nothing, and the main process checks
 * the sender again.
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
