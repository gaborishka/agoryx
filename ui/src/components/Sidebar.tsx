import { CircleHelpIcon, MonitorIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon } from "lucide-react";
import { AgoraGlyph, Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ago, roomPreview } from "@/lib/format";
import { useStore } from "@/lib/store";
import { THEME_LABEL, useTheme } from "@/lib/theme";
import type { RoomSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

function RoomRow({ room, on }: { room: RoomSummary; on: boolean }) {
  const go = useStore((s) => s.go);
  return (
    <button
      type="button"
      title={room.workspace}
      onClick={() => go({ kind: "room", id: room.id })}
      className={cn(
        "group grid w-full grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 rounded-xl px-3 py-2 text-left transition",
        on ? "bg-card shadow-soft ring-1 ring-border" : "hover:bg-foreground/[0.045]",
      )}
    >
      <span className={cn("truncate text-[13.5px] font-medium", on ? "text-foreground" : "text-foreground")}>{room.name}</span>
      {room.running ? (
        <Tip tip="Агенти працюють" side="right">
          <span className="mt-1.5 size-2 animate-breathe rounded-full bg-primary" />
        </Tip>
      ) : (
        <span className="tabular text-[11px] text-faint">{ago(room.updatedAt)}</span>
      )}
      <span className="col-span-2 truncate text-[12px] text-muted-foreground">{roomPreview(room.lastMessage)}</span>
    </button>
  );
}

export function Sidebar() {
  const rooms = useStore((s) => s.rooms);
  const route = useStore((s) => s.route);
  const go = useStore((s) => s.go);
  const openDialog = useStore((s) => s.openDialog);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const { pref, cycle } = useTheme();
  const ThemeIcon = pref === "dark" ? MoonIcon : pref === "light" ? SunIcon : MonitorIcon;
  return (
    <nav className="flex h-full w-full flex-col bg-sidebar text-foreground" aria-label="Кімнати">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <span className="grid size-8 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-soft">
          <AgoraGlyph className="size-4.5" />
        </span>
        <span className="flex flex-col leading-none">
          <span className="font-serif text-[17px] font-semibold tracking-tight">Agoryx</span>
          <span className="mt-0.5 text-[10.5px] tracking-wide text-faint">агора для людей і агентів</span>
        </span>
      </div>
      <div className="flex gap-1.5 px-3 pb-3">
        <Button
          variant={route.kind === "new" ? "secondary" : "outline"}
          className="h-9 flex-1 justify-start gap-2 rounded-xl bg-card text-[13.5px] shadow-none"
          onClick={() => go({ kind: "new" })}
        >
          <PlusIcon className="size-4" />
          Нова кімната
        </Button>
        <Tip tip={<span>Пошук і дії <Kbd>⌘K</Kbd></span>}>
          <Button variant="outline" size="icon" className="size-9 rounded-xl bg-card shadow-none" aria-label="Пошук і дії" onClick={() => setPaletteOpen(true)}>
            <SearchIcon className="size-4" />
          </Button>
        </Tip>
      </div>
      <div className="px-4 pb-1.5 text-[11px] font-medium tracking-wider text-faint uppercase">Кімнати</div>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {rooms.length ? (
          rooms.map((room) => <RoomRow key={room.id} room={room} on={route.kind === "room" && route.id === room.id} />)
        ) : (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">Кімнат ще немає.</p>
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-border/70 px-2 py-2">
        <Button variant="ghost" size="sm" className="h-8 gap-2 text-[13px] text-muted-foreground" onClick={() => openDialog({ kind: "help" })}>
          <CircleHelpIcon className="size-4" />
          Як це працює
        </Button>
        <Tip tip={`${THEME_LABEL[pref]} — натисніть, щоб змінити`}>
          <Button variant="ghost" size="icon" className="ml-auto size-8 text-muted-foreground" aria-label={THEME_LABEL[pref]} onClick={cycle}>
            <ThemeIcon className="size-4" />
          </Button>
        </Tip>
      </div>
    </nav>
  );
}
