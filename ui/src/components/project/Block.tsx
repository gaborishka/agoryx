import type { ReactNode } from "react";

/** A section of a project's page: its name, a count beside it (a string `aside`), or controls at its right (any other). */
export function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const count = typeof aside === "string" || typeof aside === "number";
  return (
    <section className="@container flex flex-col gap-3">
      <header className="flex min-h-7 items-center gap-2">
        <h2 className="text-ui font-semibold tracking-[-0.005em]">{title}</h2>
        {count ? <span className="tabular rounded-full bg-muted px-1.5 py-px text-micro font-medium text-muted-foreground">{aside}</span> : null}
        {aside && !count ? <div className="ml-auto flex items-center gap-1 text-meta text-faint">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Rows of one kind in one box, a hairline between them: rooms, threads, library files. */
export const listBox = "flex flex-col divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-card";

/** A row in a `listBox` that opens something. */
export const listRow = "flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-foreground/[0.025] focus-visible:bg-foreground/[0.04] focus-visible:outline-none";
