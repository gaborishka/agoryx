import {
  CircleHelpIcon,
  FileTextIcon,
  FolderOpenIcon,
  LayoutListIcon,
  MessagesSquareIcon,
  PaletteIcon,
  PlusIcon,
  SettingsIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { ago } from "@/lib/format";
import { useStore } from "@/lib/store";
import { THEME_LABEL, useTheme } from "@/lib/theme";

export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const rooms = useStore((s) => s.rooms);
  const room = useStore((s) => s.snap?.state);
  const go = useStore((s) => s.go);
  const togglePanel = useStore((s) => s.togglePanel);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const openDialog = useStore((s) => s.openDialog);
  const theme = useTheme();
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Усі дії" description="Кімнати, панелі й налаштування" className="rounded-2xl shadow-lift sm:max-w-xl">
      <CommandInput placeholder="Кімната чи дія…" />
      <CommandList className="scroll-thin max-h-[min(60vh,440px)]">
        <CommandEmpty>Нічого не знайдено.</CommandEmpty>
        <CommandGroup heading="Дії">
          <CommandItem onSelect={run(() => go({ kind: "new" }))}>
            <PlusIcon />
            Нова кімната
          </CommandItem>
          {room ? (
            <>
              <CommandItem onSelect={run(() => setView(view === "table" ? "chat" : "table"))}>
                <LayoutListIcon />
                {view === "table" ? "Розмова" : "Стіл"}
                <CommandShortcut>вигляд</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={run(() => togglePanel("doc"))}>
                <FileTextIcon />
                Документ
                <CommandShortcut>панель</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={run(() => openDialog({ kind: "files" }))}>
                <FolderOpenIcon />
                Файли робочої теки
              </CommandItem>
              <CommandItem onSelect={run(() => useStore.getState().openSession())}>
                <SquareTerminalIcon />
                Сесії агентів
              </CommandItem>
              <CommandItem onSelect={run(() => openDialog({ kind: "table-form", op: "ask" }))}>
                <LayoutListIcon />
                Покласти питання на стіл
              </CommandItem>
              <CommandItem onSelect={run(() => openDialog({ kind: "settings" }))}>
                <SettingsIcon />
                Налаштування кімнати
              </CommandItem>
            </>
          ) : null}
          <CommandItem onSelect={run(theme.cycle)} keywords={["тема", "theme", "dark", "light"]}>
            <PaletteIcon />
            Змінити тему
            <CommandShortcut>{THEME_LABEL[theme.pref]}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={run(() => openDialog({ kind: "help" }))}>
            <CircleHelpIcon />
            Як це працює
          </CommandItem>
        </CommandGroup>
        {rooms.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Кімнати">
              {rooms.map((r) => (
                <CommandItem key={r.id} value={`${r.name} ${r.id}`} onSelect={run(() => go({ kind: "room", id: r.id }))}>
                  <MessagesSquareIcon />
                  <span className="truncate">{r.name}</span>
                  <CommandShortcut className="tabular">{r.running ? "працюють" : ago(r.updatedAt)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
