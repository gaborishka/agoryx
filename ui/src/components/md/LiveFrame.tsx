import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The room's tokens a live page can style against, as --agoryx-<name>. The daemon's frame script applies them
 * (and data-theme="dark|light" on <html>), so an agent's chart or mockup can match the room in both themes.
 */
const TOKENS = ["background", "foreground", "card", "muted", "muted-foreground", "border", "primary", "primary-foreground", "human", "amber", "destructive", "code", "viz-1", "viz-2", "viz-3", "viz-4", "viz-5", "viz-6"];

const frameTheme = (dark: boolean) => {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (value) vars[`--agoryx-${name}`] = value;
  }
  vars["--agoryx-font"] = '"Instrument Sans Variable", system-ui, sans-serif';
  vars["--agoryx-mono"] = '"JetBrains Mono Variable", ui-monospace, monospace';
  return { dark, vars };
};

/** A sandboxed page (workspace html/pdf, or an ```html block) that grows to its content's height. */
export function LiveFrame({ src, title, className, initial = 360, max = 1400 }: { src: string; title: string; className?: string; initial?: number; max?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initial);
  const dark = useTheme((s) => s.dark);
  // The theme travels in the URL's fragment so the first paint has it; the page itself is the same document.
  // Only html pages read it: a pdf viewer would take the fragment as its own parameters.
  // The frame keeps its first URL (a new one would reload the page); later themes are posted to it.
  const url = useMemo(() => (/\.pdf($|[?#])/i.test(src) ? src : `${src}#agoryx-theme=${encodeURIComponent(JSON.stringify(frameTheme(dark)))}`), [src]);
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
  useEffect(() => {
    // After the class flip has repainted the tokens.
    const id = requestAnimationFrame(() => ref.current?.contentWindow?.postMessage({ agoryxTheme: frameTheme(dark) }, "*"));
    return () => cancelAnimationFrame(id);
  }, [dark]);
  return (
    <iframe
      ref={ref}
      src={url}
      title={title}
      loading="lazy"
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      referrerPolicy="no-referrer"
      className={cn("block w-full border-0 bg-white", className)}
      style={{ height }}
    />
  );
}
