import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon, GlobeIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AgoryxBrowser, type BrowserOp, type BrowserRect, browserBridge, refreshBrowserStates, type UrlError, useBrowserState } from "@/lib/desktop";
import { ink, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Why an address was not opened; `empty` says nothing, the field is just empty. */
const REASON: Record<UrlError, string | null> = {
  empty: null,
  "too-long": "the address is too long",
  invalid: "that doesn’t look like an address",
  scheme: "only http and https are allowed",
  agoryx: "that’s Agoryx’s own address",
};

const VERB: Record<BrowserOp, string> = {
  navigate: "is opening a page",
  snapshot: "is reading the page",
  click: "is clicking",
  type: "is typing",
  press: "is pressing a key",
  screenshot: "is taking a screenshot",
  eval: "is running a script",
};

/** The app's refusal as it wrote it: Electron prefixes a rejected IPC call with its own English words. */
const errText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");

/**
 * The room's browser in the side panel. The page itself is the app's native view, laid over the placeholder
 * below the toolbar: the panel only tells the app where that is. Nothing here opens, loads or reloads a page
 * unless the human asks.
 */
export function BrowserPanel() {
  const room = useStore((s) => s.snap?.state.id ?? null);
  const bridge = browserBridge();
  if (!bridge || !room) return <div className="min-h-0 flex-1" />;
  return <Pane key={room} room={room} bridge={bridge} />;
}

function Pane({ room, bridge }: { room: string; bridge: AgoryxBrowser }) {
  const seating = useStore((s) => s.snap?.state);
  // The native view draws above the page, so it steps aside while something opens over the panel.
  const covered = useStore((s) => s.dialog !== null || s.paletteOpen);
  const navOpen = useStore((s) => s.navOpen);
  // A room whose network is off has no browser, for agents and for the human alike.
  const networkOn = useStore((s) => s.snap?.state.settings.network ?? true);
  const state = useBrowserState(room);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const url = state?.url && state.url !== "about:blank" ? state.url : "";
  // A pane made (or crashed) after the panel opened is placed again.
  const pane = state ? (state.crashed ? "crashed" : "live") : "none";

  useEffect(() => refreshBrowserStates(), []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const aside = el.closest("aside");
    let last: string | undefined;
    const place = (rect: BrowserRect | null) => {
      const key = JSON.stringify(rect);
      if (key === last) return;
      last = key;
      bridge.place(room, rect);
    };
    const send = () => {
      // While the panel slides in, the page waits for the end, so it never shows off its place.
      const moving = aside?.getAnimations().some((animation) => animation.playState === "running") ?? false;
      const nav = navOpen && !window.matchMedia("(min-width: 1024px)").matches;
      if (covered || nav || moving) return place(null);
      const rect = el.getBoundingClientRect();
      place({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    send();
    const observer = new ResizeObserver(send);
    observer.observe(el);
    window.addEventListener("resize", send);
    aside?.addEventListener("animationend", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
      aside?.removeEventListener("animationend", send);
    };
  }, [bridge, room, covered, navOpen, pane]);

  // The page goes away with the panel (or the room); a change above only moves it.
  useLayoutEffect(() => () => bridge.place(room, null), [bridge, room]);

  // Another navigation (an agent's, or a link in the page) shows its address, unless the human is typing one.
  useEffect(() => {
    if (document.activeElement === field.current) return;
    setDraft(null);
    setRefusal(null);
  }, [url]);

  const go = async (target: string): Promise<boolean> => {
    try {
      const reply: unknown = await bridge.go(room, target);
      const code = (reply as { error?: UrlError } | null)?.error;
      if (code) {
        setRefusal(REASON[code] ?? null);
        return false;
      }
      setRefusal(null);
      return true;
    } catch (error) {
      toast.error(errText(error));
      return false;
    }
  };

  const driver = state?.driver ?? null;
  const who = driver ? participant(seating, driver.agent) : null;
  const outside = /^https?:\/\//i.test(state?.url ?? "");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" aria-label="Back" title="Back" disabled={!state?.canGoBack} onClick={() => void go("back")}>
            <ArrowLeftIcon className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Forward" title="Forward" disabled={!state?.canGoForward} onClick={() => void go("forward")}>
            <ArrowRightIcon className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Reload" title="Reload" disabled={!state || !networkOn} onClick={() => void go("reload")}>
            <RotateCwIcon className={cn("size-4", state?.loading && "animate-spin")} />
          </Button>
          <form
            className="mx-1 flex min-w-0 flex-1"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!(await go(field.current?.value ?? ""))) return;
              setDraft(null);
              field.current?.blur();
            }}
          >
            <Input
              ref={field}
              value={draft ?? url}
              onChange={(event) => {
                setDraft(event.target.value);
                setRefusal(null);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || (draft === null && !refusal)) return;
                // Esc takes back the typed address first; the next Esc is the panel's.
                event.preventDefault();
                setDraft(null);
                setRefusal(null);
              }}
              aria-label="Address"
              aria-invalid={refusal ? true : undefined}
              disabled={!networkOn}
              placeholder={networkOn ? "Page address" : "Network is off"}
              title={state?.title || undefined}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="h-8 text-small md:text-small"
            />
          </form>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Open in your browser"
            title="Open in your browser"
            disabled={!outside}
            onClick={() => void bridge.outside(room).catch((error: unknown) => toast.error(errText(error)))}
          >
            <ExternalLinkIcon className="size-4" />
          </Button>
        </div>
        {refusal ? (
          <p role="status" className="px-1 text-small text-destructive">
            Can’t open this address: {refusal}.
          </p>
        ) : null}
        {state?.crashed ? (
          <p className="flex items-start gap-1.5 px-1 text-small text-amber">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>The page crashed. Click “Reload” or wait for the agent’s next action.</span>
          </p>
        ) : null}
        {driver && who ? (
          <p className="flex items-center gap-2 px-1 text-small text-muted-foreground">
            <span className={cn("size-2 shrink-0 animate-breathe rounded-full", who.tone === "codex" ? "bg-codex" : "bg-claude")} style={ink(who)} />
            <span className="truncate">
              {driver.label} {VERB[driver.op] ?? "is working in the browser"}…
            </span>
          </p>
        ) : null}
      </div>
      <div ref={box} className={cn("min-h-0 flex-1", state ? "bg-white" : "grid place-items-center px-6")}>
        {state ? null : (
          <div className="flex max-w-[44ch] flex-col items-center gap-4 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-secondary text-primary">
              <GlobeIcon className="size-5" />
            </span>
            <p className="text-ui leading-relaxed text-pretty text-muted-foreground">
              {networkOn
                ? "The page an agent opens will appear here. You can open one yourself too: type an address above."
                : "Network is off in this room, so the browser is off too. You can turn the network on in the room’s settings."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
