import { cn } from "@/lib/utils";

/*
 * The Agoryx mark: one square cut into two L-shaped halves that face each other, two voices meeting
 * in one place. The second half is the first turned 180° about the centre. Both are ink (--meet),
 * the same ink a settled decision is printed on.
 * Geometry lives here once; the favicon and the app icons (scripts/make-icons.mjs) copy these paths.
 */
export const MARK_HALF_A = "M2.5 2.5 H6.525 L10.525 6.5 H7 V17.5 H11 L15 21.5 H2.5 Z";
export const MARK_HALF_B = "M21.5 21.5 H17.475 L13.475 17.5 H17 V6.5 H13 L9 2.5 H21.5 Z";

/** The mark in the room's ink (--meet). */
export function Mark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="var(--meet)"
      className={cn("size-6 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={MARK_HALF_A} />
      <path d={MARK_HALF_B} />
    </svg>
  );
}

/** The mark in the surrounding text colour (currentColor), for avatars and inline places. */
export function MarkMono({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={cn("size-4 shrink-0", className)} aria-hidden>
      <path d={MARK_HALF_A} />
      <path d={MARK_HALF_B} />
    </svg>
  );
}

/** The wordmark: the mark and "agoryx" in Instrument Sans at normal width. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display text-[19px] font-[650] leading-none", className)}>
      <Mark className="size-[1.1em]" />
      <span className="-translate-y-[0.04em]">agoryx</span>
    </span>
  );
}
