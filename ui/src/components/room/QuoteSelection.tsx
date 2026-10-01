import { QuoteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "@/components/ui/kbd";
import { clipQuote, type Quote } from "@/lib/quote";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";

/** The message a node sits in, when it is quotable text (`data-quote` on the message's words). */
const hostOf = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-quote]") ?? null;

/**
 * Select words in a message and a «Quote» button appears over them: it puts the passage above the
 * composer, with the message it came from. A selection across two messages quotes nothing.
 */
export function QuoteSelection() {
  const room = useStore((s) => s.snap?.state);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const quote = useStore((s) => s.quote);
  const [shown, setShown] = useState<{ quote: Quote; x: number; y: number; below: boolean } | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;

  useEffect(() => {
    if (!driven) return;
    let frame = 0;
    const read = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setShown(null);
      const range = sel.getRangeAt(0);
      const host = hostOf(range.startContainer);
      if (!host || host !== hostOf(range.endContainer)) return setShown(null);
      const text = clipQuote(sel.toString());
      const id = host.dataset.quote;
      const author = host.dataset.author;
      if (!text || !id || !author) return setShown(null);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return setShown(null);
      const p = participant(roomRef.current, author);
      const below = rect.top < 56;
      setShown({
        quote: { id, author, label: p.agent ? p.label : author, text },
        x: Math.min(Math.max(rect.left + rect.width / 2, 60), window.innerWidth - 60),
        y: below ? rect.bottom + 8 : rect.top - 8,
        below,
      });
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    // Shown once the selection is made (not while the mouse still drags it); gone the moment it collapses.
    const onChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) setShown(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key === "Shift") later();
    };
    document.addEventListener("pointerup", later);
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("scroll", later, true);
    window.addEventListener("resize", later);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerup", later);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("scroll", later, true);
      window.removeEventListener("resize", later);
    };
  }, [driven]);

  const take = (q: Quote) => {
    quote(q);
    document.getSelection()?.removeAllRanges();
    setShown(null);
  };
  const current = shown?.quote;
  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "q" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      take(current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (!shown) return null;
  return createPortal(
    <button
      type="button"
      // Keep the selection: a mousedown on the button would collapse it before the click.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => take(shown.quote)}
      style={{ left: shown.x, top: shown.y }}
      className={`fixed z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover py-1 pr-1.5 pl-2.5 text-small font-medium text-popover-foreground shadow-lift transition hover:bg-accent ${shown.below ? "" : "-translate-y-full"}`}
      aria-label={`Quote ${shown.quote.label} in your message`}
    >
      <QuoteIcon className="size-3.5" />
      Quote
      <Kbd>Q</Kbd>
    </button>,
    document.body,
  );
}
