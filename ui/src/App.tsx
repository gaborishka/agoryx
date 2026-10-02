import { lazy, Suspense, useEffect, useState } from "react";
import { Palette } from "@/components/Palette";
import { SidePanel, warmPanels } from "@/components/panel/SidePanel";
import { Mark } from "@/components/brand/Mark";
import { NAV, navWidthOf, PANEL_MIN, ResizeHandle, ROOM_MIN, useViewportWidth } from "@/components/common/ResizeHandle";
import { Composer, StatusBar } from "@/components/room/Composer";
import { Feed } from "@/components/room/Feed";
import { NavButton, RoomHeader } from "@/components/room/RoomHeader";
import { Sidebar } from "@/components/Sidebar";
import { StartScreen } from "@/components/StartScreen";
import { TableBoard } from "@/components/table/TableBoard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { claimPairing, onThisComputer, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// Settings, help and the table's forms: loaded with the first dialog, and fetched while idle.
const loadSettings = () => import("@/components/settings/Settings");
const Settings = lazy(() => loadSettings().then((m) => ({ default: m.Settings })));

const TerminalDrawer = lazy(() => import("@/components/terminal/Terminals").then((m) => ({ default: m.TerminalDrawer })));

const loadDialogs = () => import("@/components/dialogs/Dialogs");
const Dialogs = lazy(() => loadDialogs().then((m) => ({ default: m.Dialogs })));

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
        <Mark className="size-14" />
        <h1 className="font-display text-[28px] leading-tight font-[650]">{title}</h1>
        <div className="flex flex-col gap-3 text-body leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

/** Off this computer: the code `agoryx pair` shows, typed in (an iPhone's home-screen app has cookies of its own, so a scanned link does not carry over). */
function PairForm() {
  const pairError = useStore((s) => s.pairError);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await claimPairing(code);
      location.replace("/");
    } catch (error) {
      useStore.setState({ pairError: error instanceof Error ? error.message : String(error) });
      setBusy(false);
    }
  };
  return (
    <>
      <p>
        This device isn’t paired yet. On your computer, run <code className="font-mono text-foreground">agoryx pair</code> or choose “Open on phone”, then scan the QR code or enter the code here.
      </p>
      <form onSubmit={submit} className="flex w-full gap-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD-EFGH"
          aria-label="Code from your computer"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          className="h-10 flex-1 text-center font-mono tracking-widest uppercase"
        />
        <Button type="submit" className="h-10" disabled={busy || code.replace(/[^0-9a-z]/gi, "").length < 8}>
          Sign in
        </Button>
      </form>
      {pairError ? <p className="text-small text-destructive">{pairError}</p> : null}
    </>
  );
}

const Cmd = ({ children }: { children: string }) => <code className="rounded-lg border border-border bg-code px-2.5 py-1.5 font-mono text-small text-foreground">{children}</code>;

function RoomLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 items-center gap-3 border-b border-border/70 px-4">
        <NavButton />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="ml-auto h-7 w-40 rounded-full" />
      </div>
      <div className="mx-auto flex w-full max-w-reading flex-col gap-6 px-6 py-8">
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
  const terminal = useStore((s) => s.terminalOpen && s.snap?.state.mode !== "chat");
  const roomId = useStore((s) => s.snap?.state.id);
  if (!loaded) return <RoomLoading />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RoomHeader />
      {view === "table" ? <TableBoard /> : <Feed />}
      <div className={cn("shrink-0 px-3 pb-3 sm:px-5 sm:pb-4", view === "table" && "border-t border-border/70 bg-canvas pt-3")}>
        <div className="mx-auto flex w-full max-w-reading flex-col gap-2">
          <StatusBar />
          <Composer />
        </div>
      </div>
      {terminal ? (
        <Suspense fallback={null}>
          <TerminalDrawer key={roomId} />
        </Suspense>
      ) : null}
    </div>
  );
}

function Shell() {
  const route = useStore((s) => s.route);
  const navOpen = useStore((s) => s.navOpen);
  const navCollapsed = useStore((s) => s.navCollapsed);
  const setNavOpen = useStore((s) => s.setNavOpen);
  const desktop = useWideScreen("(min-width: 1024px)");
  const roomy = useWideScreen("(min-width: 1181px)");
  const phone = !useWideScreen("(min-width: 640px)");
  const nav = navWidthOf(useStore((s) => s.navWidth));
  const setNavWidth = useStore((s) => s.setNavWidth);
  const viewport = useViewportWidth();
  const panelOpen = useStore((s) => s.panel !== null);
  // Docked only where the room list, the panel and a readable conversation all fit; while it is docked,
  // the room list is not dragged so wide that it would push the panel over the conversation.
  const docked = roomy && viewport - (desktop && !navCollapsed ? nav : 0) >= PANEL_MIN + ROOM_MIN;
  const navMax = docked && panelOpen ? Math.max(nav, Math.min(NAV.max, viewport - PANEL_MIN - ROOM_MIN)) : NAV.max;
  return (
    <div className="flex h-full min-h-0 bg-background">
      {desktop && !navCollapsed ? (
        <div className="relative shrink-0 border-r border-border/70" style={{ width: nav }}>
          <Sidebar />
          <ResizeHandle label="Room list width" value={nav} min={NAV.min} max={navMax} grows="left" onChange={setNavWidth} onReset={() => setNavWidth(null)} />
        </div>
      ) : !desktop && navOpen ? (
        <>
          <button type="button" aria-label="Close menu" className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" onClick={() => setNavOpen(false)} />
          <div className="fixed inset-y-0 left-0 z-50 w-[min(300px,86vw)] shadow-lift">
            <Sidebar />
          </div>
        </>
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1">
        {route.kind === "room" ? (
          <Room />
        ) : route.kind === "new" ? (
          <StartScreen />
        ) : route.kind === "settings" ? (
          <Suspense fallback={null}>
            <Settings section={route.section} />
          </Suspense>
        ) : null}
      </main>
      {route.kind === "room" ? <SidePanel overlay={!docked} phone={phone} /> : null}
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
    // Warm the lazy chunks while the page is idle, so the first dialog or tab opens without a wait.
    const warm = () => void Promise.all([loadDialogs(), loadSettings(), warmPanels()]).catch(() => {});
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(warm, 1500);
    return () => clearTimeout(timer);
  }, []);
  useShortcuts();
  let body;
  if (gate) {
    body = (
      <Notice title="Sign-in required">
        {onThisComputer() ? (
          <>
            <p>This browser doesn’t have access to the Agoryx daemon yet. Open the link with a token by running:</p>
            <Cmd>agoryx open</Cmd>
          </>
        ) : (
          <PairForm />
        )}
      </Notice>
    );
  } else if (bootError) {
    body = (
      <Notice title="The daemon isn’t responding">
        <p>Couldn’t load the list of rooms ({bootError}). Start the daemon:</p>
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
