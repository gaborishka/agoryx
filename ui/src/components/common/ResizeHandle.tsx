import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** The window's width, followed as it changes: how wide a column may be depends on it. */
export function useViewportWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const follow = () => setWidth(window.innerWidth);
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, []);
  return width;
}

/** The room list's width: dragged by hand, or as designed. */
export const NAV = { min: 220, max: 420, base: 272 };
export const navWidthOf = (width: number | null) => Math.min(NAV.max, Math.max(NAV.min, width ?? NAV.base));
/** The docked panel's narrowest, and what the conversation keeps beside it; with less room the panel slides over it. */
export const PANEL_MIN = 360;
export const ROOM_MIN = 520;
/** The room's browser is laid out 1280 px wide and scaled in: docked it is as wide as it can be, up to this, not dragged. */
export const browserWidth = (viewport: number) => Math.round(Math.min(760, viewport * 0.52));

/**
 * The edge between two columns, dragged to change one column's width. `grows` is the side
 * the resized column is on: "left" for the room list (drag right, it widens), "right" for the side panel.
 * Arrows move it by 16 px (Shift: 64), Home and End go to the limits, a double click or Enter resets.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  grows,
  onChange,
  onReset,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  grows: "left" | "right";
  onChange: (width: number) => void;
  onReset: () => void;
  className?: string;
}) {
  const drag = useRef<{ x: number; from: number } | null>(null);
  const clamp = (width: number) => Math.round(Math.min(max, Math.max(min, width)));
  const sign = grows === "left" ? 1 : -1;
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, from: value };
    document.body.classList.add("select-none", "cursor-col-resize");
    // Columns follow the pointer at once, without their eased width (see `in-data-resizing:transition-none`).
    document.body.dataset.resizing = "";
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onChange(clamp(drag.current.from + sign * (event.clientX - drag.current.x)));
  };
  const up = () => {
    drag.current = null;
    document.body.classList.remove("select-none", "cursor-col-resize");
    delete document.body.dataset.resizing;
  };
  // Gone mid-drag (the panel closed, the room changed): the page is not left unselectable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => up, []);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = value + sign * step;
    else if (event.key === "ArrowLeft") next = value - sign * step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") {
      event.preventDefault();
      onReset();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} — drag, or arrows; double-click resets`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={onReset}
      onKeyDown={keys}
      className={cn(
        "group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none",
        grows === "left" ? "-right-1" : "-left-1",
        className,
      )}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition group-hover:w-0.5 group-hover:bg-primary/40 group-focus-visible:w-0.5 group-focus-visible:bg-primary group-active:bg-primary/60" />
    </div>
  );
}
