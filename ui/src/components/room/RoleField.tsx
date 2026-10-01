import { Textarea } from "@/components/ui/textarea";
import { MAX_ROLE, ROLE_IDEAS } from "@/lib/agents";
import { cn } from "@/lib/utils";

/**
 * What the human asks an agent to be in the room, in their own words. Empty: no role — the agent acts as
 * itself. The ideas only fill the field; nothing of Agoryx's is added to it.
 */
export function RoleField({ id, value, onChange, name, className }: { id: string; value: string; onChange: (value: string) => void; name: string; className?: string }) {
  const over = value.length > MAX_ROLE;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={`Роль ${name}: що робити й чого не робити. Порожньо — без ролі, діє як сам.`}
        aria-label={`Роль ${name}`}
        aria-invalid={over || undefined}
        rows={2}
        className="max-h-48 min-h-14 text-small"
      />
      <div className="flex flex-wrap items-center gap-1">
        {ROLE_IDEAS.map((idea) => (
          <button
            key={idea.name}
            type="button"
            onClick={() => onChange(idea.text)}
            title={idea.text}
            className={cn(
              "h-6 rounded-md border px-2 text-meta transition",
              value === idea.text ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {idea.name}
          </button>
        ))}
        <span className={cn("tabular ml-auto text-micro", over ? "text-destructive" : "text-faint")}>
          {value.length > MAX_ROLE * 0.8 ? `${value.length}/${MAX_ROLE}` : ""}
        </span>
      </div>
    </div>
  );
}
