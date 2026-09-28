import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Long text folded to a readable height, with a fade and a control to read the rest.
 * `fade` names the surface behind it, so the fade blends into the card and not a guess.
 */
export function Clamp({
  children,
  max,
  fade = "from-card",
  more = "Читати повністю",
  className,
  open: forced,
}: {
  children: ReactNode;
  /** Folded height in px. */
  max: number;
  fade?: string;
  more?: string;
  className?: string;
  /** Show it all, without the control. */
  open?: boolean;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const measure = () => setLong(node.scrollHeight > max + 48);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [max]);
  const folded = long && !open && !forced;
  return (
    <div className={cn("relative", className)}>
      <div ref={inner} className={cn(folded && "overflow-hidden")} style={folded ? { maxHeight: max } : undefined}>
        {children}
      </div>
      {folded ? <div className={cn("pointer-events-none absolute inset-x-0 bottom-9 h-20 bg-gradient-to-t to-transparent", fade)} /> : null}
      {long && !forced ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-primary transition hover:bg-accent"
        >
          {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          {open ? "Згорнути" : more}
        </button>
      ) : null}
    </div>
  );
}
