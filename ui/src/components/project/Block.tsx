import type { ReactNode } from "react";

export function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="@container flex flex-col gap-3">
      <header className="flex items-baseline gap-3">
        <h2 className="font-display text-lead font-semibold">{title}</h2>
        {aside ? <span className="text-meta text-faint">{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}
