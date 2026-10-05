import { ConversationMaterials } from "./ConversationMaterials";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  FileTextIcon,
  LockKeyholeIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkflowRole } from "@agora/workflow-types";
import { ModelMenu } from "@/components/room/ModelMenu";
import { Button } from "@/components/ui/button";
import { api, roomPath } from "@/lib/api";
import {
  creationDraftKey,
  creationDrafts,
  creationProjectInput,
  useCreationDraft,
  useWorkflowDraft,
  type CreationProjectProof,
} from "@/lib/creation-draft";
import { handleFor, nameFor, rosterEntry } from "@/lib/agents";
import { useModels } from "@/lib/models";
import { DEFAULT_AGENTS } from "@/lib/room";
import { useStore } from "@/lib/store";
import type { RoomAgent } from "@/lib/types";
import { WORK_MODES, type ProtocolMode } from "@/lib/workflow";
import {
  activeWorkflow,
  useWorkflow,
  type WorkflowResponse,
} from "@/lib/workflow-state";
import { AgentStage } from "./AgentStage";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-small outline-none focus:ring-2 focus:ring-ring/15";
const ROLES: Record<ProtocolMode, WorkflowRole[]> = {
  verification: ["author", "reviewer"],
  council: ["member"],
  tournament: ["contender", "evaluator"],
  debate: ["pro", "con", "judge"],
};
const ROLE_LABEL: Record<WorkflowRole, string> = {
  author: "Author",
  reviewer: "Reviewer",
  member: "Council member",
  contender: "Prototype maker",
  evaluator: "Independent judge",
  pro: "For",
  con: "Against",
  judge: "Independent judge",
};
const defaultRole = (
  mode: ProtocolMode,
  index: number,
  _total: number,
): WorkflowRole =>
  mode === "verification"
    ? index === 0
      ? "author"
      : "reviewer"
    : mode === "council"
      ? "member"
      : mode === "tournament"
        ? index < 2
          ? "contender"
          : "evaluator"
        : index === 0
          ? "pro"
          : index === 1
            ? "con"
            : "judge";

