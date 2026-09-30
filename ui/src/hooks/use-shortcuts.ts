import { useEffect } from "react";
import { toast } from "sonner";
import { sidebarOrder } from "@/components/Sidebar";
import { Unauthorized } from "@/lib/api";
import { type Shortcut, shortcutOf, typingIn } from "@/lib/keys";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";

/** Something open over the page takes its own keys: a menu, a list, a popover, a dialog. */
const layerOpen = () => Boolean(document.querySelector("[role=menu], [role=listbox], [role=dialog], [data-slot=popover-content]"));

/** Where the key was pressed lets it through: see `When` in lib/keys.ts. */
const allowed = (s: Shortcut, target: EventTarget | null) => {
  if (s.when === "always" || !typingIn(target)) return true;
  if (s.when !== "empty") return false;
  return (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && !target.value;
};

/** The composer (or the start screen's first message) takes the focus, the caret at the end. */
const focusComposer = () => {
  const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]:not(:disabled)");
  if (!field) return;
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
};

const stepRoom = (step: 1 | -1) => {
  const s = useStore.getState();
  const current = s.route.kind === "room" ? s.route.id : null;
  const list = sidebarOrder(s.rooms, current);
  const at = list.findIndex((r) => r.id === current);
  // From outside the list (the start screen, a room the filter hides): its first or last room.
  const next = at < 0 ? (step > 0 ? list[0] : list.at(-1)) : list[at + step];
  if (next) s.go({ kind: "room", id: next.id });
};

const stopAgents = () => {
  const s = useStore.getState();
  const active = s.snap?.driven && s.snap.state.runs.at(-1)?.status === "active";
  if (!active) {
    toast("Агенти зараз не працюють.");
    return;
  }
  s.post("/stop").catch((error) => {
    if (!(error instanceof Unauthorized)) toast.error(errText(error));
  });
};

/** The page's keys (lib/keys.ts lists them): one listener for the whole app. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const s = useStore.getState();
      if (event.key === "Escape") {
        if (s.dialog || s.paletteOpen || layerOpen()) return;
        // Text being typed takes its own Esc — except the panel's single-line fields (the browser's address),
        // whose next Esc is the panel's.
        const inPanel = event.target instanceof Element && event.target.closest("[data-side-panel]");
        if (typingIn(event.target) && !(inPanel && event.target instanceof HTMLInputElement)) return;
        if (s.navOpen) s.setNavOpen(false);
        else if (s.panel) s.setPanel(null);
        return;
      }
      const hit = shortcutOf(event);
      if (!hit) return;
      if (hit.id === "palette") {
        event.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }
      if (s.dialog || s.paletteOpen || layerOpen() || !allowed(hit, event.target)) return;
      const room = s.route.kind === "room" && s.snap ? s.snap.state : null;
      const inRoom = ["chat", "table", "panel", "session", "stop"].includes(hit.id);
      if (inRoom && !room) return;
      event.preventDefault();
      if (event.repeat) return;
      switch (hit.id) {
        case "settings":
          s.go({ kind: "settings", section: s.route.kind === "settings" ? s.route.section : "general" });
          break;
        case "keys":
          s.openDialog({ kind: "keys" });
          break;
        case "compose":
          focusComposer();
          break;
        case "prevRoom":
          stepRoom(-1);
          break;
        case "nextRoom":
          stepRoom(1);
          break;
        case "chat":
          s.setView("chat");
          break;
        case "table":
          s.setView("table");
          break;
        case "panel":
          s.togglePanel();
          break;
        case "session":
          s.openSession(undefined, true);
          break;
        case "stop":
          stopAgents();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
