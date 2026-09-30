import { FileTextIcon, FolderIcon, GitCompareArrowsIcon, GlobeIcon, type LucideIcon, Maximize2Icon, Minimize2Icon, SquareTerminalIcon, XIcon } from "lucide-react";
import { lazy, type KeyboardEvent, type ReactNode, Suspense, useEffect, useRef } from "react";
import { EmptyState, Loading } from "@/components/common/states";
import { Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { browserBridge, useBrowserState } from "@/lib/desktop";
import { ink, participant } from "@/lib/room";
import { type PanelTab, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

// The room's one side panel: its tabs show an agent's session, the shared document, the room's browser
// (in the app), what turns changed, and the workspace's files. Diffs and file views (Pierre + Shiki) are
// the heavy part of the page: each tab loads with its first opening, and all are fetched while idle.

const loaders = {
  session: () => import("@/components/session/SessionPanel"),
  doc: () => import("@/components/doc/DocPanel"),
  browser: () => import("@/components/browser/BrowserPanel"),
  diff: () => import("@/components/panel/ChangesPanel"),
  files: () => import("@/components/panel/FilesPanel"),
};
const SessionPanel = lazy(() => loaders.session().then((m) => ({ default: m.SessionPanel })));
const DocPanel = lazy(() => loaders.doc().then((m) => ({ default: m.DocPanel })));
const BrowserPanel = lazy(() => loaders.browser().then((m) => ({ default: m.BrowserPanel })));
const ChangesPanel = lazy(() => loaders.diff().then((m) => ({ default: m.ChangesPanel })));
const FilesPanel = lazy(() => loaders.files().then((m) => ({ default: m.FilesPanel })));

export const warmPanels = () =>
  Promise.all(
    (Object.keys(loaders) as PanelTab[]).filter((tab) => tab !== "browser" || browserBridge()).map((tab) => loaders[tab]()),
  );

export const TABS: Record<PanelTab, { label: string; icon: LucideIcon; tip: string }> = {
  session: { label: "Сесія", icon: SquareTerminalIcon, tip: `Сесія агента: усе, що він робив; ${t.model.and}` },
  doc: { label: "Документ", icon: FileTextIcon, tip: "Спільний документ кімнати і його версії" },
  browser: { label: "Браузер", icon: GlobeIcon, tip: "Спільний браузер кімнати: агенти відкривають у ньому сторінки, а ви бачите кожен крок" },
  diff: { label: "Зміни", icon: GitCompareArrowsIcon, tip: "Що ходи змінили у файлах" },
  files: { label: "Файли", icon: FolderIcon, tip: "Файли робочої теки" },
};

/** The tabs this page has: the browser only in the Agoryx app. */
export const panelTabs = (): PanelTab[] => ["session", "doc", ...(browserBridge() ? (["browser"] as const) : []), "diff", "files"];

/** The dot on the browser's tab: an agent is driving the page. */
export function Driver() {
  const room = useStore((s) => s.snap?.state);
  const state = useBrowserState(room?.id);
  const driver = state?.driver ?? null;
  if (!room || !driver) return null;
  const who = participant(room, driver.agent);
  return (
    <span
      className={cn("absolute -top-0.5 -right-0.5 size-2 animate-breathe rounded-full ring-2 ring-background", who.tone === "codex" ? "bg-codex" : "bg-claude")}
      style={ink(who)}
    />
  );
}

function TabStrip({ current }: { current: PanelTab }) {
  const setPanel = useStore((s) => s.setPanel);
  const tabs = panelTabs();
  const strip = useRef<HTMLDivElement>(null);
  // Arrows move between tabs, as in any tab list.
  const keys = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length]!;
    setPanel(next);
    requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab=${next}]`)?.focus());
  };
  return (
    <div ref={strip} role="tablist" aria-label="Панель" onKeyDown={keys} className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {tabs.map((tab) => {
        const { label, icon: Icon, tip } = TABS[tab];
        const on = tab === current;
        return (
          <Tip key={tab} tip={tip} side="bottom">
            <button
              type="button"
              role="tab"
              data-tab={tab}
              id={`panel-tab-${tab}`}
              aria-selected={on}
              aria-controls="panel-body"
              aria-label={label}
              tabIndex={on ? 0 : -1}
              onClick={() => setPanel(tab)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-small font-medium transition",
                on ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="relative">
                <Icon className="size-4" />
                {tab === "browser" ? <Driver /> : null}
              </span>
              <span className={cn(on ? "inline" : "hidden @min-[34rem]:inline")}>{label}</span>
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

function Body({ tab }: { tab: PanelTab }) {
  let body: ReactNode;
  if (tab === "session") body = <SessionPanel />;
  else if (tab === "browser") {
    body = browserBridge() ? <BrowserPanel /> : <EmptyState icon={GlobeIcon} title="Лише в застосунку" text="Спільний браузер кімнати є в застосунку Agoryx для macOS." />;
  } else if (tab === "diff") body = <ChangesPanel />;
  else if (tab === "files") body = <FilesPanel />;
  else {
    body = (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <DocPanel />
      </div>
    );
  }
  return (
    <div id="panel-body" role="tabpanel" aria-labelledby={`panel-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<Loading className="p-4" />}>{body}</Suspense>
    </div>
  );
}

