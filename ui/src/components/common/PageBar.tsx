import { ChevronRightIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { NavButton } from "@/components/room/RoomHeader";
import { cn } from "@/lib/utils";

/**
 * The bar over a page that is not a room: where it is (Projects › Pelican), and what can be done there on the right.
 * The page's own title sits in its content, large; the bar stays small so the two never compete.
 */

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function PageBar({ crumbs, children, className }: { crumbs: Crumb[]; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex h-12 shrink-0 items-center gap-1.5 border-b border-border/70 bg-background/80 px-2.5 backdrop-blur sm:px-4", className)}>
      <NavButton />
      <nav aria-label="Where you are" className="flex min-w-0 flex-1 items-center gap-1 text-small">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${index}:${crumb.label}`}>
              {index ? <ChevronRightIcon className="size-3.5 shrink-0 text-faint" aria-hidden /> : null}
              {crumb.onClick && !last ? (
                <button type="button" onClick={crumb.onClick} className="shrink-0 rounded-md px-1.5 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground">
                  {crumb.label}
                </button>
              ) : (
                <span className={cn("min-w-0 truncate px-1.5 py-1", last ? "font-medium text-foreground" : "text-muted-foreground")} aria-current={last ? "page" : undefined}>
                  {crumb.label}
                </span>
              )}
            </Fragment>
          );
        })}
      </nav>
      {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
    </header>
  );
}

/** A page's own title, in its content: large, with what it is for under it. */
export function PageTitle({ title, sub, children, icon }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div className="flex min-w-0 items-start gap-3.5">
        {icon}
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="font-display text-display leading-tight font-semibold break-words">{title}</h1>
          {sub ? <div className="max-w-[68ch] text-body leading-relaxed text-muted-foreground">{sub}</div> : null}
        </div>
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
