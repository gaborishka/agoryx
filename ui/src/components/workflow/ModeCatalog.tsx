import { ArrowRightIcon } from "lucide-react";
import { WORK_MODES, isProtocolMode, type WorkMode } from "@/lib/workflow";
import { cn } from "@/lib/utils";
/** A compact contextual choice for starting another protocol inside an existing chat. */
export function ModeCatalog({
  onSelect,
  includeChat = true,
  selected,
}: {
  onSelect: (mode: WorkMode) => void;
  includeChat?: boolean;
  selected?: WorkMode;
}) {
  return (
    <div className="flex flex-col divide-y divide-border">
      {(Object.keys(WORK_MODES) as WorkMode[])
        .filter((mode) => includeChat || isProtocolMode(mode))
        .map((mode) => {
          const item = WORK_MODES[mode],
            Icon = item.icon;
          return (
            <button
              key={mode}
              type="button"
              aria-label={`Choose ${item.title}`}
              aria-pressed={selected === mode}
              onClick={() => onSelect(mode)}
              className={cn(
                "flex items-center gap-4 rounded-lg p-4 text-left hover:bg-accent",
                selected === mode && "bg-accent",
              )}
            >
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">
                  {item.title}
                </span>
                <span className="mt-1 block text-small leading-relaxed text-muted-foreground">
                  {item.eyebrow}
                </span>
              </span>
              <span className="text-meta text-faint">{item.min}+ agents</span>
              <ArrowRightIcon className="size-4 shrink-0 text-faint" />
            </button>
          );
        })}
    </div>
  );
}
