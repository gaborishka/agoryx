import { ArrowDownToLineIcon, XIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { offeredUpdate, useUpdatePolling, useUpdates } from "@/lib/updates";

/** A newer Agoryx is out: one line over the app, until it is installed or "Not now" (for that version). */
export function UpdateBanner() {
  useUpdatePolling();
  const { release, current } = useUpdates(useShallow((s) => ({ release: offeredUpdate(s), current: s.status?.current ?? null })));
  const dismiss = useUpdates((s) => s.dismiss);
  if (!release) return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-primary/25 bg-primary/10 px-3 py-2 text-small sm:px-4">
      <ArrowDownToLineIcon className="size-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">Agoryx {release.version} is available.</span>{" "}
        <span className="text-muted-foreground">{current ? `You have ${current}. ` : ""}Update to get the latest fixes and features.</span>
      </p>
      <Button asChild size="sm" className="shrink-0">
        <a href={release.download ?? release.url} target="_blank" rel="noopener noreferrer">
          {release.download ? "Download update" : "Get the update"}
        </a>
      </Button>
      <Button asChild size="sm" variant="ghost" className="hidden shrink-0 sm:inline-flex">
        <a href={release.url} target="_blank" rel="noopener noreferrer">
          What’s new
        </a>
      </Button>
      <Button size="icon-sm" variant="ghost" className="shrink-0" aria-label="Not now" title="Not now: remind me at the next release" onClick={() => dismiss(release.version)}>
        <XIcon />
      </Button>
    </div>
  );
}
