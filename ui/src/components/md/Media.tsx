import { useEffect, useMemo, useState } from "react";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Enough of a CSV to show; a huge one is cut at a line. */
const MAX_TEXT = 512 * 1024;

/** A workspace file's text, fetched once per url. */
export function useRawText(url: string | null) {
  const [state, setState] = useState<{ url: string | null; text?: string; cut?: boolean; error?: string }>({ url: null });
  useEffect(() => {
    if (!url) return;
    let live = true;
    setState({ url });
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 413 ? "file is too large to preview" : res.status === 404 ? "the file is gone" : `couldn’t open (${res.status})`);
        const text = await res.text();
        const cut = text.length > MAX_TEXT;
        if (live) setState({ url, text: cut ? text.slice(0, text.lastIndexOf("\n", MAX_TEXT)) : text, cut });
      })
      .catch((error: unknown) => live && setState({ url, error: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
    };
  }, [url]);
  return state.url === url ? state : { url };
}

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes. */
export const parseDelimited = (text: string, sep: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
};

const NUMBER = /^[-+]?(\d[\d\s,]*)?\.?\d+(e[-+]?\d+)?%?$/i;

/** A CSV/TSV as a table: sticky header, numbers right-aligned, the first rows only. */
export function DataTable({ text, sep, cut, limit = 200, className }: { text: string; sep: string; cut?: boolean; limit?: number; className?: string }) {
  const rows = useMemo(() => parseDelimited(text, sep), [text, sep]);
  const [head = [], ...body] = rows;
  const width = Math.max(head.length, ...body.slice(0, limit).map((r) => r.length));
  const numeric = useMemo(
    () =>
      Array.from({ length: width }, (_, col) => {
        const cells = body.slice(0, 50).map((r) => r[col]?.trim() ?? "").filter(Boolean);
        return cells.length > 0 && cells.every((cell) => NUMBER.test(cell));
      }),
    [body, width],
  );
  if (!rows.length) return <p className="text-small text-muted-foreground">Empty table.</p>;
  const shown = body.slice(0, limit);
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full border-collapse text-small">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              {Array.from({ length: width }, (_, col) => (
                <th key={col} className={cn("border-b border-border px-2.5 py-1.5 text-left font-semibold whitespace-nowrap", numeric[col] && "text-right")}>
                  {head[col] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular">
            {shown.map((row, r) => (
              <tr key={r} className="odd:bg-background/40 hover:bg-accent/60">
                {Array.from({ length: width }, (_, col) => (
                  <td key={col} className={cn("max-w-[320px] border-b border-border/60 px-2.5 py-1 align-top", numeric[col] ? "text-right whitespace-nowrap" : "break-words")}>
                    {row[col] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-2.5 py-1.5 text-meta text-muted-foreground tabular">
        {plural(body.length, "row", "rows")}
        {cut ? "+" : ""} · {plural(width, "column", "columns")}
        {body.length > limit || cut ? ` · showing the first ${limit}` : ""}
      </div>
    </div>
  );
}

/** A workspace CSV/TSV, fetched and shown as a table. */
export function CsvFile({ url, name, className }: { url: string; name: string; className?: string }) {
  const file = useRawText(url);
  if (file.error) return <p className="text-small text-destructive">{file.error}</p>;
  if (file.text === undefined) return <div className={cn("h-24 animate-pulse rounded-xl bg-muted", className)} />;
  return <DataTable text={file.text} sep={name.toLowerCase().endsWith(".tsv") ? "\t" : ","} cut={file.cut} className={className} />;
}

export function Player({ url, kind, title, className, onError }: { url: string; kind: "video" | "audio"; title: string; className?: string; onError?: () => void }) {
  return kind === "video" ? (
    <video src={url} controls preload="metadata" playsInline title={title} onError={onError} className={cn("max-h-[520px] max-w-full rounded-lg border border-border bg-black", className)} />
  ) : (
    <audio src={url} controls preload="metadata" title={title} onError={onError} className={cn("w-full max-w-[520px]", className)} />
  );
}
