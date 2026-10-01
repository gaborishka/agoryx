import { useId } from "react";
import { cn } from "@/lib/utils";

/*
 * The Agoryx mark: an A made of two voices. Claude's clay leg and Codex's water leg lean on each other
 * and cross at the top — the crossing is the shared context, drawn in --meet. The human is the dot
 * the two legs stand around: the crossbar, the moderator, the one who holds the room together.
 * Geometry lives here once; the favicon and the app icons (scripts/make-icons.mjs) copy these paths.
 */
export const MARK_LEFT = "M3.4 21 L8 21 L15.2 3 L10.6 3 Z";
export const MARK_RIGHT = "M20.6 21 L16 21 L8.8 3 L13.4 3 Z";
export const MARK_DOT = { cx: 12, cy: 16.5, r: 1.5 };

/** The full-colour mark, in the theme's voice colours. */
export function Mark({ className, title }: { className?: string; title?: string }) {
  const clip = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-6 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <clipPath id={clip}>
          <path d={MARK_LEFT} />
        </clipPath>
      </defs>
      <path d={MARK_LEFT} fill="var(--claude-0)" />
      <path d={MARK_RIGHT} fill="var(--codex-0)" />
      <path d={MARK_RIGHT} fill="var(--meet)" clipPath={`url(#${clip})`} />
      <circle {...MARK_DOT} fill="var(--human)" />
    </svg>
  );
}

/** One colour (currentColor): for small places and states where the voices' colours would say too much. */
export function MarkMono({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={cn("size-4 shrink-0", className)} aria-hidden>
      <path d={MARK_LEFT} />
      <path d={MARK_RIGHT} />
      <circle {...MARK_DOT} />
    </svg>
  );
}

/** The wordmark: the mark and "agoryx" in Commissioner's flared display cut. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display text-[19px] font-[650] leading-none", className)}>
      <Mark className="size-[1.25em]" />
      <span className="-translate-y-[0.04em]">agoryx</span>
    </span>
  );
}
