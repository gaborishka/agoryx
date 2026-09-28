import { ArrowUpIcon, PlayIcon, SquareIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { local, Unauthorized } from "@/lib/api";
import { plural } from "@/lib/format";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const fail = (error: unknown) => {
  if (!(error instanceof Unauthorized)) toast.error(error instanceof Error ? error.message : String(error));
};

const dot = "size-2 shrink-0 rounded-full";

export function StatusBar() {
  const snap = useStore((s) => s.snap);
  const post = useStore((s) => s.post);
  const [busy, setBusy] = useState(false);
  const run = snap?.state.runs.at(-1);
  useEffect(() => setBusy(false), [run?.id, run?.status, run?.budget]);
  if (!snap) return null;
  const st = snap.state;
  const working = st.agents.filter((a) => snap.presence?.[a.id] === "working").map((a) => a.label);
  const native = st.agents.filter((a) => snap.presence?.[a.id] === "native");
  const act = (suffix: string) => {
    setBusy(true);
    post(suffix).catch((error) => {
      setBusy(false);
      fail(error);
    });
  };
  const rows = [];
  if (!snap.driven) {
    rows.push(
      <div key="ro" className="flex items-center gap-2.5 text-muted-foreground">
        <span className={cn(dot, "bg-faint")} />
        <span>Лише перегляд — кімнату веде інший процес agoryx{snap.lockedBy ? ` (${snap.lockedBy})` : ""}.</span>
      </div>,
    );
  } else if (run?.status === "active") {
    rows.push(
      <div key="run" className="flex items-center gap-2.5">
        <span className={cn(dot, "animate-breathe bg-primary")} />
        <span className="min-w-0 flex-1 truncate">
          {working.length ? `${working.join(" і ")} ${working.length > 1 ? "працюють" : "працює"}` : "Розмова триває"}
          <span className="tabular text-faint"> · хід {run.used} з {run.budget}</span>
        </span>
        <Button size="sm" variant="ghost" className="h-7 text-destructive hover:bg-destructive-soft hover:text-destructive" disabled={busy} onClick={() => act("/stop")}>
          <SquareIcon className="size-3 fill-current" />
          Зупинити
        </Button>
      </div>,
    );
  } else if (run?.endReason === "budget" || run?.endReason === "stopped") {
    rows.push(
      <div key="wait" className="flex items-center gap-2.5">
        <span className={cn(dot, "bg-amber")} />
        <span className="min-w-0 flex-1">
          {run.endReason === "budget"
            ? `Агенти зробили ${plural(run.used, "хід", "ходи", "ходів")} і чекають на вас. Напишіть або дайте їм продовжити.`
            : "Розмову зупинено."}
        </span>
        <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => act("/continue")}>
          <PlayIcon className="size-3 fill-current" />
          Продовжити
        </Button>
      </div>,
    );
  }
  for (const a of native) {
    const tone = participant(st, a.id).tone;
    rows.push(
      <div key={`n-${a.id}`} className="flex items-center gap-2.5 text-muted-foreground">
        <span className={cn(dot, "animate-breathe", tone === "codex" ? "bg-codex" : "bg-claude")} />
        <span>З {a.label} зараз говорять напряму, у власній сесії — хід у кімнаті почнеться після цього.</span>
      </div>,
    );
  }
  if (!rows.length) return null;
  return <div className="mx-auto flex w-full max-w-[860px] flex-col gap-1.5 px-4 pb-2 text-[13px] sm:px-8">{rows}</div>;
}

export const autosize = (ta: HTMLTextAreaElement | null, max = 0.4) => {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * max))}px`;
};

export function Composer() {
  const room = useStore((s) => s.snap?.state);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const post = useStore((s) => s.post);
  const roomId = room?.id;
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!roomId) return;
    setText(local.get(`draft.${roomId}`) ?? "");
    if (window.matchMedia("(pointer: fine)").matches) setTimeout(() => ta.current?.focus(), 30);
  }, [roomId]);
  useLayoutEffect(() => autosize(ta.current), [text]);

  if (!room) return null;
  const change = (value: string) => {
    setText(value);
    local.set(`draft.${room.id}`, value || null);
  };
  const send = async () => {
    const body = text.trim();
    if (!body || !driven || sending) return;
    setSending(true);
    try {
      await post("/messages", { text: body });
      change("");
    } catch (error) {
      fail(error);
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const mention = (who: string) => {
    const el = ta.current;
    const tag = `@${who} `;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const pad = before && !/\s$/.test(before) ? " " : "";
    change(`${before}${pad}${tag}${text.slice(end)}`);
    const pos = before.length + pad.length + tag.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };
  const names = room.agents.map((a) => a.label).join(" і ");

  return (
    <div className="mx-auto w-full max-w-[860px] px-3 pb-3 sm:px-8 sm:pb-5">
      <form
        className={cn(
          "group/composer rounded-[20px] border border-input bg-card shadow-soft transition focus-within:border-ring/60 focus-within:shadow-lift",
          !driven && "opacity-60",
        )}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={!driven}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKey}
          placeholder={driven ? `Напишіть ${names}…` : "Кімнату веде інший процес — лише перегляд"}
          aria-label="Повідомлення"
          className="scroll-thin block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
          {room.agents.map((a) => {
            const tone = participant(room, a.id).tone;
            return (
              <button
                key={a.id}
                type="button"
                disabled={!driven}
                onClick={() => mention(a.id)}
                title={`Звернутися лише до ${a.label}`}
                className={cn(
                  "h-7 rounded-full px-2.5 font-mono text-[12px] font-medium transition disabled:pointer-events-none",
                  tone === "codex" ? "text-codex hover:bg-codex-soft" : "text-claude hover:bg-claude-soft",
                )}
              >
                @{a.id}
              </button>
            );
          })}
          <span className="ml-auto hidden items-center gap-1 text-[11.5px] text-faint sm:flex">
            <Kbd>Enter</Kbd> надіслати · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> новий рядок
          </span>
          <Button type="submit" size="icon" className="ml-auto size-8 rounded-full sm:ml-2" disabled={!driven || sending || !text.trim()} aria-label="Надіслати" title="Надіслати (Enter)">
            <ArrowUpIcon className="size-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}
