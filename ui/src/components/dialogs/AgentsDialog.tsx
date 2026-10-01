import { PlusIcon, UserMinusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Hint } from "@/components/common/states";
import { fail, Shell } from "@/components/dialogs/Dialogs";
import { Avatar } from "@/components/room/bits";
import { ModelMenu } from "@/components/room/ModelMenu";
import { RoleField } from "@/components/room/RoleField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { handleFor, KIND_NAME, MAX_ROLE, nameFor } from "@/lib/agents";
import { useModels } from "@/lib/models";
import { useStore } from "@/lib/store";
import type { AgentKind, AgentModels, RoomAgent, RoomState } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Who sits in this room, changed while it runs: seat another agent, send one out, give each a role, a name,
 * a model. The room is told of every change; an agent seated now reads the conversation on its first turn
 * and answers from the next message on.
 */
export function AgentsDialog({ focus }: { focus?: string }) {
  const room = useStore((s) => s.snap?.state);
  const presence = useStore((s) => s.snap?.presence);
  const driven = useStore((s) => s.snap?.driven ?? false);
  const models = useModels();
  if (!room) return null;
  return (
    <Shell
      title="The room's agents"
      sub={room.name}
      // Not into the first name field, where a keystroke would rename the agent: to the role of the agent asked for, or nowhere.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        // After the menu that opened this has handed focus back to its button.
        if (focus) setTimeout(() => document.getElementById(`role-${focus}`)?.focus(), 0);
      }}
    >
      <Hint>
        A change here applies from the agent's next turn, and the room is told about it. A role is your words to the agent: what it should do in this room.
      </Hint>
      <div className="flex flex-col gap-3">
        {room.agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            room={room}
            models={models}
            working={presence?.[agent.id] === "working"}
            disabled={!driven}
            alone={room.agents.length < 2}
            focused={agent.id === focus}
          />
        ))}
      </div>
      <AddAgent room={room} models={models} disabled={!driven} />
    </Shell>
  );
}