function Materials({
  roomId,
  selected,
  onSelect,
}: {
  roomId: string;
  selected: string[];
  onSelect: (paths: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open || files) return;
    let alive = true;
    void api<{ files: string[] }>("GET", roomPath(roomId, "/tree"))
      .then((r) => {
        if (alive) setFiles(r.files);
      })
      .catch((e) => {
        if (alive) setError(String(e.message));
      });
    return () => {
      alive = false;
    };
  }, [open, roomId, files]);
  const matching =
    files?.filter((file) => file.toLowerCase().includes(query.toLowerCase())) ??
    [];
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-3 text-left text-small"
      >
        <FileTextIcon className="size-4 text-muted-foreground" />
        <span className="flex-1 font-medium">Shared input materials</span>
        <span className="text-faint">
          {selected.length
            ? `${selected.length} ${selected.length === 1 ? "file" : "files"}`
            : "Optional"}
        </span>
        <ChevronDownIcon
          className={cn("size-4 transition", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-3">
          <p className="text-meta leading-relaxed text-muted-foreground">
            Choose up to 20 text files. Everyone receives the same frozen copy;
            private work never changes these originals. Images and other binary
            files are unsupported.
          </p>
          <input
            aria-label="Find input files"
            placeholder="Find a file…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={field}
          />
          {error ? (
            <p role="alert" className="text-small text-destructive">
              {error}
            </p>
          ) : !files ? (
            <p className="text-small text-faint">Loading files…</p>
          ) : (
            <div className="scroll-thin max-h-40 overflow-y-auto">
              {matching.slice(0, 100).map((file) => (
                <label
                  key={file}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-meta hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(file)}
                    disabled={!selected.includes(file) && selected.length >= 20}
                    onChange={(e) =>
                      onSelect(
                        e.target.checked
                          ? [...selected, file]
                          : selected.filter((p) => p !== file),
                      )
                    }
                  />
                  <span className="truncate font-mono" title={file}>
                    {file}
                  </span>
                </label>
              ))}
              {matching.length > 100 ? (
                <p className="py-2 text-meta text-faint">
                  Narrow your search to see more files.
                </p>
              ) : !matching.length ? (
                <p className="py-2 text-small text-faint">No matching files.</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowSetup({
  mode,
  onStarted,
  onBack,
  creationKey,
  projectProof,
  projectError,
  controls,
}: {
  mode: ProtocolMode;
  onStarted?: () => void;
  onBack?: () => void;
  creationKey?: string;
  projectProof?: CreationProjectProof | null;
  projectError?: string | null;
  controls?: React.ReactNode;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const room = useStore((s) => s.snap?.state);
  const roomId = room?.id;
  const spec = WORK_MODES[mode];
  const draftKey = creationKey ?? creationDraftKey();
  const creation = useCreationDraft(draftKey);
  const draft = useWorkflowDraft(draftKey, mode, roomId);
  const task = roomId ? draft.task : creation.brief;
  const criteria = draft.criteria;
  const updateDraft = (patch: Partial<typeof draft>) =>
    creationDrafts.updateWorkflow(draftKey, mode, patch, roomId);
  const [availableRoster, setAvailableRoster] =
    useState<RoomAgent[]>(DEFAULT_AGENTS);
  const newSeats = creation.seats ?? DEFAULT_AGENTS;
  const roster = room?.agents ?? [
    ...newSeats,
    ...availableRoster.filter(
      (agent) => !newSeats.some((seat) => seat.id === agent.id),
    ),
  ];
  const selected = roomId
    ? (draft.selected ??
      room?.agents.slice(0, 8).map((agent) => agent.id) ??
      [])
    : newSeats.map((agent) => agent.id);
  const setSelected = (ids: string[]) => {
    if (roomId) updateDraft({ selected: ids });
    else
      creationDrafts.setSeats(
        draftKey,
        ids
          .map((id) => roster.find((agent) => agent.id === id))
          .filter((agent): agent is RoomAgent => Boolean(agent)),
      );
  };
  const setRoster = (next: RoomAgent[]) => {
    setAvailableRoster(next);
    if (!roomId)
      creationDrafts.setSeats(
        draftKey,
        next.filter((agent) => selected.includes(agent.id)),
      );
  };
  const roles = draft.roles;
  const setRoles = (roles: Record<string, WorkflowRole>) =>
    updateDraft({ roles });
  const seconds = draft.seconds;
  const setSeconds = (seconds: number) => updateDraft({ seconds });
  const chars = draft.chars;
  const setChars = (chars: number) => updateDraft({ chars });
  const rounds = draft.rounds;
  const setRounds = (rounds: number) => updateDraft({ rounds });
  const contextPaths = draft.contextPaths;
  const setContextPaths = (contextPaths: string[]) =>
    updateDraft({ contextPaths });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const models = useModels();
  const isolation = useWorkflow((s) =>
    s.roomId === roomId ? s.capabilities?.isolation : undefined,
  );
  const workflowLoading = useWorkflow((s) => s.roomId === roomId && s.loading);
  const workflowActive = useWorkflow(
    (s) => s.roomId === roomId && activeWorkflow(s.run),
  );
  useEffect(() => {
    if (roomId) return;
    let alive = true;
    void api<{ agents?: RoomAgent[]; rosterError?: string }>("GET", "/api/info")
      .then((info) => {
        if (!alive) return;
        setRosterError(info.rosterError ?? null);
        if (info.agents?.length) {
          setAvailableRoster(info.agents);
          creationDrafts.seedSeats(draftKey, info.agents);
        }
      })
      .catch((e) => {
        if (alive) setRosterError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [roomId, draftKey]);
  const participants = selected
    .map((id) => roster.find((a) => a.id === id))
    .filter((a): a is RoomAgent => Boolean(a));
  const roleOf = (agent: RoomAgent, index: number) =>
    roles[agent.id] ?? defaultRole(mode, index, participants.length);
  const unavailableProvider = participants.find(
    (agent) => isolation?.providers?.[agent.kind]?.available === false,
  );
  const providerError = unavailableProvider
    ? (isolation?.providers?.[unavailableProvider.kind]?.reason ??
      `${unavailableProvider.label} is unavailable for private work.`)
    : null;
  const assigned = participants.map(roleOf);
  const criterionLines = criteria
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const criteriaError =
    criterionLines.length > 20
      ? "Use at most 20 success criteria."
      : criterionLines.some((line) => line.length > 1000)
        ? "Each criterion can contain at most 1,000 characters."
        : new Set(criterionLines).size !== criterionLines.length
          ? "Each success criterion must be distinct."
          : null;
  const roleError =
    mode === "verification" &&
    (assigned.filter((r) => r === "author").length !== 1 ||
      !assigned.includes("reviewer"))
      ? "Choose exactly one author and at least one independent reviewer."
      : mode === "tournament" &&
          (assigned.filter((r) => r === "contender").length < 2 ||
            !assigned.includes("evaluator"))
        ? "Choose at least two prototype makers and one independent judge."
        : mode === "debate" &&
            (assigned.filter((r) => r === "pro").length !== 1 ||
              assigned.filter((r) => r === "con").length !== 1 ||
              !assigned.includes("judge"))
          ? "Choose one advocate for, one against, and at least one independent judge."
          : null;
  const changeTask = (value: string) => {
    if (roomId) updateDraft({ task: value });
    else creationDrafts.update(draftKey, { brief: value });
  };
  const addSeat = (kind: "codex" | "claude") => {
    const label = nameFor(kind, undefined, models, roster);
    const agent: RoomAgent = { id: handleFor(label), kind, label };
    setAvailableRoster([...roster, agent]);
    creationDrafts.setSeats(draftKey, [...participants, agent]);
  };
  const submit = async (event: React.FormEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (
      busy ||
      roleError ||
      criteriaError ||
      rosterError ||
      !task.trim() ||
      !criterionLines.length ||
      workflowActive ||
      participants.length < spec.min
    )
      return;
    setBusy(true);
    setError(null);
    const route = useStore.getState().route;
    const generation = useWorkflow.getState().generation;
    const originalDraft = draft;
    try {
      if (!roomId) {
        const source = creationDrafts.read(draftKey);
        const projectInput = creationProjectInput(source, projectProof);
        const prepared = await creationDrafts.prepareWorkflow(
          draftKey,
          mode,
          source,
          async () => {
            const created = await api<{ room: { id: string } }>(
              "POST",
              "/api/rooms",
              {
                ...projectInput,
                name: task.trim().split(/\r?\n/)[0]!.slice(0, 65),
                agents: participants.map(rosterEntry),
              },
            );
            return created.room.id;
          },
        );
        // The room and its complete setup draft are durable before any navigation.
        // The next screen checks isolation and lets the human select frozen project materials.
        await useStore.getState().loadRooms();
        if (
          mounted.current &&
          useStore.getState().route === route &&
          creationDrafts.read(draftKey).revision === source.revision
        )
          useStore.getState().openWorkflow(prepared.roomId, mode, "new");
        return;
      }
      const response = await api<WorkflowResponse>(
        "POST",
        roomPath(roomId, "/workflow/start"),
        {
          mode,
          task: task.trim(),
          criteria: criterionLines,
          participantIds: participants.map((a) => a.id),
          roles: Object.fromEntries(
            participants.map((a, i) => [a.id, roleOf(a, i)]),
          ),
          budget: {
            timeoutMs: seconds * 1000,
            maxOutputChars: chars,
            maxRounds: rounds,
          },
          contextPaths,
          messageIds: draft.messageIds ?? [],
          resultIds: draft.resultIds ?? [],
        },
      );
      void useStore.getState().loadRooms();
      if (creationDrafts.workflow(draftKey, mode, roomId) === originalDraft)
        updateDraft({
          task: "",
          criteria: "",
          contextPaths: [],
          messageIds: [],
          resultIds: [],
          origin: undefined,
        });
      if (originalDraft.origin) {
        const { key, revision, roomId: originRoom } = originalDraft.origin;
        creationDrafts.finish(key, revision, originRoom);
      }
      if (mounted.current && useStore.getState().route === route) {
        useWorkflow.getState().receive(roomId, response, generation);
        onStarted?.();
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const addRole = (role: WorkflowRole) => {
    if (roomId) {
      useStore.getState().openDialog({ kind: "agents" });
      return;
    }
    const available = roster.find((agent) => !selected.includes(agent.id));
    const kind = participants.length % 2 ? "codex" : "claude";
    const label = nameFor(kind, undefined, models, roster);
    const agent = available ?? { id: handleFor(label), kind, label };
    if (!available) setAvailableRoster([...roster, agent]);
    creationDrafts.setSeats(draftKey, [...participants, agent]);
    setRoles({ ...roles, [agent.id]: role });
  };
  const seat = (agent: RoomAgent) => {
    const checked = selected.includes(agent.id);
    const index = participants.findIndex((a) => a.id === agent.id);
    return (
      <div className="agent-seat rounded-xl border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "seat-avatar",
              agent.kind === "codex"
                ? "bg-codex-soft text-codex"
                : "bg-claude-soft text-claude",
            )}
          >
            {agent.kind === "codex" ? "C" : "A"}
          </span>
          <span className="min-w-0 flex-1 truncate text-small font-medium">
            {agent.label}
          </span>
          <button
            type="button"
            className="seat-remove"
            aria-label={
              checked
                ? `Remove ${agent.label} from session`
                : `Include ${agent.label}`
            }
            disabled={!checked && participants.length >= 8}
            onClick={() =>
              setSelected(
                checked
                  ? selected.filter((id) => id !== agent.id)
                  : [...selected, agent.id],
              )
            }
          >
            {checked ? <XIcon size={12} /> : <PlusIcon size={14} />}
          </button>
        </div>
        {checked ? (
          <div className="seat-config">
            <select
              aria-label={`Role for ${agent.label}`}
              value={roleOf(agent, index)}
              onChange={(e) =>
                setRoles({
                  ...roles,
                  [agent.id]: e.target.value as WorkflowRole,
                })
              }
            >
              {ROLES[mode].map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
            {roomId ? (
              <span className="text-[10px] text-faint">
                {agent.model ?? `${agent.kind} default`}
              </span>
            ) : (
              <ModelMenu
                agent={agent}
                seating={{ agents: roster }}
                models={models}
                side="bottom"
                className="h-6 max-w-full text-[10px] text-faint"
                onSet={(pick) =>
                  setRoster(
                    roster.map((a) =>
                      a.id === agent.id
                        ? {
                            ...a,
                            ...("model" in pick
                              ? { model: pick.model ?? undefined }
                              : {}),
                            ...("effort" in pick
                              ? { effort: pick.effort ?? undefined }
                              : {}),
                          }
                        : a,
                    ),
                  )
                }
              />
            )}
          </div>
        ) : null}
      </div>
    );
  };
  const criterionRows = criteria.split("\n");
  const updateCriterion = (index: number, value: string) =>
    updateDraft({
      criteria: criterionRows
        .map((line, i) => (i === index ? value : line))
        .join("\n"),
    });
  const titles = {
    verification: "Put the work to the test.",
    council: "Bring a question to the table.",
    tournament: "Explore the possibilities.",
    debate: "Put a decision in the balance.",
  };
  const hints = {
    verification: "Create, challenge, repair. Every claim earns its evidence.",
    council: "Independent answers. Shared judgment. Disagreements included.",
    tournament: "Parallel prototypes. Independent comparison. Your call.",
    debate: "Two positions. A fair hearing. A reasoned verdict.",
  };
  const disabled =
    busy ||
    !task.trim() ||
    !criteria.trim() ||
    Boolean(rosterError || providerError || roleError || criteriaError) ||
    participants.length < spec.min ||
    workflowActive ||
    Boolean(roomId && (!isolation?.available || workflowLoading)) ||
    Boolean(!roomId && projectError);
  return (
    <div className={`workflow-setup studio-setup studio-${mode}`}>
      <header className="studio-heading">
        <span className="studio-kicker">
          {roomId ? "Ready to launch" : "New session"} / {spec.title}
        </span>
        <h1>{titles[mode]}</h1>
        <p>{hints[mode]}</p>
      </header>
      <form onSubmit={(event) => void submit(event)} className="studio-form">
        <section className="mission-paper">
          <label htmlFor={`mission-${mode}`} className="studio-kicker">
            {mode === "debate"
              ? "The motion"
              : mode === "council"
                ? "The question"
                : "The brief"}
          </label>
          <textarea
            id={`mission-${mode}`}
            required
            rows={3}
            maxLength={20000}
            value={task}
            onChange={(e) => changeTask(e.target.value)}
            placeholder={
              mode === "debate"
                ? "What proposition should the agents argue for and against?"
                : mode === "council"
                  ? "What deserves more than one perspective?"
                  : mode === "tournament"
                    ? "What should the competing prototypes explore?"
                    : "What should the author create and the reviewers verify?"
            }
          />
          {controls}
          <div className="mission-foot">
            <LockKeyholeIcon size={12} />
            <span>
              One shared brief. Private work stays sealed until the round is
              complete.
            </span>
          </div>
        </section>
        <AgentStage
          mode={mode}
          seats={participants.map((agent, index) => ({
            id: agent.id,
            role: roleOf(agent, index),
            node: seat(agent),
          }))}
          onAdd={participants.length < 8 ? addRole : undefined}
        />
        <div className="studio-roster-tools">
          <span>{participants.length} agents at work</span>
          {!roomId ? (
            <>
              <button
                type="button"
                disabled={roster.length >= 8}
                onClick={() => addSeat("codex")}
              >
                <PlusIcon size={12} />
                Codex
              </button>
              <button
                type="button"
                disabled={roster.length >= 8}
                onClick={() => addSeat("claude")}
              >
                <PlusIcon size={12} />
                Claude
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => useStore.getState().openDialog({ kind: "agents" })}
            >
              Manage agents
            </button>
          )}
          {roster.some((a) => !selected.includes(a.id)) ? (
            <details>
              <summary>Available agents</summary>
              <div className="available-seats">
                {roster
                  .filter((a) => !selected.includes(a.id))
                  .map((agent) => (
                    <div key={agent.id}>{seat(agent)}</div>
                  ))}
              </div>
            </details>
          ) : null}
        </div>
        {roleError || participants.length < spec.min ? (
          <p className="studio-validation" role="status">
            {roleError ??
              `Add ${spec.min - participants.length} more ${spec.min - participants.length === 1 ? "agent" : "agents"} to complete the team.`}
          </p>
        ) : null}
        <section className="studio-criteria">
          <header>
            <h2>
              {mode === "tournament"
                ? "How should we compare?"
                : mode === "debate"
                  ? "What would settle this?"
                  : "What does success look like?"}
            </h2>
            <span>Shared criteria</span>
          </header>
          {criterionRows.map((value, index) => (
            <div key={index} className="criterion-input">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <input
                aria-label={`Criterion ${index + 1}`}
                value={value}
                maxLength={1000}
                placeholder={
                  index === 0
                    ? "Describe an observable result…"
                    : "Add another criterion…"
                }
                onChange={(e) => updateCriterion(index, e.target.value)}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  if (!pasted.includes("\n")) return;
                  event.preventDefault();
                  const lines = pasted
                    .split(/\r?\n/)
                    .filter((line) => line.trim());
                  updateDraft({
                    criteria: [
                      ...criterionRows.slice(0, index),
                      ...lines,
                      ...criterionRows.slice(index + 1),
                    ].join("\n"),
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (criterionRows.length >= 20) return;
                  updateDraft({
                    criteria: [
                      ...criterionRows.slice(0, index + 1),
                      "",
                      ...criterionRows.slice(index + 1),
                    ].join("\n"),
                  });
                  requestAnimationFrame(() =>
                    document
                      .querySelectorAll<HTMLInputElement>(
                        ".criterion-input input",
                      )
                      [index + 1]?.focus(),
                  );
                }}
              />
              {criterionRows.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove criterion ${index + 1}`}
                  onClick={() =>
                    updateDraft({
                      criteria: criterionRows
                        .filter((_, i) => i !== index)
                        .join("\n"),
                    })
                  }
                >
                  <XIcon size={13} />
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            className="criteria-add"
            disabled={criterionRows.length >= 20}
            onClick={() => updateDraft({ criteria: criteria + "\n" })}
          >
            <PlusIcon size={13} />
            Add criterion
          </button>
          {criteriaError ? (
            <p className="text-small text-destructive" role="alert">
              {criteriaError}
            </p>
          ) : null}
        </section>
        {room ? <ConversationMaterials room={room} messages={draft.messageIds ?? []} results={draft.resultIds ?? []} onChange={updateDraft} /> : null}
        {roomId ? (
          <Materials
            roomId={roomId}
            selected={contextPaths}
            onSelect={setContextPaths}
          />
        ) : null}
        <footer className="studio-launch">
          <div className="studio-launch-settings">
            <details className="budget-settings">
              <summary>
                {seconds / 60} min per turn <span>·</span> {chars / 1000}k
                characters <ChevronDownIcon size={13} />
              </summary>
              <div className="budget-controls">
                <label>
                  Time per turn
                  <select
                    aria-label="Time per turn"
                    value={seconds}
                    onChange={(e) => setSeconds(Number(e.target.value))}
                  >
                    {[60, 180, 300, 600, 1200].map((n) => (
                      <option key={n} value={n}>
                        {n / 60} min
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Output limit
                  <select
                    aria-label="Output characters per turn"
                    value={chars}
                    onChange={(e) => setChars(Number(e.target.value))}
                  >
                    {[4000, 8000, 16000, 32000].map((n) => (
                      <option key={n} value={n}>
                        {n / 1000}k characters
                      </option>
                    ))}
                  </select>
                </label>
                {mode === "verification" || mode === "debate" ? (
                  <label>
                    Repair attempts
                    <select
                      aria-label="Maximum repair attempts"
                      value={rounds}
                      onChange={(e) => setRounds(Number(e.target.value))}
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <p>
                  Equal time and output limits. Model token usage can differ.
                </p>
              </div>
            </details>
            <p>
              {roomId
                ? isolation?.available
                  ? "Private execution ready"
                  : (isolation?.reason ?? "Checking private execution…")
                : "Prepare the workspace, then review materials and launch."}
            </p>
          </div>
          {onBack ? (
            <Button variant="ghost" type="button" onClick={onBack}>
              Back
            </Button>
          ) : null}
          <Button
            type="submit"
            disabled={disabled}
            className="studio-launch-button"
          >
            {busy
              ? "Preparing…"
              : roomId
                ? `Launch ${mode}`
                : "Prepare session"}
            <ArrowRightIcon size={16} />
          </Button>
        </footer>
        {error || rosterError || providerError ? (
          <p
            role="alert"
            className="rounded-xl bg-destructive-soft p-3 text-small text-destructive"
          >
            {error ?? rosterError ?? providerError}
          </p>
        ) : null}
      </form>
    </div>
  );
}
