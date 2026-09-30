import { parsePatchFiles } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import type { DiffItem } from "@/lib/types";
import { cn } from "@/lib/utils";

// Syntax-highlighted files and diffs (@pierre/diffs, Shiki with the JS regex
// engine — no wasm, so it runs under the daemon's CSP).

const THEMES = { light: "vitesse-light", dark: "vitesse-dark" } as const;

const useBase = () => {
  const dark = useTheme((t) => t.dark);
  return {
    theme: THEMES,
    themeType: dark ? ("dark" as const) : ("light" as const),
    preferredHighlighter: "shiki-js" as const,
    overflow: "wrap" as const,
  };
};

export function CodeFile({ name, text, className }: { name: string; text: string; className?: string }) {
  const base = useBase();
  return (
    <div className={cn("diffs-host overflow-hidden rounded-xl border border-border bg-code", className)}>
      <File file={{ name, contents: text }} options={{ ...base, disableFileHeader: true }} />
    </div>
  );
}

/** A git patch (one or many files), each file with its own header. */
export function Patch({ patch, focus, className }: { patch: string; focus?: string; className?: string }) {
  const base = useBase();
  const files = useMemo(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [patch]);
  if (!files.length) {
    return <pre className={cn("scroll-thin overflow-auto rounded-xl border border-border bg-code p-3 font-mono text-meta", className)}>{patch}</pre>;
  }
  const ordered = focus ? [...files.filter((f) => f.name === focus), ...files.filter((f) => f.name !== focus)] : files;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {ordered.map((f) => (
        <div key={`${f.prevName ?? ""}>${f.name}`} className="diffs-host overflow-hidden rounded-xl border border-border bg-code">
          <FileDiff fileDiff={f} options={{ ...base, diffStyle: "unified", hunkSeparators: "line-info", lineDiffType: "word" }} />
        </div>
      ))}
    </div>
  );
}

/** The doc-revision diff the daemon computes (context lines + skips). */
export function DocDiff({ items }: { items: DiffItem[] }) {
  let oldN = 1;
  let newN = 1;
  const rows = items.map((item, index) => {
    if ("skip" in item) {
      oldN += item.skip;
      newN += item.skip;
      return (
        <tr key={index} className="bg-muted/60 text-faint">
          <td className="w-10 select-none px-2 text-right" />
          <td className="px-3 py-1 font-sans text-meta">… {plural(item.skip, "рядок", "рядки", "рядків")} без змін</td>
        </tr>
      );
    }
    const n = item.t === "-" ? oldN++ : newN++;
    if (item.t === " ") oldN += 1;
    return (
      <tr key={index} className={cn(item.t === "+" && "bg-add text-add-ink", item.t === "-" && "bg-del text-del-ink")}>
        <td className="w-10 select-none px-2 text-right align-top text-faint">{n}</td>
        <td className="px-3 whitespace-pre-wrap break-words">
          <span className="mr-2 inline-block w-2 select-none opacity-70">{item.t === " " ? "" : item.t === "-" ? "−" : "+"}</span>
          {item.s || " "}
        </td>
      </tr>
    );
  });
  return (
    <div className="scroll-thin overflow-auto rounded-xl border border-border bg-code">
      <table className="w-full border-collapse font-mono text-small leading-[1.6]">
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
