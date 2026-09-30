import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { clock, fullDate } from "@/lib/format";
import { ink, nameOf, participant, type Tone, toneText } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { MessageEntry, RoomAgent } from "@/lib/types";
import { cn } from "@/lib/utils";

const toneBg: Record<Tone, string> = {
  claude: "bg-claude-soft text-claude ring-claude/25",
  codex: "bg-codex-soft text-codex ring-codex/25",
  human: "bg-human-soft text-human ring-human/25",
  sys: "bg-muted text-muted-foreground ring-border",
};

const ringTone: Record<Tone, string> = {
  claude: "before:border-claude",
  codex: "before:border-codex",
  human: "before:border-human",
  sys: "before:border-border",
};

/** Claude: a sunburst of strokes. */
const ClaudeGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" className="size-[58%]">
    <path d="M12 3v5.2M12 15.8V21M3 12h5.2M15.8 12H21M5.6 5.6l3.7 3.7M14.7 14.7l3.7 3.7M18.4 5.6l-3.7 3.7M9.3 14.7l-3.7 3.7" />
  </svg>
);

/** Codex: a prompt caret and cursor. */
const CodexGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" className="size-[58%]">
    <path d="M5 7l5 5-5 5M12.5 17H19" />
  </svg>
);

/** Agoryx: the square's colonnade. */
export const AgoraGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 9.5 12 4l9 5.5M5 10v8M9.7 10v8M14.3 10v8M19 10v8M3 20.5h18" />
  </svg>
);

/** Below this size a glyph and a corner badge do not both read: the mark takes the glyph's place (the colour still says which CLI). */
const MARK_INSIDE = 26;

/**
 * `roster`: who to look the handle up in when there is no room yet (the start screen).
 * An agent that shares its kind with another gets its own shade of the kind's colour and its mark
 * (a corner badge, or in place of the glyph on a small avatar); one alone of its kind looks as it always has.
 */
export function Avatar({
  handle,
  roster,
  size = 28,
  live = false,
  className,
}: {
  handle: string;
  roster?: RoomAgent[];
  size?: number;
  live?: boolean;
  className?: string;
}) {
  const room = useStore((s) => s.snap?.state);
  const p = participant(roster ? { agents: roster } : room, handle);
  const inside = Boolean(p.mark) && size < MARK_INSIDE;
  const badge = Math.max(12, Math.round(size * 0.46));
  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-[30%] ring-1 ring-inset",
        toneBg[p.tone],
        live && "before:absolute before:-inset-[3px] before:animate-pulse before:rounded-[34%] before:border-2",
        live && ringTone[p.tone],
        className,
      )}
      style={{ width: size, height: size, ...ink(p) }}
      aria-hidden
    >
      {inside ? (
        <span className="font-bold leading-none" style={{ fontSize: size * 0.5 }}>
          {p.mark}
        </span>
      ) : p.kind === "claude" ? (
        <ClaudeGlyph />
      ) : p.kind === "codex" ? (
        <CodexGlyph />
      ) : p.tone === "sys" ? (
        <AgoraGlyph className="size-[58%]" />
      ) : (
        <span className="font-semibold" style={{ fontSize: size * 0.44 }}>
          {(handle[0] ?? "?").toUpperCase()}
        </span>
      )}
      {p.mark && !inside ? (
        <span
          className={cn(
            "absolute -right-1 -bottom-1 grid place-items-center rounded-full font-bold leading-none text-background ring-2 ring-background",
            p.kind === "codex" ? "bg-codex" : "bg-claude",
          )}
          style={{ width: badge, height: badge, fontSize: Math.round(badge * 0.66) }}
        >
          {p.mark}
        </span>
      ) : null}
    </span>
  );
}

export function Name({ handle, className }: { handle: string; className?: string }) {
  const room = useStore((s) => s.snap?.state);
  const p = participant(room, handle);
  return (
    <span className={cn("font-semibold", toneText[p.tone], className)} style={ink(p)}>
      {nameOf(room, handle)}
    </span>
  );
}

export function Tip({ tip, children, side }: { tip: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-72 text-pretty">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

export function Time({ iso }: { iso: string }) {
  return (
    <Tip tip={fullDate(iso)}>
      <time dateTime={iso} className="tabular text-xs text-faint">
        {clock(iso)}
      </time>
    </Tip>
  );
}

const nativeTone: Record<Tone, string> = {
  claude: "border-claude/30 text-claude",
  codex: "border-codex/30 text-codex",
  human: "border-human/30 text-human",
  sys: "border-border text-muted-foreground",
};

export function NativeBadge({ agent, label, tip }: { agent: string; label: string; tip: string }) {
  const room = useStore((s) => s.snap?.state);
  const p = participant(room, agent);
  return (
    <Tip tip={tip}>
      <span className={cn("inline-flex h-5 items-center rounded-full border border-dashed px-2 text-micro font-medium", nativeTone[p.tone])} style={ink(p)}>
        {label}
      </span>
    </Tip>
  );
}

/** A message imported from an agent's own session (outside the room) says where it happened. */
export function NativeTag({ m }: { m: MessageEntry }) {
  const room = useStore((s) => s.snap?.state);
  if (!m.native) return null;
  const who = nameOf(room, m.native.agent);
  return (
    <NativeBadge
      agent={m.native.agent}
      label={m.author === m.native.agent ? "у своїй сесії" : `напряму в сесії ${who}`}
      tip={`Це було в рідній сесії ${who}, поза кімнатою. Agoryx підтягнув репліку сюди, щоб її бачили всі.`}
    />
  );
}

export function Stats({ added, removed, deleted, binary, isNew }: { added?: number | null; removed?: number | null; deleted?: boolean; binary?: boolean; isNew?: boolean }) {
  if (binary) return <span className="text-faint">двійковий</span>;
  if (deleted) return <span className="tabular text-del-ink">видалено{removed ? ` −${removed}` : ""}</span>;
  return (
    <span className="tabular inline-flex gap-1">
      <span className="text-add-ink">+{added ?? 0}</span>
      <span className="text-del-ink">−{removed ?? 0}</span>
      {isNew ? <span className="text-faint">новий</span> : null}
    </span>
  );
}

export function Divider({ children, title }: { children: ReactNode; title?: string }) {
  const body = (
    <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="max-w-[80%] text-center text-balance">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
  return title ? <Tip tip={title}>{body}</Tip> : body;
}