function AgentCard({
  agent,
  room,
  models,
  working,
  disabled,
  alone,
  focused,
}: {
  agent: RoomAgent;
  room: RoomState;
  models: AgentModels | null;
  working: boolean;
  disabled: boolean;
  alone: boolean;
  focused: boolean;
}) {
  const post = useStore((s) => s.post);
  const [label, setLabel] = useState(agent.label);
  const [role, setRole] = useState(agent.role ?? "");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Changed elsewhere (another tab, the phone): the fields follow unless they are being edited.
  const [seen, setSeen] = useState({ label: agent.label, role: agent.role ?? "" });
  if (seen.label !== agent.label || seen.role !== (agent.role ?? "")) {
    if (label === seen.label) setLabel(agent.label);
    if (role === seen.role) setRole(agent.role ?? "");
    setSeen({ label: agent.label, role: agent.role ?? "" });
  }
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const dirty = label.trim() !== agent.label || role.trim() !== (agent.role ?? "");
  const send = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try {
      await post("/agent", { agent: agent.id, ...body });
      if (done) toast.success(done);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    void send(
      {
        ...(label.trim() !== agent.label ? { label: label.trim() } : {}),
        ...(role.trim() !== (agent.role ?? "") ? { role: role.trim() || null } : {}),
      },
      "Saved",
    );
  const remove = async () => {
    setBusy(true);
    try {
      await post("/agent-remove", { agent: agent.id });
      toast.success(`${agent.label} left the room`);
    } catch (error) {
      fail(error);
      setBusy(false);
      setLeaving(false);
    }
  };
  return (
    <div ref={ref} className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5", focused && "border-primary/40")}>
      <div className="flex items-center gap-3">
        <Avatar handle={agent.id} roster={room.agents} size={32} live={working} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium">{agent.label}</span>
          <span className="truncate text-meta text-muted-foreground">
            @{agent.id} · {KIND_NAME[agent.kind]}
            {working ? " · working" : ""}
          </span>
        </div>
        {leaving ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setLeaving(false)} disabled={busy}>
              No
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void remove()} disabled={busy}>
              {working ? "Stop and remove" : "Remove"}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            disabled={disabled || alone || busy}
            aria-label={`Remove ${agent.label} from the room`}
            title={alone ? "A room needs at least one agent" : `Remove ${agent.label} from the room`}
            onClick={() => setLeaving(true)}
          >
            <UserMinusIcon className="size-4" />
          </Button>
        )}
      </div>
      {leaving ? (
        <Hint>
          {working ? `${agent.label} is working now — its turn will be stopped. ` : ""}
          Its messages stay in the room. You can bring it back any time as the same @{agent.id}: it continues its own session.
        </Hint>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={40}
          aria-label={`Name of ${agent.label}`}
          disabled={disabled}
          className="h-8 w-full text-small sm:w-44"
        />
        <ModelMenu
          agent={agent}
          seating={room}
          models={models}
          side="bottom"
          align="start"
          variant="field"
          disabled={disabled}
          working={working}
          onSet={(change) => void send(change)}
        />
        <label className="ml-auto flex items-center gap-2 text-small text-muted-foreground" title="Whether this agent gets your profile">
          Profile
          <Switch checked={agent.profile !== false} disabled={disabled || busy} onCheckedChange={(on) => void send({ profile: on })} aria-label={`Profile for ${agent.label}`} />
        </label>
      </div>
      <RoleField id={`role-${agent.id}`} value={role} onChange={setRole} name={agent.label} />
      {dirty ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLabel(agent.label);
              setRole(agent.role ?? "");
            }}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={disabled || busy || !label.trim() || role.length > MAX_ROLE}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AddAgent({ room, models, disabled }: { room: RoomState; models: AgentModels | null; disabled: boolean }) {
  const post = useStore((s) => s.post);
  const [kind, setKind] = useState<AgentKind>("claude");
  const [model, setModel] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  // An agent that left can come back under its handle (its session goes on); one of another CLI cannot take it.
  const back = room.former?.find((agent) => agent.kind === kind && !model && !room.agents.some((a) => a.id === agent.id));
  const taken = (room.former ?? []).filter((agent) => agent.kind !== kind).map((agent) => agent.id);
  const name = back ? back.label : nameFor(kind, model || undefined, models, room.agents, taken);
  // Coming back, it keeps the role it had unless another is written here.
  const kept = back?.role && !role.trim() ? back.role : undefined;
  const add = async () => {
    setBusy(true);
    try {
      await post("/agents", {
        agent: {
          kind,
          id: back ? back.id : handleFor(name),
          label: name,
          ...(model ? { model } : back?.model ? { model: back.model } : {}),
          ...(role.trim() ? { role: role.trim() } : kept ? { role: kept } : {}),
        },
      });
      toast.success(`${name} is in the room`);
      setModel("");
      setRole("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2.5 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <Label>Add an agent</Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={kind}
          onValueChange={(value) => {
            setKind(value as AgentKind);
            setModel("");
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Which CLI">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude Code</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
        <Select value={model || "default"} onValueChange={(value) => setModel(value === "default" ? "" : value)}>
          <SelectTrigger className="w-full sm:flex-1" aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">The CLI's default model</SelectItem>
            {(models?.[kind]?.models ?? []).map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <RoleField id="role-new" value={role} onChange={setRole} name={name} />
      <div className="flex items-center gap-3">
        <Hint className="min-w-0 flex-1">
          {back
            ? `${name} (@${back.id}) comes back and continues its session where it left off${kept ? ", with the same role" : ""}.`
            : `“${name}” (@${handleFor(name)}) takes a seat. It reads the conversation and answers from the next message.`}
        </Hint>
        <Button type="submit" variant="outline" className="shrink-0 gap-1.5" disabled={disabled || busy || role.length > MAX_ROLE}>
          <PlusIcon className="size-4" />
          Add
        </Button>
      </div>
    </form>
  );
}
