import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  // The page's frame script asks for the theme as soon as it runs; it is sent again on load (a frame that loaded
  // late, or navigated, asks anew) and on every switch. A pdf or an image has no frame script and ignores it.
  const sendTheme = () => ref.current?.contentWindow?.postMessage({ agoryxTheme: frameTheme(useTheme.getState().dark) }, "*");
  useLayoutEffect(() => { setHeight(initial); }, [src, initial]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      const data = event.data as { agoryxFrame?: number; h?: number; theme?: number };
      if (data?.agoryxFrame === 1 && data.theme === 1) sendTheme();
      if (data?.agoryxFrame === 1 && typeof data.h === "number" && Number.isFinite(data.h)) setHeight(Math.max(80, Math.min(max, Math.ceil(data.h))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [max]);
  useEffect(() => {
    // After the class flip has repainted the tokens.
    const id = requestAnimationFrame(sendTheme);
    return () => cancelAnimationFrame(id);
  }, [dark]);
  return (
    <iframe
      ref={ref}
      src={src}
      onLoad={sendTheme}
      title={title}
      loading="lazy"
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      referrerPolicy="no-referrer"
      className={cn("block w-full border-0 bg-white", className)}
      style={{ height }}
    />
  );
}
