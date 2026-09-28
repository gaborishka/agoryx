import { ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { autosize } from "@/components/room/Composer";
import { NavButton } from "@/components/room/RoomHeader";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, local, Unauthorized } from "@/lib/api";
import { useStore } from "@/lib/store";

const EXAMPLES = [
  "Спроєктуйте разом формат журналу подій і запишіть рішення в README",
  "Перегляньте цей репозиторій і домовтеся, що виправити першим",
  "Зробіть інтерактивний прототип сторінки тарифів і покажіть його тут",
];

const Glyph = ({ tone, children }: { tone: "claude" | "codex"; children: React.ReactNode }) => (
  <span
    className={
      tone === "claude"
        ? "grid size-12 place-items-center rounded-[30%] bg-claude-soft text-claude ring-1 ring-claude/25 ring-inset"
        : "grid size-12 place-items-center rounded-[30%] bg-codex-soft text-codex ring-1 ring-codex/25 ring-inset"
    }
  >
    {children}
  </span>
);

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px]">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function StartScreen() {
  const rooms = useStore((s) => s.rooms);
  const loadRooms = useStore((s) => s.loadRooms);
  const go = useStore((s) => s.go);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => local.get("draft.new") ?? "");
  const [dir, setDir] = useState("");
  const [doc, setDoc] = useState("");
  const [budget, setBudget] = useState("8");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = "Нова кімната · Agoryx";
    setTimeout(() => ta.current?.focus(), 30);
  }, []);
  useLayoutEffect(() => autosize(ta.current, 0.45), [text]);
  const change = (value: string) => {
    setText(value);
    local.set("draft.new", value || null);
  };
  const submit = async (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const n = Number.parseInt(budget, 10);
      const { room } = await api<{ room: { id: string } }>("POST", "/api/rooms", {
        text: body,
        ...(dir.trim() ? { dir: dir.trim() } : {}),
        ...(Number.isFinite(n) && n !== 8 ? { budget: n } : {}),
        ...(doc.trim() ? { doc: doc.trim() } : {}),
      });
      local.set("draft.new", null);
      await loadRooms();
      go({ kind: "room", id: room.id });
    } catch (error) {
      if (!(error instanceof Unauthorized)) toast.error(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  const first = !rooms.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center px-3 lg:hidden">
        <NavButton />
      </header>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col justify-center gap-7 px-4 py-10 sm:px-6">
          <div className="flex flex-col items-center gap-5 text-center">
            <div className="flex items-center gap-3">
              <Glyph tone="claude">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" className="size-6">
                  <path d="M12 3v5.2M12 15.8V21M3 12h5.2M15.8 12H21M5.6 5.6l3.7 3.7M14.7 14.7l3.7 3.7M18.4 5.6l-3.7 3.7M9.3 14.7l-3.7 3.7" />
                </svg>
              </Glyph>
              <span className="h-px w-8 bg-gradient-to-r from-claude/50 to-codex/50" />
              <Glyph tone="codex">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" className="size-6">
                  <path d="M5 7l5 5-5 5M12.5 17H19" />
                </svg>
              </Glyph>
            </div>
            <h1 className="font-serif text-[clamp(26px,4vw,36px)] leading-tight font-semibold tracking-tight text-balance">
              {first ? "Спільна кімната для вас, Claude і Codex" : "Про що поговоримо?"}
            </h1>
            <p className="max-w-[54ch] text-[15px] leading-relaxed text-pretty text-muted-foreground">
              Напишіть задачу чи питання. Claude і Codex спершу відповідять незалежно, а далі працюватимуть разом по черзі — кожен у власній рідній сесії, з усіма
              своїми інструментами.
            </p>
          </div>
          <form onSubmit={submit} className="rounded-[22px] border border-input bg-card shadow-lift transition focus-within:border-ring/60">
            <textarea
              ref={ta}
              rows={3}
              value={text}
              onChange={(event) => change(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={EXAMPLES[0]}
              aria-label="Перше повідомлення"
              className="scroll-thin block min-h-[96px] w-full resize-none bg-transparent px-5 pt-4 text-[16px] leading-relaxed outline-none placeholder:text-faint"
            />
            <div className="flex items-center gap-2 px-3 pb-3">
              <span className="pl-2 text-xs text-faint">Назва кімнати — з першого рядка; змінити можна будь-коли</span>
              <Button type="submit" size="icon" className="ml-auto size-9 rounded-full" disabled={busy || !text.trim()} aria-label="Почати" title="Почати (Enter)">
                <ArrowUpIcon className="size-4.5" />
              </Button>
            </div>
          </form>
          <div className="flex flex-wrap justify-center gap-2">
            {EXAMPLES.slice(1).map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  change(example);
                  ta.current?.focus();
                }}
                className="rounded-full border border-border bg-card/60 px-3 py-1.5 text-[12.5px] text-muted-foreground transition hover:border-input hover:bg-card hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </div>
          <Collapsible className="mx-auto w-full max-w-[520px]">
            <CollapsibleTrigger className="group mx-auto flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              Параметри
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 flex flex-col gap-4 rounded-2xl border border-border bg-card/60 p-4">
              <Field id="dir" label="Робоча тека" hint="Можна вказати наявний проєкт — агенти працюватимуть у ньому (у пісочниці).">
                <Input id="dir" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Порожньо — нова git-тека в ~/agoryx" spellCheck={false} className="font-mono text-[13px]" />
              </Field>
              <Field id="doc" label="Спільний документ" hint="Файл, який кімната пише разом; кожна версія зберігається з автором.">
                <Input id="doc" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="README.md" spellCheck={false} className="font-mono text-[13px]" />
              </Field>
              <Field id="budget" label="Ходів агентів на ваше повідомлення">
                <Input id="budget" type="number" min={1} max={100} value={budget} onChange={(e) => setBudget(e.target.value)} className="w-28" />
              </Field>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
