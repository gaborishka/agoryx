import { XIcon } from "lucide-react";
import { type Quote, quoteKey } from "@/lib/quote";
import { ink, participant } from "@/lib/room";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const rail = { claude: "border-claude", codex: "border-codex", human: "border-human", sys: "border-border" } as const;

/** The passages quoted into the message being written: each with its source, removable, sent on top of the text. */
export function QuoteList({ quotes, onRemove }: { quotes: Quote[]; onRemove: (quote: Quote) => void }) {
  const room = useStore((s) => s.snap?.state);
  const goToRef = useStore((s) => s.goToRef);
  const openChanges = useStore((s) => s.openChanges);
  if (!quotes.length) return null;
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-3">
      {quotes.map((q) => {
        const p = participant(room, q.author);
        return (
          <div key={quoteKey(q)} className={cn("group relative rounded-md border-l-[3px] bg-muted/50 py-1.5 pr-8 pl-2.5", rail[p.tone])} style={ink(p)}>
            <button
              type="button"
              onClick={() => (q.file ? openChanges({ scope: "turn", turn: q.id, path: q.file.path }) : goToRef(`m-${q.id}`))}
              className="text-meta font-medium text-muted-foreground hover:text-foreground"
              title={q.file ? "Show the turn's changes" : "Show the message"}
            >
              {q.label} · {q.id}
              {q.file ? (
                <>
                  {" "}
                  · <span className="font-mono">{q.file.path}</span> {q.file.lines}
                </>
              ) : null}
            </button>
            <p className={cn("line-clamp-3 text-small whitespace-pre-wrap text-foreground/85", q.file && "font-mono text-meta")}>{q.text}</p>
            <button
              type="button"
              onClick={() => onRemove(q)}
              aria-label={`Remove the quote from ${q.label}`}
              className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
