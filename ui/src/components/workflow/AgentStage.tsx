import type { ReactNode } from "react";
import {
  ArrowRightIcon,
  CheckCheckIcon,
  LockKeyholeIcon,
  PlusIcon,
  ScaleIcon,
  SwordsIcon,
  TrophyIcon,
} from "lucide-react";
import type { WorkflowRole } from "@agora/workflow-types";
import type { ProtocolMode } from "@/lib/workflow";

export interface StageSeat {
  id: string;
  role: WorkflowRole;
  node: ReactNode;
}
/** Roles are spatial, editable objects. These are the actual session seats, never mock participants. */
export function AgentStage({
  mode,
  seats,
  onAdd,
  phase,
}: {
  mode: ProtocolMode;
  seats: StageSeat[];
  phase?: string;
  onAdd?: (role: WorkflowRole) => void;
}) {
  const add = (role: WorkflowRole, label: string) => (
    <button
      type="button"
      className="stage-empty-seat"
      onClick={() => onAdd?.(role)}
      disabled={!onAdd}
    >
      <PlusIcon size={18} />
      <span>{label}</span>
    </button>
  );
  const lane = (
    role: WorkflowRole,
    title: string,
    description: string,
    min = 1,
  ) => (
    <section className={`stage-lane role-${role}`}>
      <header>
        <span>{title}</span>
        <small>{description}</small>
      </header>
      <div className="stage-seats">
        {seats
          .filter((s) => s.role === role)
          .map((s) => (
            <div key={s.id}>{s.node}</div>
          ))}
        {seats.filter((s) => s.role === role).length < min ? (
          onAdd ? (
            add(role, `Add ${role === "contender" ? "maker" : role}`)
          ) : (
            <p className="stage-idle">Not acting in this phase</p>
          )
        ) : null}
      </div>
    </section>
  );
  if (mode === "council")
    return (
      <div className="agent-stage council-stage" aria-label="Council table">
        <div className="council-orbit" aria-hidden />
        <div className="council-center">
          <span className="stage-center-icon">
            <LockKeyholeIcon size={20} />
          </span>
          <strong>Think independently.</strong>
          <span>Reveal together.</span>
          <small>{seats.length} voices · anonymous peer review</small>
        </div>
        <div className="council-seats">
          {seats.map((s, i) => (
            <div
              className="council-seat"
              style={{ "--seat": i } as React.CSSProperties}
              key={s.id}
            >
              {s.node}
            </div>
          ))}
          {onAdd && seats.length < 8 ? (
            <div className="council-seat">
              {add("member", "Invite another perspective")}
            </div>
          ) : null}
        </div>
        <div className="stage-caption">
          Independent answers <ArrowRightIcon size={12} /> Peer review{" "}
          <ArrowRightIcon size={12} /> Synthesis <ArrowRightIcon size={12} />{" "}
          Dissent check
        </div>
      </div>
    );
  if (mode === "debate")
    return (
      <div className="agent-stage debate-stage" aria-label="Debate chamber">
        <div className="debate-sides">
          {lane("pro", "For the motion", "Build the strongest case")}
          <div className="stage-axis">
            <SwordsIcon size={23} />
            <span>↔</span>
            <small>
              Understand
              <br />
              before rebutting
            </small>
          </div>
          {lane("con", "Against the motion", "Find what does not hold")}
        </div>
        <div className="debate-judge">
          <ScaleIcon size={21} />
          {lane(
            "judge",
            "Independent bench",
            "A verdict, or a test that resolves the difference",
          )}
        </div>
        <div className="stage-caption">
          Positions <ArrowRightIcon size={12} /> Accepted restatements{" "}
          <ArrowRightIcon size={12} /> New arguments{" "}
          <ArrowRightIcon size={12} /> Verdict
        </div>
      </div>
    );
  if (mode === "tournament")
    return (
      <div
        className={`agent-stage tournament-stage ${phase === "implementation" ? "is-implementation" : ""}`}
        aria-label="Tournament arena"
      >
        <div className="arena-banner">
          <TrophyIcon size={18} />
          <strong>
            {phase === "implementation"
              ? "Build the chosen direction."
              : "One brief. Equal budgets."}
          </strong>
          <span>You choose what gets built.</span>
        </div>
        {lane(
          "contender",
          phase === "implementation" ? "Implementation" : "Prototype lanes",
          phase === "implementation"
            ? "Your selection becomes the full artifact"
            : "Each maker starts privately",
          phase === "implementation" ? 1 : 2,
        )}
        <div className="tournament-bench">
          {lane(
            "evaluator",
            "Independent comparison",
            "Judges do not build prototypes",
          )}
        </div>
        <div className="stage-caption">
          Private prototypes <ArrowRightIcon size={12} /> Comparison{" "}
          <ArrowRightIcon size={12} /> Your selection{" "}
          <ArrowRightIcon size={12} /> Full implementation
        </div>
      </div>
    );
  return (
    <div
      className="agent-stage verification-stage"
      aria-label="Verification workbench"
    >
      <div className="verification-flow">
        {lane("author", "Build", "One owner of the artifact")}
        <div className="stage-axis">
          <ArrowRightIcon size={24} />
          <small>
            Artifact
            <br />⇄<br />
            Findings
          </small>
        </div>
        {lane("reviewer", "Verify", "Independent eyes on the original brief")}
      </div>
      <div className="verification-return">
        <CheckCheckIcon size={16} />
        <span>Repair → recheck</span>
        <i />
        <span>Evidence for every criterion</span>
      </div>
    </div>
  );
}
