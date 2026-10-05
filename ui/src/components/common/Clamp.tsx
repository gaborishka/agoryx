import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Long text folded to a readable height, with a fade and a control to read the rest. The fade is a mask on
 * the text itself, so it blends into whatever surface the text sits on.
 */
export function Clamp({
  children,
  max,
  more = "Read more",
  className,
  open: forced,
}: {
  children: ReactNode;
  /** Folded height in px. */
  max: number;
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
      <div
        ref={inner}
        onFocusCapture={() => { if (folded) setOpen(true); }}
        className={cn(folded && "overflow-hidden")}
        style={folded ? { maxHeight: max, maskImage: `linear-gradient(to bottom, black calc(100% - ${Math.min(32, max * 0.35)}px), transparent)` } : undefined}
      >
        {children}
      </div>
      {long && !forced ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="mt-1 inline-flex h-8 items-center gap-1 rounded-lg px-2 text-small font-medium text-primary transition hover:bg-accent"
        >
          {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          {open ? "Collapse" : more}
        </button>
      ) : null}
    </div>
  );
}
