import { GlobeIcon } from "lucide-react";
import { Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { browserBridge, useBrowserState } from "@/lib/desktop";
import { ink, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * «Браузер» in the room's header, next to «Документ»: only in the Agoryx app, which has the room's browser.
 * It never opens the panel by itself; the dot says an agent is driving the page.
 */
export function BrowserToggle({ className }: { className?: string }) {
  const room = useStore((s) => s.snap?.state);
  const on = useStore((s) => s.panel === "browser");
  const togglePanel = useStore((s) => s.togglePanel);
  const state = useBrowserState(room?.id);
  if (!browserBridge() || !room) return null;
  const driver = state?.driver ?? null;
  const who = driver ? participant(room, driver.agent) : null;
  return (
    <Tip tip="Спільний браузер кімнати: агенти відкривають у ньому сторінки, а ви бачите кожен крок">
      <Button variant="ghost" className={className} aria-label="Браузер" aria-pressed={on} onClick={() => togglePanel("browser")}>
        <span className="relative">
          <GlobeIcon className="size-4" />
          {who ? (
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 size-2 animate-breathe rounded-full ring-2 ring-background",
                who.tone === "codex" ? "bg-codex" : "bg-claude",
              )}
              style={ink(who)}
            />
          ) : null}
        </span>
        <span className="hidden @3xl:inline">Браузер</span>
      </Button>
    </Tip>
  );
}
