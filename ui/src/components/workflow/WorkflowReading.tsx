import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Long prose has an explicit way to open it; the page keeps one scrolling surface. */
export function WorkflowReading({
  children,
  collapsedHeight = 280,
  label = "Read full answer",
}: {
  children: ReactNode;
  collapsedHeight?: number;
  label?: string;
}) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setOverflow(node.scrollHeight > collapsedHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [collapsedHeight]);
  const collapsed = overflow && !expanded;
  return (
    <div className="min-w-0">
      <div
        id={id}
        className={collapsed ? "relative overflow-hidden" : "relative"}
        style={collapsed ? { maxHeight: collapsedHeight } : undefined}
      >
        <div ref={content} className="min-w-0" onFocusCapture={() => { if (collapsed) setExpanded(true); }}>
          {children}
        </div>
        {collapsed ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card via-card/90 to-transparent"
          />
        ) : null}
      </div>
      {overflow ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
          className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-small font-medium text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <ChevronUpIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
          {expanded ? "Show less" : label}
        </button>
      ) : null}
    </div>
  );
}
