import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** A sandboxed page (workspace html/pdf, or an ```html block) that grows to its content's height. */
export function LiveFrame({ src, title, className, initial = 360, max = 1400 }: { src: string; title: string; className?: string; initial?: number; max?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initial);
  useLayoutEffect(() => { setHeight(initial); }, [src, initial]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      const data = event.data as { agoryxFrame?: number; h?: number };
      if (data?.agoryxFrame === 1 && typeof data.h === "number" && Number.isFinite(data.h)) setHeight(Math.max(80, Math.min(max, Math.ceil(data.h))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [max]);
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      loading="lazy"
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      referrerPolicy="no-referrer"
      className={cn("block w-full border-0 bg-white", className)}
      style={{ height }}
    />
  );
}
