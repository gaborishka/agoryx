import { FileTextIcon, LayoutListIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialogs } from "@/components/dialogs/Dialogs";
import { DocPanel } from "@/components/doc/DocPanel";
import { Palette } from "@/components/Palette";
import { AgoraGlyph } from "@/components/room/bits";
import { Composer, StatusBar } from "@/components/room/Composer";
import { Feed } from "@/components/room/Feed";
import { RoomHeader } from "@/components/room/RoomHeader";
import { Sidebar } from "@/components/Sidebar";
import { StartScreen } from "@/components/StartScreen";
import { TablePanel } from "@/components/table/TablePanel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tableCount } from "@/lib/room";
import { type PanelTab, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

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

function PanelTabs() {
  const room = useStore((s) => s.snap?.state);
  const panel = useStore((s) => s.panel);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const tab = (id: PanelTab, label: string, Icon: typeof FileTextIcon, badge?: number) => (
    <button
      type="button"
      onClick={() => setPanelTab(id)}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition",
        panel === id ? "bg-card text-foreground shadow-soft ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
      {badge ? <span className="tabular rounded-full bg-secondary px-1.5 text-[11px] text-secondary-foreground">{badge}</span> : null}
    </button>
  );
  return (
    <div className="flex items-center gap-1 rounded-xl bg-muted/70 p-1">
      {tab("table", "Стіл", LayoutListIcon, room ? tableCount(room) : 0)}
      {tab("doc", "Документ", FileTextIcon)}
    </div>
  );
}

function SidePanel({ overlay }: { overlay: boolean }) {
  const panel = useStore((s) => s.panel);
  const wide = useStore((s) => s.wide);
  const setWide = useStore((s) => s.setWide);
  const setPanel = useStore((s) => s.setPanel);
  if (!panel) return null;
  return (
    <>
      {overlay ? <button type="button" aria-label="Закрити панель" className="fixed inset-0 z-30 bg-black/25 backdrop-blur-[1px]" onClick={() => setPanel(null)} /> : null}
      <aside
        aria-label={panel === "table" ? "Стіл" : "Документ"}
        className={cn(
          "flex min-h-0 flex-col border-l border-border bg-background",
          overlay ? "fixed inset-y-0 right-0 z-40 w-[min(560px,100vw)] shadow-lift" : wide ? "w-[min(760px,52vw)]" : "w-[440px] xl:w-[480px]",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <PanelTabs />
          <div className="ml-auto flex items-center">
            {!overlay ? (
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setWide(!wide)} aria-label={wide ? "Вужче" : "Ширше"} title={wide ? "Вужче" : "Ширше"}>
                {wide ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
              </Button>
            ) : null}
            <Button variant="ghost" size="icon" className="size-8" onClick={() => setPanel(null)} aria-label="Закрити панель" title="Закрити (Esc)">
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{panel === "table" ? <TablePanel /> : <DocPanel />}</div>
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
  if (!loaded) return <RoomLoading />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RoomHeader />
      <Feed />
      <div className="shrink-0 px-3 pb-3 sm:px-5 sm:pb-4">
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
      <Dialogs />
      <Palette />
      <Toaster position="bottom-center" />
    </TooltipProvider>
  );
}
