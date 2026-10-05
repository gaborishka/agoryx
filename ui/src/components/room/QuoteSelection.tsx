import { GitBranchIcon, QuoteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "@/components/ui/kbd";
import { clipQuote, type Quote, quoteAddressee } from "@/lib/quote";
import { participant } from "@/lib/room";
import { useStore } from "@/lib/store";

/** The message a node sits in, when it is quotable text (`data-quote` on the message's words). */
const hostOf = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-quote]") ?? null;

/** The part of the screen a message is seen through: its scrolling feed, or the window. */
function viewOf(el: HTMLElement): { top: number; bottom: number } {
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) {
      const box = at.getBoundingClientRect();
      return { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, window.innerHeight) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}
const BUTTON = 36;

/**
 * Select words in a message and a «Quote» button appears under them: it puts the passage above the
 * composer, with the message it came from; «To thread» puts it into a thread's steer box instead, when the room has
 * threads. A selection across two messages quotes nothing.
 */
export function QuoteSelection() {
  const room = useStore((s) => s.snap?.state);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const quote = useStore((s) => s.quote);
  const steerQuote = useStore((s) => s.steerQuote);
  // A passage can go to one of this room's threads too: into its steer box, for the human to send.
  const threaded = useStore((s) => Boolean(s.snap && s.rooms.some((room) => room.parent === s.snap?.state.id)));
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
      // Scrolled out of sight, the selection has no button: Q then quotes nothing unseen.
      const view = viewOf(host);
      if (rect.bottom < view.top || rect.top > view.bottom) return setShown(null);
      const p = participant(roomRef.current, author);
      // Under the selection, where the message's author and time never are; over it only when there is no room below.
      const below = rect.bottom + 8 + BUTTON <= view.bottom || rect.top - 8 - BUTTON < view.top;
      setShown({
        quote: { id, author, label: p.agent ? p.label : author, text },
        x: Math.min(Math.max(rect.left + rect.width / 2, 60), window.innerWidth - 60),
        y: below ? Math.min(rect.bottom + 8, view.bottom - BUTTON) : rect.top - 8,
        below,
      });
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    // Shown once the selection is made (not while the mouse still drags it); gone the moment it collapses.
    // A finger ends a long press with pointercancel and moves the handles with no pointer events at all,
    // so on touch the button comes once the selection rests.
    let touch = false;
    let rest = 0;
    const onDown = (event: PointerEvent) => {
      touch = event.pointerType !== "mouse";
    };
    const onChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) setShown(null);
      if (!touch) return;
      clearTimeout(rest);
      rest = window.setTimeout(later, 300);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key === "Shift") later();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", later);
    document.addEventListener("pointercancel", later);
    document.addEventListener("keyup", onKey);
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("scroll", later, true);
    window.addEventListener("resize", later);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(rest);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", later);
      document.removeEventListener("pointercancel", later);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("scroll", later, true);
      window.removeEventListener("resize", later);
    };
  }, [driven]);

  const take = (q: Quote) => {
    // As lines of a diff do: to the agent who wrote them, unless the draft already names someone.
    quote(q, quoteAddressee(q, roomRef.current?.agents.map((a) => a.id) ?? []));
    document.getSelection()?.removeAllRanges();
    setShown(null);
  };
  const toThread = (q: Quote) => {
    steerQuote(q);
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
  const pill = "flex items-center gap-1.5 rounded-full border border-border bg-popover py-1 text-small font-medium text-popover-foreground shadow-lift transition hover:bg-accent";
  return createPortal(
    <div style={{ left: shown.x, top: shown.y }} className={`fixed z-50 flex -translate-x-1/2 items-center gap-1 ${shown.below ? "" : "-translate-y-full"}`}>
      <button
        type="button"
        // Keep the selection: a mousedown on the button would collapse it before the click.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => take(shown.quote)}
        className={`${pill} pr-1.5 pl-2.5`}
        aria-label={`Quote ${shown.quote.label} in your message`}
      >
        <QuoteIcon className="size-3.5" />
        Quote
        <Kbd>Q</Kbd>
      </button>
      {threaded ? (
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => toThread(shown.quote)}
          className={`${pill} px-2.5`}
          title="Into a thread's steer box: you send it"
        >
          <GitBranchIcon className="size-3.5" />
          To thread
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
