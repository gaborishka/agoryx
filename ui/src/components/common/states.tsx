import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The page's waiting, empty and error states, one look everywhere: panels, dialogs, the table.
 */

/** A heading line and a few text lines; `block` adds a tall block (a file or a diff on its way). */
export function Loading({ lines = 3, block = false, className }: { lines?: number; block?: boolean; className?: string }) {
  const widths = ["w-full", "w-5/6", "w-2/3", "w-4/5"];
  return (
    <div role="status" aria-label="Завантаження" className={cn("flex flex-col gap-2.5", className)}>
      <Skeleton className="h-4 w-2/5 max-w-48" />
      {block ? <Skeleton className="h-40 w-full" /> : widths.slice(0, lines).map((w) => <Skeleton key={w} className={cn("h-3.5", w)} />)}
    </div>
  );
}

/** Something failed to load: said once, in the room's error colour. */
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn("rounded-xl bg-destructive-soft px-3.5 py-3 text-small text-destructive", className)}>
      {children}
    </div>
  );
}

/** A quiet explanatory line under a control or in place of content. */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-small leading-relaxed text-muted-foreground", className)}>{children}</p>;
}

/** Nothing here yet: an icon, an optional title, what will appear and when, and optional actions below. */
export function EmptyState({
  icon: Icon,
  title,
  text,
  children,
  large = false,
  className,
}: {
  icon: LucideIcon;
  title?: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
  /** The whole view is empty (the table), not a panel. */
  large?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto flex flex-col items-center text-center", large ? "max-w-2xl gap-5 px-4 py-16" : "gap-4 px-6 py-14", className)}>
      <span className={cn("grid place-items-center rounded-2xl bg-secondary text-primary", large ? "size-14 shadow-soft" : "size-11")}>
        <Icon className={large ? "size-6" : "size-5"} />
      </span>
      {title || text ? (
        <div className="flex flex-col items-center gap-2">
          {title ? <h2 className={cn("font-semibold", large ? "font-serif text-display tracking-tight" : "text-lead")}>{title}</h2> : null}
          {text ? (
            <p className={cn("leading-relaxed text-pretty text-muted-foreground", large ? "max-w-[52ch] text-body" : "max-w-[44ch] text-ui")}>{text}</p>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