/**
 * Docked beside the room on a wide screen; below that it slides over the room, and on a phone it is
 * a full-screen sheet with a plain «Закрити».
 */
export function SidePanel({ overlay, phone }: { overlay: boolean; phone: boolean }) {
  const panel = useStore((s) => s.panel);
  const wide = useStore((s) => s.wide);
  const setWide = useStore((s) => s.setWide);
  const setPanel = useStore((s) => s.setPanel);
  const aside = useRef<HTMLElement>(null);
  const open = !!panel;
  // Closed, the focus goes back where it came from (or to the header's panel button), not to the page's top.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    if (open) {
      const from = document.activeElement;
      opener.current = from instanceof HTMLElement && from !== document.body && !aside.current?.contains(from) ? from : null;
      return;
    }
    const from = opener.current;
    if (from === undefined) return; // never opened here: nothing to give back
    opener.current = undefined;
    if (document.activeElement && document.activeElement !== document.body) return;
    const back = from?.isConnected ? from : document.querySelector<HTMLElement>("[data-panel-toggle]");
    back?.focus({ preventScroll: true });
  }, [open]);
  // Over the room, the panel takes the focus, so typing and Esc do not go to the composer hidden under it.
  useEffect(() => {
    const el = aside.current;
    if (!open || !overlay || !el || el.contains(document.activeElement)) return;
    el.focus({ preventScroll: true });
  }, [open, overlay]);
  if (!panel) return null;
  // The room's page is laid out 1280 px wide and scaled in, so docked it always takes the wide width.
  const browser = panel === "browser";
  return (
    <>
      {overlay && !phone ? <button type="button" aria-label="Закрити панель" className="fixed inset-0 z-30 bg-black/25 backdrop-blur-[1px]" onClick={() => setPanel(null)} /> : null}
      <aside
        ref={aside}
        tabIndex={-1}
        aria-label={TABS[panel].label}
        data-side-panel
        className={cn(
          "@container flex min-h-0 flex-col border-l outline-none border-border bg-background animate-in duration-200 fade-in-0",
          phone
            ? "fixed inset-0 z-40 slide-in-from-bottom-8"
            : overlay
              ? "fixed inset-y-0 right-0 z-40 w-[min(560px,100vw)] shadow-lift slide-in-from-right-8"
              : cn("slide-in-from-right-8", wide || browser ? "w-[min(760px,52vw)]" : "w-[440px] xl:w-[480px]"),
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-2 sm:px-3">
          <TabStrip current={panel} />
          <div className="ml-auto flex shrink-0 items-center">
            {!overlay && !browser ? (
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setWide(!wide)} aria-label={wide ? "Вужче" : "Ширше"} title={wide ? "Вужче" : "Ширше"}>
                {wide ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
              </Button>
            ) : null}
            {phone ? (
              <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-small" onClick={() => setPanel(null)}>
                <XIcon className="size-4" />
                Закрити
              </Button>
            ) : (
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setPanel(null)} aria-label="Закрити панель" title="Закрити (Esc)">
                <XIcon className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <Body tab={panel} />
      </aside>
    </>
  );
}
