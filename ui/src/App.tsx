import { FileTextIcon, GlobeIcon, Maximize2Icon, Minimize2Icon, SquareTerminalIcon, XIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Palette } from "@/components/Palette";
import { AgoraGlyph } from "@/components/room/bits";
import { Composer, StatusBar } from "@/components/room/Composer";
import { Feed } from "@/components/room/Feed";
import { RoomHeader } from "@/components/room/RoomHeader";
import { Sidebar } from "@/components/Sidebar";
import { StartScreen } from "@/components/StartScreen";
import { TableBoard } from "@/components/table/TableBoard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { browserBridge } from "@/lib/desktop";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// Diffs and file views (Pierre + Shiki) are the heavy part of the page: they load with the first
// dialog or document panel, and are fetched in the background once the room is up.
const loadDialogs = () => import("@/components/dialogs/Dialogs");
const loadDocPanel = () => import("@/components/doc/DocPanel");
const loadSessionPanel = () => import("@/components/session/SessionPanel");
const loadBrowserPanel = () => import("@/components/browser/BrowserPanel");
const Dialogs = lazy(() => loadDialogs().then((m) => ({ default: m.Dialogs })));
const DocPanel = lazy(() => loadDocPanel().then((m) => ({ default: m.DocPanel })));
const SessionPanel = lazy(() => loadSessionPanel().then((m) => ({ default: m.SessionPanel })));
const BrowserPanel = lazy(() => loadBrowserPanel().then((m) => ({ default: m.BrowserPanel })));

function PanelLoading() {
  return (
    <div className="flex flex-col gap-2.5 p-4">
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

const useWideScreen = (query: string) => {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setOn(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [query]);
  return on;
};

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center bg-background px-4">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-soft">
          <AgoraGlyph className="size-6" />
        </span>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="flex flex-col gap-3 text-[14.5px] leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

const Cmd = ({ children }: { children: string }) => <code className="rounded-lg border border-border bg-code px-2.5 py-1.5 font-mono text-[13px] text-foreground">{children}</code>;

function SidePanel({ overlay }: { overlay: boolean }) {
  const panel = useStore((s) => s.panel);
  const wide = useStore((s) => s.wide);
  const setWide = useStore((s) => s.setWide);
  const setPanel = useStore((s) => s.setPanel);
  if (!panel) return null;
  const title = panel === "session" ? "Сесія агента" : panel === "browser" ? "Браузер" : "Документ";
  const TitleIcon = panel === "session" ? SquareTerminalIcon : panel === "browser" ? GlobeIcon : FileTextIcon;
  // The room's page is laid out 1280 px wide and scaled in, so docked it always takes the wide width.
  const browser = panel === "browser";
  return (
    <>
      {overlay ? <button type="button" aria-label="Закрити панель" className="fixed inset-0 z-30 bg-black/25 backdrop-blur-[1px]" onClick={() => setPanel(null)} /> : null}
      <aside
        aria-label={title}
        className={cn(
          "flex min-h-0 flex-col border-l border-border bg-background animate-in duration-200 fade-in-0 slide-in-from-right-8",
          overlay ? "fixed inset-y-0 right-0 z-40 w-[min(560px,100vw)] shadow-lift" : wide || browser ? "w-[min(760px,52vw)]" : "w-[440px] xl:w-[480px]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <span className="flex items-center gap-2 px-1 text-[14px] font-semibold">
            <TitleIcon className="size-4 text-primary" />
            {title}
          </span>
          <div className="ml-auto flex items-center">
            {!overlay && !browser ? (
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setWide(!wide)} aria-label={wide ? "Вужче" : "Ширше"} title={wide ? "Вужче" : "Ширше"}>
                {wide ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
              </Button>
            ) : null}
            <Button variant="ghost" size="icon" className="size-8" onClick={() => setPanel(null)} aria-label="Закрити панель" title="Закрити (Esc)">
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>
        {panel === "session" ? (
          <Suspense fallback={<PanelLoading />}>
            <SessionPanel />
          </Suspense>
        ) : browser ? (
          <Suspense fallback={<PanelLoading />}>
            <BrowserPanel />
          </Suspense>
        ) : (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <Suspense fallback={<PanelLoading />}>
              <DocPanel />
            </Suspense>
          </div>
        )}
      </aside>
    </>
  );
}

function RoomLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 items-center gap-3 border-b border-border/70 px-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="ml-auto h-7 w-40 rounded-full" />
      </div>
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-6 py-8">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Room() {
  const loaded = useStore((s) => Boolean(s.snap));
  const view = useStore((s) => s.view);
  if (!loaded) return <RoomLoading />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RoomHeader />
      {view === "table" ? <TableBoard /> : <Feed />}
      <div className={cn("shrink-0 px-3 pb-3 sm:px-5 sm:pb-4", view === "table" && "border-t border-border/70 bg-canvas pt-3")}>
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2">
          <StatusBar />
          <Composer />
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const route = useStore((s) => s.route);
  const navOpen = useStore((s) => s.navOpen);
  const setNavOpen = useStore((s) => s.setNavOpen);
  const desktop = useWideScreen("(min-width: 1024px)");
  const roomy = useWideScreen("(min-width: 1181px)");
  return (
    <div className="flex h-full min-h-0 bg-background">
      {desktop ? (
        <div className="w-[272px] shrink-0 border-r border-border/70">
          <Sidebar />
        </div>
      ) : navOpen ? (
        <>
          <button type="button" aria-label="Закрити меню" className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" onClick={() => setNavOpen(false)} />
          <div className="fixed inset-y-0 left-0 z-50 w-[min(300px,86vw)] shadow-lift">
            <Sidebar />
          </div>
        </>
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1">
        {route.kind === "room" ? <Room /> : route.kind === "new" ? <StartScreen /> : null}
      </main>
      {route.kind === "room" ? <SidePanel overlay={!roomy} /> : null}
    </div>
  );
}

export function App() {
  const gate = useStore((s) => s.gate);
  const bootError = useStore((s) => s.bootError);
  const dialogOpen = useStore((s) => s.dialog !== null);
  // Toasts stay in the room's column: over the browser they would be drawn under the page.
  const browserOpen = useStore((s) => s.panel === "browser");
  useEffect(() => {
    // Warm the lazy chunks while the page is idle, so the first dialog opens without a wait.
    const warm = () => void Promise.all([loadDialogs(), loadDocPanel(), loadSessionPanel(), ...(browserBridge() ? [loadBrowserPanel()] : [])]).catch(() => {});
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(warm, 1500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const s = useStore.getState();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented || s.dialog || s.paletteOpen) return;
      if (s.navOpen) s.setNavOpen(false);
      else if (s.panel && !window.matchMedia("(min-width: 1181px)").matches) s.setPanel(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  let body;
  if (gate) {
    body = (
      <Notice title="Потрібен вхід">
        <p>Цей браузер ще не має доступу до демона Agoryx. Відкрийте посилання з токеном командою:</p>
        <Cmd>agoryx open</Cmd>
      </Notice>
    );
  } else if (bootError) {
    body = (
      <Notice title="Демон не відповідає">
        <p>Не вдалося отримати список кімнат ({bootError}). Запустіть демон:</p>
        <Cmd>agoryx up -d</Cmd>
      </Notice>
    );
  } else body = <Shell />;
  return (
    <TooltipProvider delayDuration={350}>
      {body}
      {dialogOpen ? (
        <Suspense fallback={null}>
          <Dialogs />
        </Suspense>
      ) : null}
      <Palette />
      <Toaster position={browserOpen ? "bottom-left" : "bottom-center"} />
    </TooltipProvider>
  );
}
